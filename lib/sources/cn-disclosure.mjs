/**
 * CN / HK disclosure adapters: cninfo (巨潮) · sse (上交所) · szse (深交所) · hkex (披露易).
 * Contract: docs/SOURCE-CONTRACT.md. Every fetch returns { items, meta } and never throws.
 */

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_ITEMS = 60

/** Today (plus offset days) as YYYY-MM-DD on the China clock. */
function cnDay(offset) {
  const shifted = new Date(Date.now() + 8 * 3600000 + (Number(offset) || 0) * 86400000)
  return shifted.toISOString().slice(0, 10)
}

/** 'YYYY-MM-DD[ HH:mm[:ss]]' on the China clock -> epoch ms, or null. */
function cnMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(text || ''))
  if (!m) return null
  const ms = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + (m[4] || '00') + ':' + (m[5] || '00') + ':00+08:00')
  return Number.isFinite(ms) ? ms : null
}

/** 'DD/MM/YYYY HH:mm' on the Hong Kong clock -> epoch ms, or null. */
function hkMs(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(String(text || ''))
  if (!m) return null
  const ms = Date.parse(m[3] + '-' + m[2] + '-' + m[1] + 'T' + m[4] + ':' + m[5] + ':00+08:00')
  return Number.isFinite(ms) ? ms : null
}

function limitOf(params, fallback) {
  const n = Math.floor(Number(params && params.limit))
  return Math.min(MAX_ITEMS, Number.isFinite(n) && n > 0 ? n : fallback)
}

/** `YYYY-MM-DD` from loose input, or '' when the value is not a date. */
function dayParam(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''))
  return m ? m[1] + '-' + m[2] + '-' + m[3] : ''
}

/** One-line failure text for meta.error. */
function failure(res) {
  if (!res) return 'no response'
  if (res.error) return String(res.error)
  if (!res.ok && res.status) return 'http ' + res.status
  return String(res.jsonError || 'unparsable body')
}

/** These feeds embed light markup and HTML entities (cninfo highlights hits with <em>). */
function plain(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&#x2f;/gi, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function label(code, name) {
  return [code, name].filter(Boolean).map(String).join(' ')
}

const CNINFO_URL = 'http://www.cninfo.com.cn/new/hisAnnouncement/query'
const CNINFO_OPTIONS = { referer: 'http://www.cninfo.com.cn/', headers: { 'user-agent': CHROME_UA }, timeoutMs: 9000 }

/**
 * Form body. `seDate` must be `start~end`; any other shape is rejected by the server.
 * `stock` filters to one issuer and needs the internal orgId: `600519,gssh0600519`.
 * Passing the bare code returns zero rows.
 */
function cninfoBody(query, page, size, from, to, stock) {
  const range = from && to ? from + '~' + to : ''
  return (
    'pageNum=' + page + '&pageSize=' + size + '&column=szse&tabName=fulltext&plate=' +
    '&stock=' + encodeURIComponent(stock || '') +
    '&searchkey=' + encodeURIComponent(query) + '&secid=&category=&trade=' +
    '&seDate=' + encodeURIComponent(range) + '&sortName=&sortType=&isHLtitle=true'
  )
}

const cninfo = {
  id: 'cninfo',
  name: '巨潮资讯',
  category: 'filing',
  region: 'CN',
  tier: 'A',
  capability: ['search', 'list'],
  homepage: 'https://www.cninfo.com.cn',
  note: '沪深京上市公司公告全文检索，取最新公告标题与 PDF 链接',
  needsKey: false,
  keyEnv: '',
  rateLimit: { perMinute: 30 },
  ttlMs: 1200000,
  timeoutMs: 9000,
  async fetch(ctx, params) {
    const p = params || {}
    const limit = limitOf(p, 30)
    const query = String(p.q || p.keyword || '').trim()
    const from = dayParam(p.from)
    const to = dayParam(p.to)
    // A per-issuer filter: cninfo wants `code,orgId`, never the bare code.
    const symbol = p.symbol ? String(p.symbol).trim() : ''
    const stock = symbol ? (p.orgId ? symbol + ',' + String(p.orgId) : symbol) : ''
    const items = []
    let total = 0
    try {
      // pageSize is capped at 30 server-side, so walk pages until the limit is met.
      for (let page = 1; page <= 3 && items.length < limit; page += 1) {
        const size = Math.min(30, limit - items.length)
        const res = await ctx.postJson(CNINFO_URL, cninfoBody(query, page, size, from, to, stock), CNINFO_OPTIONS)
        if (!res.ok || !res.json) return { items: items, meta: { error: failure(res) } }
        total = Number(res.json.totalRecordNum) || total
        const rows = Array.isArray(res.json.announcements) ? res.json.announcements : []
        if (rows.length === 0) break
        for (const row of rows) {
          const file = String(row.adjunctUrl || '').replace(/^\//, '')
          const url = file ? 'http://static.cninfo.com.cn/' + file : ''
          items.push({
            id: String(row.announcementId || url || row.announcementTitle || ''),
            title: plain(row.announcementTitle),
            url: url,
            publishedAt: Number(row.announcementTime) || null,
            summary: label(row.secCode, row.secName),
            tags: row.secCode ? ['公告', String(row.secCode)] : ['公告'],
            payload: { code: row.secCode || '', name: row.secName || '', format: row.adjunctType || '' },
          })
          if (items.length >= limit) break
        }
      }
      return { items: items.slice(0, limit), meta: { total: total || items.length, page: 1 } }
    } catch (error) {
      return { items: [], meta: { error: String((error && error.message) || error) } }
    }
  },
}

const SSE_URL = 'http://query.sse.com.cn/security/stock/queryCompanyBulletinNew.do'
const SSE_REFERER = 'http://www.sse.com.cn/'

/** Unquoted `pageHelp.*` keys are the ones this servlet actually honours. */
function sseQuery(p, limit) {
  const from = dayParam(p.from) || cnDay(-7)
  const to = dayParam(p.to) || cnDay(0)
  const keyword = String(p.q || p.keyword || '').trim()
  return (
    SSE_URL + '?jsonCallBack=jsonpCallback&isPagination=true' +
    '&pageHelp.pageSize=' + limit + '&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.endPage=1&pageHelp.cacheSize=1' +
    '&START_DATE=' + encodeURIComponent(from) + '&END_DATE=' + encodeURIComponent(to) +
    '&SECURITY_CODE=' + encodeURIComponent(String(p.symbol || '')) +
    '&TITLE=' + encodeURIComponent(keyword) + '&BULLETIN_TYPE=&stockType='
  )
}

const sse = {
  id: 'sse',
  name: '上交所公告',
  category: 'filing',
  region: 'CN',
  tier: 'A',
  capability: ['search', 'list'],
  homepage: 'http://www.sse.com.cn',
  note: '上交所上市公司公告，需带 referer，默认取最近 7 天',
  needsKey: false,
  keyEnv: '',
  rateLimit: { perMinute: 30 },
  ttlMs: 1200000,
  timeoutMs: 9000,
  async fetch(ctx, params) {
    const p = params || {}
    const limit = limitOf(p, 40)
    try {
      const res = await ctx.getJson(sseQuery(p, limit), { referer: SSE_REFERER, timeoutMs: 9000 })
      if (!res.ok || !res.json) return { items: [], meta: { error: failure(res) } }
      const items = []
      // Each entry is one bulletin group: [main announcement, ...attachments].
      // Only the main row is listed; attachments share the parent ORG_BULLETIN_ID.
      for (const entry of Array.isArray(res.json.result) ? res.json.result : []) {
        const row = Array.isArray(entry) ? entry[0] : entry
        if (!row || !row.TITLE) continue
        const path = String(row.URL || '')
        const url = path ? (path.startsWith('http') ? path : 'http://www.sse.com.cn' + path) : ''
        items.push({
          id: String(row.ORG_BULLETIN_ID || url || row.TITLE),
          title: plain(row.TITLE),
          url: url,
          publishedAt: cnMs(row.SSEDATE),
          summary: label(row.SECURITY_CODE, row.SECURITY_NAME),
          tags: [row.BULLETIN_TYPE_DESC, row.SECURITY_CODE].filter(Boolean).map(String),
          payload: { code: row.SECURITY_CODE || '', name: row.SECURITY_NAME || '', type: row.BULLETIN_TYPE_DESC || '' },
        })
        if (items.length >= limit) break
      }
      const total = Number(res.json.pageHelp && res.json.pageHelp.total) || items.length
      return { items: items, meta: { total: total, page: 1 } }
    } catch (error) {
      return { items: [], meta: { error: String((error && error.message) || error) } }
    }
  },
}

const SZSE_URL = 'http://www.szse.cn/api/disc/announcement/annList'
const SZSE_FILE_BASE = 'https://disc.static.szse.cn/download'
const SZSE_OPTIONS = {
  referer: 'http://www.szse.cn/disclosure/listed/notice/index.html',
  headers: { 'content-type': 'application/json' },
  timeoutMs: 9000,
}

const szse = {
  id: 'szse',
  name: '深交所公告',
  category: 'filing',
  region: 'CN',
  tier: 'A',
  capability: ['list'],
  homepage: 'http://www.szse.cn',
  note: '深交所上市公司公告（disclosure 接口），取最新公告标题与 PDF 链接',
  needsKey: false,
  keyEnv: '',
  rateLimit: { perMinute: 30 },
  ttlMs: 1200000,
  timeoutMs: 9000,
  async fetch(ctx, params) {
    const p = params || {}
    const limit = limitOf(p, 30)
    const from = dayParam(p.from)
    const to = dayParam(p.to)
    const body = JSON.stringify({
      seDate: [from, to],
      stock: p.symbol ? [String(p.symbol)] : [],
      channelCode: ['listedNotice_disc'],
      pageSize: limit,
      pageNum: 1,
    })
    try {
      const res = await ctx.postJson(SZSE_URL, body, SZSE_OPTIONS)
      if (!res.ok || !res.json) return { items: [], meta: { error: failure(res) } }
      const rows = Array.isArray(res.json.data) ? res.json.data : []
      const items = []
      for (const row of rows) {
        const path = String(row.attachPath || '').replace(/^\//, '')
        const url = path ? SZSE_FILE_BASE + '/' + path : ''
        const code = Array.isArray(row.secCode) ? row.secCode[0] : row.secCode
        const name = Array.isArray(row.secName) ? row.secName[0] : row.secName
        items.push({
          id: String(row.annId || row.id || url || row.title || ''),
          title: String(row.title || '').trim(),
          url: url,
          publishedAt: cnMs(row.publishTime),
          summary: label(code, name),
          tags: code ? ['公告', String(code)] : ['公告'],
          payload: { code: code || '', name: name || '', format: row.attachFormat || '' },
        })
        if (items.length >= limit) break
      }
      return { items: items, meta: { total: Number(res.json.announceCount) || items.length, page: 1 } }
    } catch (error) {
      return { items: [], meta: { error: String((error && error.message) || error) } }
    }
  },
}

const HKEX_URL = 'https://www1.hkexnews.hk/search/titleSearchServlet.do'
const HKEX_ORIGIN = 'https://www1.hkexnews.hk'
const HKEX_REFERER = 'https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh'

/** `t1code/t2Gcode/t2code = -2` means "all document types"; -1 returns nothing. */
function hkexQuery(p, limit) {
  const keyword = String(p.q || p.keyword || '').trim()
  const from = dayParam(p.from).replace(/-/g, '')
  const to = dayParam(p.to).replace(/-/g, '')
  return (
    HKEX_URL + '?sortDir=0&sortByOptions=DateTime&category=0&market=SEHK&stockId=-1&documentType=-1' +
    '&fromDate=' + from + '&toDate=' + to + '&title=' + encodeURIComponent(keyword) +
    '&searchType=0&t1code=-2&t2Gcode=-2&t2code=-2&rowRange=' + limit + '&lang=zh'
  )
}

const hkex = {
  id: 'hkex',
  name: '香港披露易',
  category: 'filing',
  region: 'HK',
  tier: 'A-',
  capability: ['search', 'list'],
  homepage: 'https://www1.hkexnews.hk',
  note: '非官方接口，可能变动；取港交所最新公告标题与 PDF 链接',
  needsKey: false,
  keyEnv: '',
  rateLimit: { perMinute: 20 },
  ttlMs: 1200000,
  timeoutMs: 12000,
  async fetch(ctx, params) {
    const p = params || {}
    const limit = limitOf(p, 40)
    try {
      const res = await ctx.getJson(hkexQuery(p, limit), { referer: HKEX_REFERER, timeoutMs: 12000 })
      if (!res.ok || !res.json) return { items: [], meta: { error: failure(res) } }
      // `result` is a JSON string holding the rows (not a nested object).
      let rows = res.json.result
      if (typeof rows === 'string') {
        try {
          rows = JSON.parse(rows)
        } catch {
          rows = []
        }
      }
      if (!Array.isArray(rows)) rows = []
      const items = []
      for (const row of rows) {
        if (!row || !row.TITLE) continue
        const file = String(row.FILE_LINK || '')
        const url = file ? (file.startsWith('http') ? file : HKEX_ORIGIN + file) : ''
        items.push({
          id: String(row.NEWS_ID || url || row.TITLE),
          title: plain(row.TITLE),
          url: url,
          publishedAt: hkMs(row.DATE_TIME),
          summary: plain(row.LONG_TEXT || row.SHORT_TEXT),
          tags: [row.STOCK_CODE, row.STOCK_NAME].filter(Boolean).map(String),
          payload: { code: row.STOCK_CODE || '', name: row.STOCK_NAME || '', format: row.FILE_TYPE || '' },
        })
        if (items.length >= limit) break
      }
      const total = Number(res.json.recordCnt) || items.length
      return { items: items, meta: { total: total, page: 1 } }
    } catch (error) {
      return { items: [], meta: { error: String((error && error.message) || error) } }
    }
  },
}

export const adapters = [cninfo, sse, szse, hkex]
