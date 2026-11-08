/**
 * Public web surfaces of the big CN retail terminals — 同花顺 / 东方财富 / 新浪财经.
 *
 * These are the pages and JSON endpoints the sites serve to anonymous visitors:
 * 7×24 newswires, sell-side report summaries, and the daily fund-flow leaderboard.
 * Nothing here logs in, replays a paid entitlement or bypasses an access control;
 * the paid terminals (iFinD / Choice) are not reachable from this layer.
 *
 * See docs/SOURCE-CONTRACT.md for the adapter contract.
 */

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json, text/javascript, text/html, */*',
}

function limitOf(params, fallback) {
  const n = Number(params && params.limit)
  return Math.min(Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback, 60)
}

/** Parse a CN local timestamp ("2026-11-06 00:00:00.000", +08:00) into epoch ms. */
function cnTime(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(raw || ''))
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0) - 8, Number(m[5] || 0), Number(m[6] || 0))
}

/** yyyy-mm-dd for a day offset from today, in CN local time. */
function ymdOffset(days) {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000 - days * 24 * 60 * 60 * 1000)
  return now.toISOString().slice(0, 10)
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------- 同花顺 7×24

const THS_LIVE = 'https://news.10jqka.com.cn/tapp/news/push/stock/'

const thsLive = {
  id: 'ths-live',
  name: '同花顺 7×24',
  category: 'flash',
  region: 'CN',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://news.10jqka.com.cn/realtimenews.html',
  note: '同花顺财经 7×24 快讯（匿名 JSON 接口，公开数据）',
  needsKey: false,
  rateLimit: { perMinute: 30 },
  timeoutMs: 9000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 40)
    const url = THS_LIVE + '?page=1&tag=&track=website&pagesize=' + limit
    const res = await ctx.getJson(url, { headers: BROWSER, referer: 'https://news.10jqka.com.cn/', timeoutMs: 8000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const list = res.json && res.json.data && res.json.data.list
    if (!Array.isArray(list)) return { items: [], meta: { error: 'unexpected payload shape' } }
    const items = []
    for (const row of list.slice(0, limit)) {
      const ctime = Number(row.ctime)
      const text = stripTags(row.digest || row.short || '')
      items.push({
        id: 'ths-live:' + row.id,
        title: String(row.title || '').slice(0, 160),
        url: String(row.url || row.shareUrl || 'https://news.10jqka.com.cn/realtimenews.html'),
        publishedAt: Number.isFinite(ctime) && ctime > 0 ? ctime * 1000 : null,
        summary: text.slice(0, 300),
        tags: Array.isArray(row.tags) ? row.tags.map((t) => t && t.name).filter(Boolean).slice(0, 6) : [],
        payload: { seq: row.seq, tag: row.tag || '' },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'tapp/news/push' } }
  },
}

// ---------------------------------------------------------------- 新浪财经 7×24

const SINA_LIVE = 'https://zhibo.sina.com.cn/api/zhibo/feed'

const sinaLive = {
  id: 'sina-live',
  name: '新浪财经 7×24',
  category: 'flash',
  region: 'CN',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://finance.sina.com.cn/7x24/',
  note: '新浪财经 7×24 直播（公开 JSON，含个股关联标签）',
  needsKey: false,
  rateLimit: { perMinute: 30 },
  timeoutMs: 9000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 40)
    const url = SINA_LIVE + '?page=1&page_size=' + limit + '&zhibo_id=152&tag_id=0'
    const res = await ctx.getJson(url, { headers: BROWSER, referer: 'https://finance.sina.com.cn/7x24/', timeoutMs: 8000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const feed = res.json && res.json.result && res.json.result.data && res.json.result.data.feed
    const list = feed && feed.list
    if (!Array.isArray(list)) return { items: [], meta: { error: 'unexpected payload shape' } }
    const items = []
    for (const row of list.slice(0, limit)) {
      const raw = stripTags(row.rich_text || '')
      if (!raw) continue
      const headline = /^【([^】]{2,80})】/.exec(raw)
      let docurl = ''
      try {
        const ext = JSON.parse(row.ext || '{}')
        docurl = ext && ext.docurl ? String(ext.docurl) : ''
      } catch {}
      const tags = []
      try {
        const ext = JSON.parse(row.ext || '{}')
        for (const stock of (ext && ext.stocks) || []) {
          if (stock && stock.key) tags.push(String(stock.key))
        }
      } catch {}
      items.push({
        id: 'sina-live:' + row.id,
        title: (headline ? headline[1] : raw).slice(0, 160),
        url: docurl || 'https://finance.sina.com.cn/7x24/',
        publishedAt: cnTime(row.create_time),
        summary: (headline ? raw.slice(headline[0].length) : raw).trim().slice(0, 300),
        tags: tags.slice(0, 6),
        payload: { zhiboId: row.zhibo_id, tag: row.tag || '' },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'zhibo/feed' } }
  },
}

// ---------------------------------------------------------------- 东方财富研报

const EM_REPORT = 'https://reportapi.eastmoney.com/report/list'

const emReport = {
  id: 'em-report',
  name: '东方财富研报',
  category: 'research',
  region: 'CN',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://data.eastmoney.com/report/',
  note: '卖方研报摘要：机构 / 评级 / 当年 EPS 预测（只取公开摘要，不含付费全文）',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 10000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 30)
    const from = String(params && params.from ? params.from : ymdOffset(14))
    const to = String(params && params.to ? params.to : ymdOffset(0))
    const url =
      EM_REPORT +
      '?industryCode=*&pageSize=' + limit + '&industry=*&rating=&ratingChange=&beginTime=' + encodeURIComponent(from) +
      '&endTime=' + encodeURIComponent(to) + '&pageNo=1&fields=&qType=0&orgCode=&code=' +
      encodeURIComponent(String((params && params.symbol) || '*')) + '&rcode='
    const res = await ctx.getJson(url, { headers: BROWSER, referer: 'https://data.eastmoney.com/report/', timeoutMs: 9000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const rows = res.json && res.json.data
    if (!Array.isArray(rows)) return { items: [], meta: { error: 'unexpected payload shape' } }
    const items = []
    for (const row of rows.slice(0, limit)) {
      if (!row || !row.title) continue
      const code = String(row.infoCode || '')
      const rating = row.emRatingName || row.sRatingName || ''
      const eps = row.predictThisYearEps ? Number(row.predictThisYearEps) : null
      const bits = []
      if (rating) bits.push('评级 ' + rating)
      if (row.indvInduName) bits.push('行业 ' + row.indvInduName)
      if (eps !== null && Number.isFinite(eps)) bits.push('今年 EPS 预测 ' + eps.toFixed(2))
      if (row.predictThisYearPe) bits.push('PE ' + Number(row.predictThisYearPe).toFixed(1))
      items.push({
        id: 'em-report:' + code,
        title: (String(row.stockName || '') + ' · ' + String(row.orgSName || '') + '：' + String(row.title)).slice(0, 200),
        url: 'https://data.eastmoney.com/report/zw_stock.jshtml?infocode=' + encodeURIComponent(code),
        publishedAt: cnTime(row.publishDate),
        summary: bits.join(' · '),
        tags: [row.stockCode, row.emIndustryName || row.indvInduName || ''].filter(Boolean),
        payload: {
          stockCode: row.stockCode || '',
          stockName: row.stockName || '',
          org: row.orgSName || '',
          rating,
          ratingChange: row.ratingChange,
          epsThisYear: eps,
        },
      })
    }
    return { items, meta: { total: items.length, window: from + '~' + to, endpoint: 'reportapi/list' } }
  },
}

/** Parse a CN amount like "3.50亿" / "6932.36万" / "1,234" into a number of yuan. */
function cnAmount(raw) {
  const m = /^(-?[\d.]+)\s*(亿|万)?/.exec(String(raw || '').replace(/,/g, ''))
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value)) return null
  if (m[2] === '亿') return value * 1e8
  if (m[2] === '万') return value * 1e4
  return value
}

function humanAmount(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return ''
  const abs = Math.abs(value)
  if (abs >= 1e8) return (value / 1e8).toFixed(2) + '亿'
  if (abs >= 1e4) return (value / 1e4).toFixed(2) + '万'
  return String(value)
}

// ---------------------------------------------------------------- 同花顺资金流

const THS_FLOW = 'https://data.10jqka.com.cn/funds/ggzjl/'

/**
 * The leaderboard columns are fixed by the page markup:
 * 序号 · 代码 · 简称 · 最新价 · 涨跌幅 · 换手率 · 流入资金 · 流出资金 · 净额 · 成交额 · 大单净额
 */
const FLOW_COLUMNS = ['seq', 'code', 'name', 'price', 'changePct', 'turnover', 'inflow', 'outflow', 'net', 'amount', 'bigNet']

const thsFundflow = {
  id: 'ths-fundflow',
  name: '同花顺资金流',
  category: 'flow',
  region: 'CN',
  tier: 'A-',
  capability: ['list'],
  homepage: 'https://data.10jqka.com.cn/funds/ggzjl/',
  note: '同花顺个股资金流排行（GBK 页面，按净额降序；页面每日更新）',
  needsKey: false,
  rateLimit: { perMinute: 15 },
  timeoutMs: 12000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 40)
    const res = await ctx.request(THS_FLOW, {
      charset: 'gbk',
      headers: { ...BROWSER, accept: 'text/html,application/xhtml+xml' },
      referer: 'https://data.10jqka.com.cn/',
      timeoutMs: 9000,
    })
    if (!res.ok) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const html = String(res.text || '')
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []
    const items = []
    for (const row of rows) {
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map((cell) => stripTags(cell))
      if (cells.length < 8) continue
      const codeIndex = cells.findIndex((cell) => /^\d{6}$/.test(cell))
      if (codeIndex < 0) continue
      const raw = {}
      for (let i = 0; i < FLOW_COLUMNS.length; i += 1) raw[FLOW_COLUMNS[i]] = cells[codeIndex - 1 + i] || ''
      const code = raw.code
      const name = raw.name
      const price = Number(raw.price)
      const changePct = Number(String(raw.changePct || '').replace('%', ''))
      const turnover = Number(String(raw.turnover || '').replace('%', ''))
      const inflow = cnAmount(raw.inflow)
      const outflow = cnAmount(raw.outflow)
      const net = cnAmount(raw.net)
      const amount = cnAmount(raw.amount)
      const bigNet = cnAmount(raw.bigNet)
      const bits = []
      if (Number.isFinite(turnover)) bits.push('换手 ' + turnover.toFixed(2) + '%')
      if (net !== null) bits.push('净额 ' + humanAmount(net))
      if (inflow !== null && outflow !== null) bits.push('流入 ' + humanAmount(inflow) + ' / 流出 ' + humanAmount(outflow))
      if (bigNet !== null) bits.push('大单净额 ' + humanAmount(bigNet))
      if (amount !== null) bits.push('成交 ' + humanAmount(amount))
      items.push({
        id: 'ths-flow:' + code,
        title: name + '（' + code + '）' + (Number.isFinite(changePct) ? ' ' + changePct.toFixed(2) + '%' : '') + (Number.isFinite(price) ? ' · ' + price.toFixed(2) : ''),
        url: 'https://stockpage.10jqka.com.cn/' + code + '/',
        publishedAt: null,
        summary: bits.join(' · '),
        tags: ['资金流', code],
        payload: {
          code,
          name,
          price: Number.isFinite(price) ? price : null,
          changePct: Number.isFinite(changePct) ? changePct : null,
          turnover: Number.isFinite(turnover) ? turnover : null,
          inflow,
          outflow,
          net,
          amount,
          bigNet,
        },
      })
      if (items.length >= limit) break
    }
    return { items, meta: { total: items.length, endpoint: 'funds/ggzjl', updated: 'daily' } }
  },
}

export const adapters = [thsLive, sinaLive, emReport, thsFundflow]
