/**
 * Company desk: name/ticker -> entity -> dossier.
 *
 * The source adapters answer "what is new in the market"; this module answers
 * "what do we know about this one company" by combining:
 *
 *   - entity resolution  (Eastmoney suggest: A / HK / US, no key)
 *   - quote              (Tencent qt, the same feed quotes.mjs already uses)
 *   - financials         (THS indicator table, 25 periods, A-share only)
 *   - filings            (cninfo per-issuer, plus SSE/SZSE/SEC when the market fits)
 *   - sell-side reports  (Eastmoney report list, filtered by code)
 *
 * Everything is anonymous public data; nothing logs in.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const JSON_HEADERS = { 'user-agent': UA, accept: 'application/json, text/javascript, */*' }

const SUGGEST_URL = 'https://searchapi.eastmoney.com/api/suggest/get'
const SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'
const CNINFO_LIST_URL = 'http://www.cninfo.com.cn/new/data/szse_stock.json'
const THS_FINANCE_URL = 'https://basic.10jqka.com.cn/api/stock/finance/'
const TENCENT_URL = 'http://qt.gtimg.cn/q='

const ORGID_TTL_MS = 12 * 60 * 60 * 1000
const FINANCE_TTL_MS = 6 * 60 * 60 * 1000
const QUOTE_TTL_MS = 15 * 1000

/** MktNum -> our market tag. 0=深, 1=沪, 116=港, 105/106/107=美. */
const MARKET_BY_MKTNUM = { '0': 'SZ', '1': 'SH', '116': 'HK', '105': 'US', '106': 'US', '107': 'US' }

const MARKET_LABEL = { SH: '沪A', SZ: '深A', HK: '港股', US: '美股', BJ: '北交所' }

function pick(params, key) {
  return params && params[key] !== undefined ? params[key] : undefined
}

function numOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) && n !== 0 ? n : null
}

/** Tencent quote field map (indices are stable across the qt feed). */
function parseTencent(text, entity) {
  const body = /="([\s\S]*)";?/.exec(String(text || ''))
  if (!body) return null
  const f = body[1].split('~')
  if (f.length < 40) return null
  const price = numOrNull(f[3])
  if (price === null) return null
  return {
    code: f[2] || entity.code,
    name: f[1] || entity.name,
    price: price,
    prevClose: numOrNull(f[4]),
    open: numOrNull(f[5]),
    change: numOrNull(f[31]),
    changePct: numOrNull(f[32]),
    high: numOrNull(f[33]),
    low: numOrNull(f[34]),
    amountWan: numOrNull(f[37]),
    turnoverPct: numOrNull(f[38]),
    pe: numOrNull(f[39]),
    amplitude: numOrNull(f[43]),
    floatCapYi: numOrNull(f[44]),
    totalCapYi: numOrNull(f[45]),
    pb: numOrNull(f[46]),
    time: f[30] ? String(f[30]) : '',
    market: entity.market,
  }
}

function tencentCode(entity) {
  if (entity.market === 'SH') return 'sh' + entity.code
  if (entity.market === 'SZ') return 'sz' + entity.code
  if (entity.market === 'HK') return 'hk' + entity.code
  if (entity.market === 'US') return 'us' + entity.code
  return ''
}

function cnTime(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(raw || ''))
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0) - 8, Number(m[5] || 0), Number(m[6] || 0))
}

/**
 * The THS indicator payload is a column store: `title[i]` names the row and
 * `report[i]` holds its values, `report[0]` being the period dates.
 */
function parseFinance(json) {
  const fd = typeof json.flashData === 'string' ? JSON.parse(json.flashData) : json.flashData
  if (!fd || !Array.isArray(fd.report) || !Array.isArray(fd.title)) return null
  const periods = Array.isArray(fd.report[0]) ? fd.report[0].slice(0, 8) : []
  const rows = []
  for (let i = 1; i < fd.title.length && i < fd.report.length; i += 1) {
    const def = fd.title[i]
    const name = Array.isArray(def) ? String(def[0] || '') : String(def || '')
    const unit = Array.isArray(def) ? String(def[1] || '') : ''
    const values = Array.isArray(fd.report[i]) ? fd.report[i] : []
    if (!name) continue
    rows.push({
      name: name,
      unit: unit,
      latest: values[0] === undefined || values[0] === '' ? null : String(values[0]),
      prev: values[1] === undefined || values[1] === '' ? null : String(values[1]),
      series: periods.map((period, index) => ({
        period: period,
        value: values[index] === undefined || values[index] === '' ? null : String(values[index]),
      })),
    })
    if (rows.length >= 30) break
  }
  return { periods: periods, rows: rows }
}

export function createCompanyDesk(options) {
  const opts = options || {}
  const sourceLayer = opts.sourceLayer
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  /** code -> orgId for cninfo, fetched once and kept for 12h. */
  let orgIds = null
  let orgIdsAt = 0
  /** code|market -> cached finance payload. */
  const financeCache = new Map()
  /** tencentCode -> { at, quote }. */
  const quoteCache = new Map()

  async function loadOrgIds(deps) {
    if (orgIds && Date.now() - orgIdsAt < ORGID_TTL_MS) return orgIds
    const res = await deps.getJson(CNINFO_LIST_URL, { timeoutMs: 25000, headers: { referer: 'http://www.cninfo.com.cn/' } })
    if (!res.ok || !res.json || !Array.isArray(res.json.stockList)) {
      log('cninfo orgId list unavailable: ' + (res.status || res.error || 'bad payload'))
      return orgIds || new Map()
    }
    const map = new Map()
    for (const row of res.json.stockList) {
      if (row && row.code) map.set(String(row.code), String(row.orgId || ''))
    }
    orgIds = map
    orgIdsAt = Date.now()
    return map
  }

  /** Normalise an Eastmoney suggest row. Indices / sectors / bonds are not companies. */
  function normalise(row) {
    const market = MARKET_BY_MKTNUM[String(row.MktNum || '')] || ''
    if (!market) return null
    // A-shares report "沪A"/"深A" (no 股 character), HK "港股", US "美股", so this is
    // a blacklist of non-equity instrument types rather than a whitelist.
    const type = String(row.SecurityTypeName || '')
    if (/指数|板块|基金|债|权证|期货|期权|回购|拆借|外汇|商品/.test(type)) return null
    const code = String(row.Code || '')
    if (!code) return null
    return {
      code: code,
      name: String(row.Name || ''),
      market: market,
      marketLabel: MARKET_LABEL[market] || market,
      securityType: String(row.SecurityTypeName || ''),
      quoteId: String(row.QuoteID || ''),
    }
  }

  /** Resolve a free-text query (name, pinyin or code) to ranked candidates. */
  async function resolve(query, deps) {
    const q = String(query || '').trim()
    if (!q) return []
    const url =
      SUGGEST_URL + '?input=' + encodeURIComponent(q) + '&type=14&token=' + SUGGEST_TOKEN + '&count=12'
    const res = await deps.getJson(url, { timeoutMs: 10000, headers: JSON_HEADERS, referer: 'https://www.eastmoney.com/' })
    if (!res.ok || !res.json) return []
    const table = res.json.QuotationCodeTable
    const rows = table && Array.isArray(table.Data) ? table.Data : []
    const out = []
    const seen = new Set()
    for (const row of rows) {
      const entity = normalise(row)
      if (!entity) continue
      const key = entity.market + ':' + entity.code
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entity)
    }
    // Rank by match class first, then by how much extra text the name carries
    // ("腾讯" -> 腾讯控股 beats 腾讯控股-R), then by the provider's own order.
    const lower = q.toLowerCase()
    const rank = (e) => {
      const name = e.name.toLowerCase()
      let cls = -1
      if (e.code.toLowerCase() === lower) cls = 3
      else if (name === lower) cls = 2
      else if (name.startsWith(lower)) cls = 1
      else if (name.includes(lower)) cls = 0
      const aShare = e.market === 'SH' || e.market === 'SZ' ? 10 : 0
      const extra = Math.min(Math.max(name.length - lower.length, 0), 9)
      return cls * 1000 + aShare - extra
    }
    out.sort((a, b) => rank(b) - rank(a))
    return out
  }

  async function quoteFor(entity, deps, refresh) {
    const tencent = tencentCode(entity)
    if (!tencent) return null
    const hit = quoteCache.get(tencent)
    if (!refresh && hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.quote
    try {
      const res = await deps.request(TENCENT_URL + tencent, {
        timeoutMs: 6000,
        headers: { referer: 'https://finance.qq.com/' },
      })
      const quote = res.ok ? parseTencent(res.text, entity) : null
      if (quote) quoteCache.set(tencent, { at: Date.now(), quote: quote })
      return quote
    } catch (error) {
      return null
    }
  }

  async function financeFor(entity, deps) {
    if (entity.market !== 'SH' && entity.market !== 'SZ') return null
    const key = entity.code
    const hit = financeCache.get(key)
    if (hit && Date.now() - hit.at < FINANCE_TTL_MS) return hit.data
    try {
      const res = await deps.getJson(THS_FINANCE_URL + entity.code + '_main.json', {
        timeoutMs: 15000,
        headers: JSON_HEADERS,
        referer: 'https://basic.10jqka.com.cn/' + entity.code + '/',
      })
      if (!res.ok || !res.json) return null
      const parsed = parseFinance(res.json)
      if (parsed) financeCache.set(key, { at: Date.now(), data: parsed })
      return parsed
    } catch (error) {
      return null
    }
  }

  /**
   * The same filing arrives from cninfo and from the exchange's own feed, and the
   * exchange often prefixes the issuer name ("宁德时代：关于…"). Strip the entity name
   * and punctuation before comparing, then keep the first leg (cninfo is widest).
   */
  function dedupeByTitle(items, entityName) {
    const name = String(entityName || '')
    const normalise = (title) => {
      let text = String(title || '').trim()
      if (name && text.startsWith(name)) text = text.slice(name.length)
      return text.replace(/^[：:\s]+/, '').replace(/\s+/g, '').replace(/[：:，,。.、；;·—–\-()（）]/g, '')
    }
    const seen = new Set()
    const out = []
    for (const item of items) {
      const key = normalise(item.title)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
    return out
  }
  // ---------------------------------------------------------------- peers

  const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'
  const QUOTE_REF = { referer: 'https://quote.eastmoney.com/' }

  /** Eastmoney secid: Shanghai 1.code, Shenzhen/Beijing 0.code. */
  function secidOf(entity) {
    return (/^(6|9)/.test(String(entity.code || '')) ? '1.' : '0.') + entity.code
  }

  let industryBoards = null
  let industryBoardsAt = 0

  /**
   * Industry board name -> board code, refreshed hourly.
   *
   * The list endpoint caps page size at 100 while there are ~500 boards, so this
   * pages until it has them all — a name that only appears on page 3 (白酒Ⅱ) would
   * otherwise never resolve and the peer block would come back empty.
   */
  async function loadIndustryBoards(deps) {
    if (industryBoards && Date.now() - industryBoardsAt < 60 * 60 * 1000) return industryBoards
    const map = new Map()
    // Six pages of 100 cover the ~500 boards; fetching them concurrently keeps the
    // first company query from paying six round trips back to back.
    const pages = [1, 2, 3, 4, 5, 6]
    const results = await Promise.all(
      pages.map((page) =>
        deps.getJson(CLIST + '?pn=' + page + '&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14', {
          timeoutMs: 9000,
          headers: JSON_HEADERS,
          ...QUOTE_REF,
        }),
      ),
    )
    for (const res of results) {
      const rows = res && res.ok && res.json && res.json.data && res.json.data.diff
      if (!Array.isArray(rows)) continue
      for (const row of rows) if (row && row.f14) map.set(String(row.f14), String(row.f12))
    }
    if (map.size === 0) {
      log('industry board list unavailable')
      return industryBoards || new Map()
    }
    industryBoards = map
    industryBoardsAt = Date.now()
    return map
  }

  /**
   * Same-industry comparables: resolve the issuer's industry label, map it to the
   * board code, then list the board's largest members by market cap.
   */
  async function peersFor(entity, deps, limit) {
    if (entity.market !== 'SH' && entity.market !== 'SZ') return null
    try {
      const info = await deps.getJson(
        'https://push2.eastmoney.com/api/qt/stock/get?secid=' + secidOf(entity) + '&fields=f57,f58,f127,f128',
        { timeoutMs: 8000, headers: JSON_HEADERS, ...QUOTE_REF },
      )
      const industry = info.ok && info.json && info.json.data ? String(info.json.data.f127 || '') : ''
      if (!industry) return null
      const boards = await loadIndustryBoards(deps)
      const boardCode = boards.get(industry)
      if (!boardCode) return { industry: industry, boardCode: '', rows: [] }
      const size = Math.min(Math.max(Number(limit) || 8, 3), 20) + 1
      const list = await deps.getJson(
        CLIST + '?pn=1&pz=' + size + '&po=1&np=1&fltt=2&invt=2&fid=f20&fs=b:' + boardCode + '&fields=f12,f14,f2,f3,f20',
        { timeoutMs: 9000, headers: JSON_HEADERS, ...QUOTE_REF },
      )
      const rows = list.ok && list.json && list.json.data && list.json.data.diff
      if (!Array.isArray(rows)) return { industry: industry, boardCode: boardCode, rows: [] }
      const peers = []
      for (const row of rows) {
        const code = String(row.f12 || '')
        // B shares (200xxx / 900xxx) are the same issuer under a different listing;
        // they would otherwise show up as a duplicate peer.
        if (!code || code === entity.code || /^(200|900)/.test(code)) continue
        peers.push({
          code: code,
          name: String(row.f14 || '').replace(/\s+/g, ''),
          price: numOrNull(row.f2),
          changePct: numOrNull(row.f3),
          marketCap: numOrNull(row.f20),
        })
        if (peers.length >= Math.max(Number(limit) || 8, 3)) break
      }
      return { industry: industry, boardCode: boardCode, rows: peers }
    } catch (error) {
      return null
    }
  }

  /** One adapter call, tolerant of failure: always resolves to {source, items, note}. */
  async function pull(adapterId, params, sourceLabel) {
    try {
      const result = await sourceLayer.fetchOne(adapterId, params, {})
      return {
        source: sourceLabel || adapterId,
        id: adapterId,
        items: result.items || [],
        note: result.note || result.error || '',
      }
    } catch (error) {
      return { source: sourceLabel || adapterId, id: adapterId, items: [], note: String((error && error.message) || error) }
    }
  }

  // ---------------------------------------------------------------- US filings

  /** ticker -> { cik, title }; SEC's own mapping file, cached for a day. */
  let secTickers = null
  let secTickersAt = 0
  // SEC's fair-access policy wants a contact in the UA and rejects a bare URL there;
  // override with SEC_USER_AGENT if you want your own address in the logs.
  const SEC_UA = process.env.SEC_USER_AGENT || 'dsh-market-info/0.9 admin@example.com'

  async function loadSecTickers(deps) {
    if (secTickers && Date.now() - secTickersAt < 24 * 60 * 60 * 1000) return secTickers
    const res = await deps.getJson('https://www.sec.gov/files/company_tickers.json', {
      timeoutMs: 20000,
      headers: { 'user-agent': SEC_UA, accept: 'application/json' },
    })
    if (!res.ok || !res.json) {
      log('SEC ticker map unavailable: ' + (res.status || res.error))
      return secTickers || new Map()
    }
    const map = new Map()
    for (const row of Object.values(res.json)) {
      if (row && row.ticker) map.set(String(row.ticker).toUpperCase(), { cik: Number(row.cik_str), title: String(row.title || '') })
    }
    secTickers = map
    secTickersAt = Date.now()
    return map
  }

  /** Recent EDGAR filings for a US ticker, straight from the submissions API. */
  async function secFilingsFor(entity, deps, limit) {
    try {
      const map = await loadSecTickers(deps)
      const hit = map.get(String(entity.code || '').toUpperCase())
      if (!hit) return { source: 'SEC EDGAR', id: 'sec-submissions', items: [], note: 'ticker not in SEC map' }
      const cik = String(hit.cik).padStart(10, '0')
      const res = await deps.getJson('https://data.sec.gov/submissions/CIK' + cik + '.json', {
        timeoutMs: 15000,
        headers: { 'user-agent': SEC_UA, accept: 'application/json' },
      })
      if (!res.ok || !res.json) return { source: 'SEC EDGAR', id: 'sec-submissions', items: [], note: 'http ' + (res.status || res.error) }
      const recent = res.json.filings && res.json.filings.recent
      if (!recent || !Array.isArray(recent.form)) return { source: 'SEC EDGAR', id: 'sec-submissions', items: [], note: 'no recent filings' }
      const items = []
      for (let i = 0; i < recent.form.length && items.length < limit; i += 1) {
        const accession = String(recent.accessionNumber[i] || '').replace(/-/g, '')
        const document = String(recent.primaryDocument[i] || '')
        const url = accession && document
          ? 'https://www.sec.gov/Archives/edgar/data/' + hit.cik + '/' + accession + '/' + document
          : 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' + cik
        items.push({
          id: 'sec:' + accession + ':' + document,
          title: (hit.title || entity.name) + ' · ' + String(recent.form[i] || ''),
          url: url,
          publishedAt: cnTime(recent.filingDate[i]),
          summary: '报告期 ' + String(recent.reportDate[i] || '-') + ' · ' + String(recent.form[i] || ''),
          tags: ['SEC', String(recent.form[i] || '')],
        })
      }
      return { source: 'SEC EDGAR', id: 'sec-submissions', items: items, note: '' }
    } catch (error) {
      return { source: 'SEC EDGAR', id: 'sec-submissions', items: [], note: String((error && error.message) || error) }
    }
  }

  /**
   * Assemble the dossier. Individual legs fail independently; the payload always
   * reports which legs came back empty and why.
   */
  async function dossier(query, rawOptions) {
    const o = rawOptions || {}
    const started = Date.now()
    const deps = o.deps || {}
    if (!sourceLayer) return { ok: false, error: 'source layer unavailable' }

    const candidates = await resolve(query, deps)
    if (!candidates.length) return { ok: false, error: 'no company matched: ' + String(query || ''), candidates: [] }
    const requested = String(query || '').trim()
    const exact = candidates.find((c) => c.code.toLowerCase() === requested.toLowerCase())
    const entity = exact || candidates[0]

    const isA = entity.market === 'SH' || entity.market === 'SZ'
    let orgId = ''
    if (isA) {
      try {
        const map = await loadOrgIds(deps)
        orgId = map.get(entity.code) || ''
      } catch (error) {
        orgId = ''
      }
    }
    const from = o.from || ''
    const to = o.to || ''
    const filingLimit = Math.min(Math.max(Number(o.limit) || 20, 5), 40)

    const legs = []
    if (isA) legs.push(pull('cninfo', { symbol: entity.code, orgId: orgId, from: from, to: to }, '巨潮资讯'))
    if (entity.market === 'SH') legs.push(pull('sse', { symbol: entity.code, q: entity.name, from: from, to: to }, '上交所'))
    if (entity.market === 'SZ') legs.push(pull('szse', { symbol: entity.code, from: from, to: to }, '深交所'))
    // Sell-side coverage on this endpoint is A-share only; a blank code would return
    // the whole market, which is worse than no leg at all.
    if (isA) legs.push(pull('em-report', { symbol: entity.code, from: from, to: to }, '东方财富研报'))
    // Corporate actions for this exact company: the reports accept a security-code filter.
    const corporateIds = isA
      ? [['dividend', '分红送配'], ['lift', '限售解禁'], ['blocktrade', '大宗交易'], ['holder-change', '股东增减持'], ['forecast', '业绩预告']]
      : []

    const corporateLegs = corporateIds.map((pair) => pull(pair[0], { code: entity.code }, pair[1]))
    // Headlines that mention this company, from the news plane's own cache.
    const newsLeg = typeof deps.newsFor === 'function'
      ? Promise.resolve()
          .then(() => deps.newsFor(entity.name))
          .then((items) => ({
            source: '新闻聚合',
            id: 'company-news',
            items: Array.isArray(items) ? items : [],
            note: Array.isArray(items) && items.length ? '' : '资讯流缓存为空：打开「资讯流」后会自动带上，或按公司名搜索',
          }))
          .catch((error) => ({ source: '新闻聚合', id: 'company-news', items: [], note: String((error && error.message) || error) }))
      : Promise.resolve(null)

    const [legResults, quote, finance, secLeg, peers, corpResults, newsResult] = await Promise.all([
      Promise.all(legs),
      quoteFor(entity, deps, o.refresh === true),
      financeFor(entity, deps),
      entity.market === 'US' ? secFilingsFor(entity, deps, filingLimit) : Promise.resolve(null),
      peersFor(entity, deps, 8),
      Promise.all(corporateLegs),
      newsLeg,
    ])
    if (secLeg) legResults.push(secLeg)
    if (newsResult) legResults.push(newsResult)
    if (entity.market === 'HK') {
      legResults.push({ source: '香港披露易', id: 'hkex-company', items: [], note: '按股票代码筛选暂未接入，可在「官方」页按全部港股公告浏览' })
    }

    const filings = []
    const reports = []
    const news = []
    const legStatus = []
    for (const leg of legResults) {
      legStatus.push({ id: leg.id, source: leg.source, count: leg.items.length, note: leg.note })
      for (const item of leg.items) {
        if (leg.id === 'em-report') reports.push(item)
        else if (leg.id === 'company-news') news.push(item)
        else filings.push(item)
      }
    }
    filings.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    reports.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    const uniqueFilings = dedupeByTitle(filings, entity.name)
    const uniqueReports = dedupeByTitle(reports, entity.name)

    // Corporate actions keep their source label so the UI can group them.
    const corporate = []
    for (const leg of corpResults || []) {
      legStatus.push({ id: leg.id, source: leg.source, count: leg.items.length, note: leg.note })
      for (const item of leg.items) corporate.push(Object.assign({}, item, { actionSource: leg.source }))
    }
    corporate.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    // Round-robin by action type: sorted purely by date, one source (usually
    // dividends) would fill the whole list and hide the other four.
    const byAction = new Map()
    for (const item of corporate) {
      const key = item.actionSource || '其他'
      if (!byAction.has(key)) byAction.set(key, [])
      byAction.get(key).push(item)
    }
    const interleaved = []
    let more = true
    while (more) {
      more = false
      for (const queue of byAction.values()) {
        const next = queue.shift()
        if (next) {
          interleaved.push(next)
          more = true
        }
      }
    }

    return {
      ok: true,
      query: requested,
      entity: entity,
      candidates: candidates.slice(0, 8),
      quote: quote,
      finance: finance,
      peers: peers,
      filings: uniqueFilings.slice(0, filingLimit),
      reports: uniqueReports.slice(0, 20),
      corporate: interleaved.slice(0, 40),
      news: news.slice(0, 20),
      legs: legStatus,
      ms: Date.now() - started,
      fetchedAt: Date.now(),
    }
  }

  return { resolve: resolve, dossier: dossier, has: () => !!sourceLayer }
}
