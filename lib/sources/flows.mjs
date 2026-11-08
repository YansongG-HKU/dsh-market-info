/**
 * Flows & risk adapters: cftc / cboe / ofac.
 *
 * Three public, key-less endpoints that describe positioning, volatility and
 * sanctions. Two of them have a fallback path because the primary host is not
 * reachable from every network:
 *
 *   cftc  Socrata PRE answers 403 to some ASNs (checked with curl too); the
 *         legacy CFTC short-form report page is used instead.
 *   ofac  the old data.treasury.gov OData feed now redirects to an unrelated
 *         page; the Recent Actions list is the live stream of SDN updates,
 *         with the full SDN.CSV kept as a 12h-cached fallback.
 */

const JSON_HEADERS = { accept: 'application/json' }
const HTML_HEADERS = { accept: 'text/html,application/xhtml+xml' }

/** Full browser-ish header set: Cloudflare challenges a bare node client. */
const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
}

function clean(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function limitOf(params, fallback) {
  const n = Number(params && params.limit)
  return Math.max(1, Math.min(60, Number.isFinite(n) ? n : fallback))
}

function at(value) {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : null
}

function num(value) {
  const n = Number(String(value === undefined || value === null ? '' : value).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function group(value) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function signed(value) {
  return (value >= 0 ? '+' : '') + group(value)
}

/** Stable 32-bit hash for ids that have no natural key. */
function hash(value) {
  let h = 5381
  const text = String(value || '')
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const CFTC_PAGE = 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm'
const CFTC_HTML = 'https://www.cftc.gov/dea/futures/deacmesf.htm'

/** Socrata is hard-blocked on some networks; do not retry it for 30 minutes. */
let socrataDownUntil = 0

/**
 * cftc.gov sits behind Cloudflare: a cold request gets a 403 challenge that
 * sets `__cf_bm`. Replaying that cookie on the next request passes without JS.
 */
function cfCookie(res) {
  const raw = res && res.headers && res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  for (const line of list) {
    const match = /(__cf_bm=[^;]+)/.exec(line)
    if (match) return match[1]
  }
  return ''
}

async function getCftcHtml(ctx) {
  const first = await ctx.getJson(CFTC_HTML, { headers: BROWSER_HEADERS, timeoutMs: 7000 })
  if (first.ok || first.status !== 403) return first
  const cookie = cfCookie(first)
  if (!cookie) return first
  return ctx.getJson(CFTC_HTML, { headers: Object.assign({}, BROWSER_HEADERS, { cookie }), timeoutMs: 7000 })
}

function fromSocrata(rows, limit) {
  const dated = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row.report_date_as_yyyy_mm_dd || '').slice(0, 10)
    if (date) dated.push({ row, date })
  }
  const latest = dated.reduce((max, item) => (item.date > max ? item.date : max), '')
  const out = []
  for (const item of dated) {
    if (latest && item.date !== latest) continue
    const name = String(item.row.market_and_exchange_names || '').trim()
    if (!name) continue
    const long = num(item.row.noncomm_positions_long_all)
    const short = num(item.row.noncomm_positions_short_all)
    const oi = num(item.row.open_interest_all)
    const net = long - short
    out.push({
      id: 'cftc:' + item.date + ':' + name,
      title: name + ' · 净多头 ' + signed(net),
      url: CFTC_PAGE,
      publishedAt: at(item.date),
      summary: '非商业多头 ' + group(long) + ' / 空头 ' + group(short) + '；未平仓 ' + group(oi),
      tags: ['CFTC', 'COT', '持仓'],
      payload: { market: name, long, short, oi, net, reportDate: item.date },
    })
    if (out.length >= limit) break
  }
  return out
}

/** Parse the legacy short-form report: one block per market, fixed columns. */
function fromCftcHtml(text, limit) {
  const pre = /<pre>([\s\S]*?)<\/pre>/i.exec(String(text || ''))
  const body = pre ? pre[1] : String(text || '')
  const dateMatch = /AS OF (\d{2})\/(\d{2})\/(\d{2})/.exec(body)
  const when = dateMatch
    ? new Date(Date.UTC(2000 + Number(dateMatch[3]), Number(dateMatch[1]) - 1, Number(dateMatch[2]), 12))
    : null
  const reportDate = when ? when.toISOString().slice(0, 10) : ''
  const block = /([^\n]+?)\s+Code-(\d{6})[^\n]*\n(?:[^\n]*\n){0,10}?[^\n]*?OPEN INTEREST:\s*([\d,]+)\s*\nCOMMITMENTS\s*\n\s*([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/g
  const out = []
  let match
  while ((match = block.exec(body))) {
    const name = clean(match[1])
    if (!name) continue
    const oi = num(match[3])
    const long = num(match[4])
    const short = num(match[5])
    const net = long - short
    out.push({
      id: 'cftc:' + reportDate + ':' + name,
      title: name + ' · 净多头 ' + signed(net),
      url: CFTC_HTML,
      publishedAt: when ? when.getTime() : null,
      summary: '非商业多头 ' + group(long) + ' / 空头 ' + group(short) + '；未平仓 ' + group(oi),
      tags: ['CFTC', 'COT', '持仓'],
      payload: { market: name, code: match[2], long, short, spread: num(match[6]), oi, net, reportDate },
    })
  }
  out.sort((a, b) => Math.abs(b.payload.net) - Math.abs(a.payload.net))
  return out.slice(0, limit)
}

const cftc = {
  id: 'cftc',
  name: 'CFTC COT 持仓',
  category: 'flow',
  region: 'US',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm',
  note: 'Socrata 对部分网络 403，自动回退 CFTC 官网当前短格式报告',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 15000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 40)
    try {
      if (Date.now() > socrataDownUntil) {
        const query = '?$limit=' + Math.min(60, limit) + '&$order=report_date_as_yyyy_mm_dd%20DESC'
        const res = await ctx.getJson('https://publicreporting.cftc.gov/resource/6dca-aqww.json' + query, { headers: JSON_HEADERS, timeoutMs: 4500 })
        if (res.ok && Array.isArray(res.json)) {
          const items = fromSocrata(res.json, limit)
          if (items.length) return { items, meta: { total: items.length, endpoint: 'socrata', reportDate: items[0].payload.reportDate } }
        }
        if (res.status === 403 || res.status === 412) socrataDownUntil = Date.now() + 30 * 60 * 1000
      }
      let res = await getCftcHtml(ctx)
      if (!res.ok && (res.status === 403 || res.status === 503 || res.status === 520)) {
        await new Promise((resolve) => setTimeout(resolve, 900))
        res = await getCftcHtml(ctx)
      }
      if (!res.ok) return { items: [], meta: { error: 'cftc html http ' + (res.status || res.error), socrata: 'down' } }
      const items = fromCftcHtml(res.text, limit)
      if (!items.length) return { items: [], meta: { error: 'parsed 0 markets' } }
      return { items, meta: { total: items.length, endpoint: 'cftc-html', note: 'Socrata 403，已回退官网短格式报告' } }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

const CBOE_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/'

/** CBOE's snapshot timestamp is UTC; last_trade_time is exchange local. */
function cboeTime(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(raw || ''))
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : null
}

function quoteItem(file, json) {
  const data = json && json.data
  if (!data || !Number.isFinite(Number(data.current_price))) return null
  const symbol = String(data.symbol || file).replace(/^\^/, '')
  const price = Number(data.current_price)
  const change = Number(data.price_change)
  const percent = Number(data.price_change_percent)
  return {
    id: 'cboe:' + symbol,
    title: symbol + ' ' + price.toFixed(2) + '（' + (percent >= 0 ? '+' : '') + percent.toFixed(2) + '%）',
    url: CBOE_BASE + file + '.json',
    publishedAt: cboeTime(json.timestamp),
    summary: '最新 ' + price.toFixed(2) + '，日内 ' + Number(data.low).toFixed(2) + '–' + Number(data.high).toFixed(2) + '，前收 ' + Number(data.prev_day_close).toFixed(2) + ' · 延迟报价',
    tags: ['CBOE', '波动率', '延迟'],
    payload: {
      symbol: data.symbol,
      price,
      change: Number.isFinite(change) ? change : null,
      changePercent: Number.isFinite(percent) ? percent : null,
      open: Number(data.open),
      high: Number(data.high),
      low: Number(data.low),
      prevClose: Number(data.prev_day_close),
      iv30: Number(data.iv30),
      lastTradeTime: data.last_trade_time || '',
      delayed: true,
    },
  }
}

const cboe = {
  id: 'cboe',
  name: 'CBOE 波动率',
  category: 'volatility',
  region: 'US',
  tier: 'A-',
  capability: ['list'],
  homepage: 'https://www.cboe.com',
  note: '非官方延迟报价（CBOE CDN，约 15 分钟延迟）',
  needsKey: false,
  rateLimit: { perMinute: 30 },
  timeoutMs: 9000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 10)
    const files = ['_VIX', '_SPX'].slice(0, Math.max(1, Math.min(2, limit)))
    try {
      const results = await Promise.all(files.map((file) => ctx.getJson(CBOE_BASE + file + '.json', { headers: JSON_HEADERS, timeoutMs: 6000 })))
      const items = []
      const errors = []
      for (let i = 0; i < results.length; i += 1) {
        const res = results[i]
        if (!res.ok) {
          errors.push(files[i] + ':' + (res.status || res.error))
          continue
        }
        const item = quoteItem(files[i], res.json)
        if (item) items.push(item)
        else errors.push(files[i] + ':bad payload')
      }
      if (!items.length) return { items: [], meta: { error: errors.join('; ') || 'no quotes' } }
      return { items, meta: { total: items.length, delayed: true, errors: errors.join('; ') } }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

const OFAC_RECENT = 'https://ofac.treasury.gov/recent-actions'
const SDN_CSV = 'https://www.treasury.gov/ofac/downloads/sdn.csv'

/** Recent Actions rows: dated <a> for the action + a category link. */
function parseOfacRecent(text, limit) {
  const out = []
  for (const chunk of String(text || '').split('views-row').slice(1)) {
    const link = /<a href="\/recent-actions\/(\d{8})"[^>]*>([\s\S]*?)<\/a>/.exec(chunk)
    if (!link) continue
    const title = clean(link[2])
    if (!title) continue
    const human = /([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(chunk)
    const category = /<a href="\/recent-actions\/([a-z][a-z-]+)">([^<]+)<\/a>/.exec(chunk)
    const date = link[1]
    out.push({
      id: 'ofac:' + date + ':' + hash(title),
      title,
      url: OFAC_RECENT + '/' + date,
      publishedAt: human ? at(human[1]) : at(date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6)),
      summary: category ? clean(category[2]) : '',
      tags: ['OFAC', category ? clean(category[2]) : '制裁'],
      payload: { date, category: category ? clean(category[2]) : '' },
    })
    if (out.length >= limit) break
  }
  return out
}

/** Minimal RFC4180 reader: enough for sdn.csv, stops after `limit` records. */
function parseCsv(text, limit) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const body = String(text || '')
  for (let i = 0; i < body.length && rows.length < limit; i += 1) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      if (row.length >= 4 && /^\d+$/.test(row[0])) rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  return rows
}

/** Parsed SDN rows are module-cached for 12h: the feed is ~6 MB. */
let sdnCache = { at: 0, rows: [] }

const ofac = {
  id: 'ofac',
  name: 'OFAC 制裁名单',
  category: 'sanction',
  region: 'GLOBAL',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://ofac.treasury.gov',
  note: 'Recent Actions 更新流；失败时回退 SDN.CSV（无时间戳，取文件前 N 条）',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 15000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 40)
    try {
      const pages = limit > 10 ? 2 : 1
      const urls = []
      for (let page = 0; page < pages; page += 1) urls.push(OFAC_RECENT + (page ? '?page=' + page : ''))
      const results = await Promise.all(urls.map((href) => ctx.getJson(href, { headers: HTML_HEADERS, timeoutMs: 6000 })))
      const items = []
      const seen = new Set()
      for (const res of results) {
        if (!res.ok) continue
        for (const item of parseOfacRecent(res.text, limit)) {
          if (seen.has(item.id)) continue
          seen.add(item.id)
          items.push(item)
          if (items.length >= limit) break
        }
      }
      if (items.length) return { items, meta: { total: items.length, endpoint: 'recent-actions' } }

      if (!sdnCache.rows.length || Date.now() - sdnCache.at > 12 * 60 * 60 * 1000) {
        const res = await ctx.getJson(SDN_CSV, { headers: { accept: 'text/csv,*/*' }, timeoutMs: 11000 })
        if (!res.ok) return { items: [], meta: { error: 'recent-actions empty; sdn.csv ' + (res.status || res.error) } }
        sdnCache = { at: Date.now(), rows: parseCsv(res.text, 60) }
      }
      for (const row of sdnCache.rows.slice(0, limit)) {
        const name = clean(row[1]) || 'SDN #' + row[0]
        const program = clean(row[3])
        const type = clean(row[2]) === '-0-' ? '' : clean(row[2])
        items.push({
          id: 'ofac:sdn:' + row[0],
          title: name + (program && program !== '-0-' ? ' · ' + program : ''),
          url: 'https://sanctionssearch.ofac.treas.gov/Details.aspx?id=' + encodeURIComponent(row[0]),
          publishedAt: null,
          summary: 'SDN 类型 ' + (type || '-') + '；项目 ' + (program || '-'),
          tags: ['OFAC', 'SDN'],
          payload: { entNum: row[0], name, type, program },
        })
      }
      return { items, meta: { total: items.length, endpoint: 'sdn.csv', note: 'CSV 无时间戳，取文件前 ' + items.length + ' 条' } }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

export const adapters = [cftc, cboe, ofac]
