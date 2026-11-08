/** Global macro adapters: fred / bls / fed / ecb / treasury / cfets. */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function clampLimit(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(60, Math.max(1, Math.floor(n)))
}

function toMs(value) {
  const ms = Date.parse(String(value || '').trim())
  return Number.isFinite(ms) ? ms : null
}

function numberOrNull(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (!text || text === 'null' || text === '.') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

function money(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e12) return sign + '$' + (abs / 1e12).toFixed(2) + 'T'
  if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(2) + 'K'
  return sign + '$' + abs.toFixed(2)
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/\s+/g, ' ')
    .trim()
}

function tagText(block, tag) {
  const match = String(block || '').match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i'))
  return match ? decodeEntities(match[1]) : ''
}

function cleanUrl(href) {
  return String(href || '')
    .trim()
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)\/{2,}/i, '$1/')
}

/** Parse RSS 2.0 <item> blocks; regex is enough for the stable feeds we consume. */
function parseRss(xml, limit) {
  const rows = []
  const blockRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
  let match = blockRe.exec(String(xml || ''))
  while (match && rows.length < limit) {
    const block = match[1]
    const link = cleanUrl(tagText(block, 'link') || tagText(block, 'guid'))
    const title = tagText(block, 'title')
    if (link && title) {
      rows.push({
        title: title,
        link: link,
        pubDate: tagText(block, 'pubDate'),
        category: tagText(block, 'category'),
      })
    }
    match = blockRe.exec(String(xml || ''))
  }
  return rows
}

async function fetchRss(ctx, url, limit, timeoutMs) {
  const res = await ctx.getJson(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/rss+xml, application/xml, text/xml, */*' },
    timeoutMs: timeoutMs,
  })
  if (!res || !res.ok) return { items: [], meta: { error: (res && res.error) || ('http ' + (res && res.status)), url } }
  const rows = parseRss(res.text, limit)
  return {
    items: rows.map((row) => ({
      id: row.link,
      title: row.title,
      url: row.link,
      publishedAt: toMs(row.pubDate),
      summary: row.category ? '分类：' + row.category : '',
      tags: row.category ? [row.category] : [],
    })),
    meta: { transport: 'rss', url: url, count: rows.length },
  }
}

/** YYYY-MM-DD in China Standard Time (official CN data is keyed to Beijing dates). */
function cnDate(offsetDays) {
  const shifted = Date.now() + 8 * 3600 * 1000 - (offsetDays || 0) * 86400000
  return new Date(shifted).toISOString().slice(0, 10)
}

const SERIES_LABELS = {
  DFF: '联邦基金有效利率',
  DGS10: '10 年期美债收益率',
  DGS2: '2 年期美债收益率',
  CPIAUCSL: 'CPI 季调',
  UNRATE: '失业率',
  GDP: '名义 GDP',
  M2SL: 'M2 货币供应',
}

const BLS_LABELS = {
  CUUR0000SA0: 'CPI-U 城市消费者物价指数',
  CUUR0000SA0L1E: 'CPI-U 核心（剔除食品能源）',
  CES0000000001: '非农就业人数',
  LNS14000000: '失业率',
  WPUFD4: 'PPI 最终需求',
}

const fred = {
  id: 'fred',
  name: 'FRED 经济数据',
  category: 'macro',
  region: 'US',
  tier: 'A',
  capability: ['series', 'list'],
  homepage: 'https://fred.stlouisfed.org',
  note: '圣路易斯联储经济数据库；需免费 key（FRED_API_KEY），无 key 返回空并提示，不崩。',
  needsKey: true,
  keyEnv: 'FRED_API_KEY',
  rateLimit: { perMinute: 30 },
  ttlMs: 30 * 60 * 1000,
  timeoutMs: 9000,
  async fetch(ctx, params) {
    try {
      const key = String(process.env.FRED_API_KEY || '').trim()
      if (!key) return { items: [], meta: { error: 'missing FRED_API_KEY' } }
      const p = params || {}
      const series = String(p.symbol || 'DFF').trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, '') || 'DFF'
      const limit = clampLimit(p.limit, 20)
      const url =
        'https://api.stlouisfed.org/fred/series/observations?series_id=' +
        encodeURIComponent(series) +
        '&api_key=' +
        encodeURIComponent(key) +
        '&file_type=json&sort_order=desc&limit=' +
        limit
      const res = await ctx.getJson(url, { timeoutMs: 7500 })
      if (!res || !res.ok || !res.json) {
        let detail = (res && res.error) || ('http ' + (res && res.status))
        try {
          const parsed = res && res.text ? JSON.parse(res.text) : null
          if (parsed && parsed.error_message) detail = String(parsed.error_message)
        } catch {}
        return { items: [], meta: { error: detail, series: series } }
      }
      if (res.json.error_message) return { items: [], meta: { error: String(res.json.error_message), series: series } }
      const rows = Array.isArray(res.json.observations) ? res.json.observations : []
      const label = SERIES_LABELS[series] || series
      const items = []
      for (const row of rows) {
        const value = numberOrNull(row.value)
        if (!row.date || value === null) continue
        items.push({
          id: series + ':' + row.date,
          title: label + '（' + series + '）' + row.date + '：' + value,
          url: 'https://fred.stlouisfed.org/series/' + encodeURIComponent(series),
          publishedAt: toMs(row.date),
          summary: 'FRED 时间序列观测值',
          tags: [series, 'FRED'],
          payload: { series: series, date: row.date, value: value },
        })
      }
      return { items: items.slice(0, limit), meta: { series: series, label: label, count: items.length } }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

const bls = {
  id: 'bls',
  name: '美国劳工统计局',
  category: 'macro',
  region: 'US',
  tier: 'A-',
  capability: ['series', 'list'],
  homepage: 'https://www.bls.gov/developers/',
  note: 'BLS 公共 API v1，免 key；限 25 系列/日，默认 CPI-U（CUUR0000SA0）。',
  needsKey: false,
  rateLimit: { perMinute: 10 },
  ttlMs: 60 * 60 * 1000,
  timeoutMs: 9000,
  async fetch(ctx, params) {
    try {
      const p = params || {}
      const series = String(p.symbol || 'CUUR0000SA0').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'CUUR0000SA0'
      const limit = clampLimit(p.limit, 20)
      const endYear = new Date().getUTCFullYear()
      const startYear = endYear - 1
      const body = JSON.stringify({ seriesid: [series], startyear: String(startYear), endyear: String(endYear) })
      const url = 'https://api.bls.gov/publicAPI/v1/timeseries/data/'
      const res = await ctx.postJson(url, body, {
        headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA, accept: 'application/json' },
        timeoutMs: 8000,
      })
      if (!res || !res.ok || !res.json) {
        return { items: [], meta: { error: (res && res.error) || ('http ' + (res && res.status)), url: url } }
      }
      const json = res.json
      if (json.status !== 'REQUEST_SUCCEEDED') {
        const message = Array.isArray(json.message) ? json.message.join('; ') : json.status || 'request failed'
        return { items: [], meta: { error: String(message) } }
      }
      const results = json.Results && Array.isArray(json.Results.series) ? json.Results.series : []
      const data = results[0] && Array.isArray(results[0].data) ? results[0].data : []
      const label = BLS_LABELS[series] || series
      const rows = data
        .filter((row) => /^M(0[1-9]|1[0-2])$/.test(String(row.period || '')))
        .map((row) => ({
          year: Number(row.year),
          month: Number(String(row.period).slice(1)),
          value: numberOrNull(row.value),
          periodName: row.periodName || '',
        }))
        .filter((row) => Number.isFinite(row.year) && Number.isFinite(row.month) && row.value !== null)
        .sort((a, b) => b.year - a.year || b.month - a.month)
      const items = rows.slice(0, limit).map((row) => {
        const month = String(row.month).padStart(2, '0')
        const date = row.year + '-' + month
        return {
          id: series + ':' + date,
          title: label + '（' + series + '）' + row.year + ' 年 ' + row.month + ' 月：' + row.value,
          url: 'https://data.bls.gov/timeseries/' + encodeURIComponent(series),
          publishedAt: Date.UTC(row.year, row.month - 1, 1),
          summary: row.periodName || 'BLS 月度数据',
          tags: [series, 'BLS'],
          payload: { series: series, year: row.year, month: row.month, value: row.value },
        }
      })
      return { items: items, meta: { series: series, label: label, count: rows.length } }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

const fed = {
  id: 'fed',
  name: '美联储新闻稿',
  category: 'policy',
  region: 'US',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://www.federalreserve.gov/newsevents/pressreleases.htm',
  note: '美联储全部新闻稿 RSS（含执法、监管、货币政策），免 key。',
  needsKey: false,
  rateLimit: { perMinute: 30 },
  ttlMs: 60 * 60 * 1000,
  timeoutMs: 9000,
  async fetch(ctx, params) {
    try {
      const limit = clampLimit(params && params.limit, 20)
      const result = await fetchRss(ctx, 'https://www.federalreserve.gov/feeds/press_all.xml', limit, 8000)
      return result
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

function ecbKind(link) {
  const href = String(link || '')
  if (href.includes('/press/key/')) return '讲话'
  if (href.includes('monetary-policy-statement')) return '货币政策'
  if (href.includes('/press/govcdec/')) return '政策决定'
  if (href.includes('/press/pr/')) return '新闻稿'
  return 'ECB'
}

async function ecbRates(ctx, limit) {
  const url =
    'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=' +
    limit +
    '&format=jsondata'
  const res = await ctx.getJson(url, { headers: { 'user-agent': BROWSER_UA }, timeoutMs: 8000 })
  const json = res && res.json
  const dataSet = json && json.dataSets && json.dataSets[0]
  const seriesMap = dataSet && dataSet.series
  const key = seriesMap && Object.keys(seriesMap)[0]
  if (!key) return { items: [], meta: { error: (res && res.error) || 'sdmx empty', url: url } }
  const observations = seriesMap[key].observations || {}
  const dims = json.structure && json.structure.dimensions && json.structure.dimensions.observation
  const times = (dims && dims[0] && dims[0].values) || []
  const items = []
  for (const entry of Object.entries(observations)) {
    const index = Number(String(entry[0]).split(':').pop())
    const point = times[index]
    const values = Array.isArray(entry[1]) ? entry[1] : []
    const value = numberOrNull(values[0])
    if (!point || !point.id || value === null) continue
    items.push({
      id: 'ecb-exr:' + point.id,
      title: 'EUR/USD ' + point.id + '：' + value,
      url: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
      publishedAt: toMs(point.id),
      summary: 'ECB 欧元参考汇率（美元/欧元）',
      tags: ['EUR/USD', '汇率'],
      payload: { pair: 'EUR/USD', date: point.id, value: value },
    })
  }
  items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
  return { items: items.slice(0, limit), meta: { transport: 'sdmx', pair: 'EUR/USD', count: items.length, url: url } }
}

const ecb = {
  id: 'ecb',
  name: '欧洲央行',
  category: 'macro',
  region: 'EU',
  tier: 'A',
  capability: ['list', 'series'],
  homepage: 'https://www.ecb.europa.eu/press/html/index.en.html',
  note: 'ECB 新闻稿 RSS 优先；失败时回退 SDMX 欧元参考汇率（EUR/USD），均免 key。',
  needsKey: false,
  rateLimit: { perMinute: 30 },
  ttlMs: 60 * 60 * 1000,
  timeoutMs: 10000,
  async fetch(ctx, params) {
    try {
      const limit = clampLimit(params && params.limit, 20)
      const rss = await fetchRss(ctx, 'https://www.ecb.europa.eu/rss/press.html', limit, 8000)
      if (rss.items.length > 0) {
        for (const item of rss.items) {
          const kind = ecbKind(item.url)
          item.tags = [kind, 'ECB']
          item.summary = '欧洲央行' + kind
        }
        return rss
      }
      const fallback = await ecbRates(ctx, limit)
      if (fallback.items.length > 0) return fallback
      return { items: [], meta: { error: (rss.meta && rss.meta.error) || (fallback.meta && fallback.meta.error) || 'ecb empty' } }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

const treasury = {
  id: 'treasury',
  name: '美国财政部 MTS',
  category: 'macro',
  region: 'US',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://fiscal.treasury.gov/reports-statements/mts/current.html',
  note: '财政部月度报表（MTS 表 5 支出分类）最新 10-20 行，免 key。',
  needsKey: false,
  rateLimit: { perMinute: 30 },
  ttlMs: 6 * 60 * 60 * 1000,
  timeoutMs: 12000,
  async fetch(ctx, params) {
    try {
      const limit = clampLimit(params && params.limit, 20)
      const url =
        'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/mts/mts_table_5?page%5Bsize%5D=' +
        limit +
        '&sort=-record_date'
      const res = await ctx.getJson(url, { headers: { 'user-agent': BROWSER_UA }, timeoutMs: 10000 })
      if (!res || !res.ok || !res.json) {
        return { items: [], meta: { error: (res && res.error) || ('http ' + (res && res.status)), url: url } }
      }
      const rows = Array.isArray(res.json.data) ? res.json.data : []
      const items = []
      for (const row of rows) {
        const date = String(row.record_date || '')
        const gross = numberOrNull(row.current_month_gross_outly_amt)
        const net = numberOrNull(row.current_month_net_outly_amt)
        const fytd = numberOrNull(row.current_fytd_net_outly_amt)
        const classification = String(row.classification_desc || '未分类').replace(/:$/, '')
        const headline = net !== null ? net : fytd !== null ? fytd : gross
        const headlineLabel = net !== null ? '本月净支出 ' : fytd !== null ? '本财年累计 ' : '本月毛支出 '
        const id = [date, row.classification_id, row.parent_id, row.line_code_nbr, row.src_line_nbr].join(':')
        items.push({
          id: 'mts5:' + id,
          title: '美国联邦支出 · ' + classification + '：' + headlineLabel + money(headline),
          url: 'https://fiscal.treasury.gov/reports-statements/mts/current.html',
          publishedAt: toMs(date),
          summary: [
            gross !== null ? '本月毛支出 ' + money(gross) : '',
            net !== null ? '本月净支出 ' + money(net) : '',
            fytd !== null ? '本财年累计 ' + money(fytd) : '',
          ]
            .filter(Boolean)
            .join(' · '),
          tags: ['MTS', '联邦支出', classification].filter(Boolean),
          payload: {
            recordDate: date,
            classification: String(row.classification_desc || ''),
            currentMonthGross: gross,
            currentMonthNet: net,
            currentFytdNet: fytd,
            fiscalYear: row.record_fiscal_year || '',
            lineCode: row.line_code_nbr || '',
          },
        })
      }
      return { items: items.slice(0, limit), meta: { count: items.length, total: res.json.meta && res.json.meta['total-count'] } }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

const cfets = {
  id: 'cfets',
  name: '中国外汇交易中心中间价',
  category: 'macro',
  region: 'CN',
  tier: 'A',
  capability: ['series', 'list'],
  homepage: 'https://www.chinamoney.com.cn/chinese/bkccpr/',
  note: '人民币汇率中间价历史（默认 USD/CNY 近 30 天）；params.symbol 可换币对。',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  ttlMs: 60 * 60 * 1000,
  timeoutMs: 9000,
  async fetch(ctx, params) {
    try {
      const p = params || {}
      let pair = String(p.symbol || 'USD/CNY').trim().toUpperCase().replace(/-/g, '/')
      if (!pair.includes('/') && /^[A-Z]{6}$/.test(pair)) pair = pair.slice(0, 3) + '/' + pair.slice(3)
      if (!/^[A-Z]{3}\/[A-Z]{3}$/.test(pair)) pair = 'USD/CNY'
      const days = Number.isFinite(Number(p.days)) && Number(p.days) > 0 ? Math.max(1, Math.min(365, Math.floor(Number(p.days)))) : 30
      const limit = clampLimit(p.limit, 20)
      const startDate = cnDate(days)
      const endDate = cnDate(0)
      const url =
        'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew?startDate=' +
        startDate +
        '&endDate=' +
        endDate +
        '&currency=' +
        encodeURIComponent(pair) +
        '&pageSize=' +
        limit
      const res = await ctx.getJson(url, {
        headers: { 'user-agent': BROWSER_UA, referer: 'https://www.chinamoney.com.cn/' },
        timeoutMs: 7500,
      })
      if (!res || !res.ok || !res.json) {
        return { items: [], meta: { error: (res && res.error) || ('http ' + (res && res.status)), pair: pair } }
      }
      const json = res.json
      const records = Array.isArray(json.records) ? json.records : (json.data && Array.isArray(json.data.records) ? json.data.records : [])
      const items = []
      for (const row of records) {
        const date = String(row.date || '')
        const values = Array.isArray(row.values) ? row.values : []
        const rateText = String(values[0] === undefined ? '' : values[0]).trim()
        const rate = numberOrNull(rateText)
        if (!date || rate === null) continue
        items.push({
          id: 'cfets:' + pair + ':' + date,
          title: pair + ' 人民币中间价 ' + date + '：' + rateText,
          url: 'https://www.chinamoney.com.cn/chinese/bkccpr/',
          publishedAt: toMs(date),
          summary: '中国外汇交易中心受权公布的人民币汇率中间价',
          tags: ['中间价', '人民币', pair],
          payload: { pair: pair, date: date, rate: rate },
        })
      }
      items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
      return {
        items: items.slice(0, limit),
        meta: { pair: pair, from: startDate, to: endDate, total: (json.data && json.data.total) || items.length },
      }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

export const adapters = [fred, bls, fed, ecb, treasury, cfets]
