/**
 * Prediction markets: event-contract probabilities.
 *
 * Four public read APIs — Polymarket (Gamma), Kalshi, Manifold and Metaculus.
 * None of them needs a key except Metaculus (token in METACULUS_TOKEN).
 *
 * Reachability note: these hosts are frequently blocked from mainland networks
 * (TCP timeouts, not HTTP errors). The adapters therefore fail soft with the
 * concrete reason in `meta.error`, and the health panel shows it, instead of
 * pretending the market has no events.
 */

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json, text/javascript, */*',
}

function limitOf(params, fallback) {
  const n = Number(params && params.limit)
  return Math.min(Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback, 60)
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Parse a JSON-encoded field only when it is actually a string. */
function parseMaybeJson(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Polymarket prices are dollars per share; 0.62 -> "62¢". */
function cents(price) {
  const n = num(price)
  return n === null ? '—' : Math.round(n * 100) + '¢'
}

function pct(value, digits) {
  const n = num(value)
  if (n === null) return '—'
  const p = n <= 1 ? n * 100 : n
  return p.toFixed(digits === undefined ? 1 : digits) + '%'
}

function humanMoney(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toFixed(0)
}

// ---------------------------------------------------------------- Polymarket

const polymarket = {
  id: 'polymarket',
  name: 'Polymarket',
  category: 'prediction',
  region: 'GLOBAL',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://polymarket.com',
  note: '事件合约概率（Gamma 公开接口）；本机网络常被墙，失败会写明原因',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 10000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 20)
    const url =
      'https://gamma-api.polymarket.com/events?limit=' + limit +
      '&active=true&closed=false&order=volume24hr&ascending=false'
    const res = await ctx.getJson(url, { headers: BROWSER, timeoutMs: 7000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error), blocked: res.status === 0 } }
    const events = Array.isArray(res.json) ? res.json : []
    const items = []
    for (const event of events.slice(0, limit)) {
      const markets = Array.isArray(event.markets) ? event.markets : []
      const primary = markets[0] || null
      const outcomes = primary ? parseMaybeJson(primary.outcomes) : null
      const prices = primary ? parseMaybeJson(primary.outcomePrices) : null
      const yes = outcomes && prices && outcomes.length === prices.length ? outcomes.indexOf('Yes') : -1
      const probability = yes >= 0 ? prices[yes] : primary && primary.lastTradePrice !== undefined ? primary.lastTradePrice : null
      items.push({
        id: 'polymarket:' + String(event.id || event.slug || ''),
        title: String(event.title || '').slice(0, 180) + (probability !== null ? ' · Yes ' + cents(probability) : ''),
        url: event.slug ? 'https://polymarket.com/event/' + event.slug : 'https://polymarket.com',
        publishedAt: num(event.startDate ? Date.parse(event.startDate) : null),
        summary:
          '24h 成交 ' + humanMoney(event.volume24hr) + ' · 总成交 ' + humanMoney(event.volume) +
          ' · 流动性 ' + humanMoney(event.liquidity) +
          (markets.length > 1 ? ' · ' + markets.length + ' 个合约' : ''),
        tags: ['预测市场', 'Polymarket'],
        payload: {
          slug: String(event.slug || ''),
          probability: num(probability),
          volume24h: num(event.volume24hr),
          liquidity: num(event.liquidity),
          markets: markets.length,
        },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'gamma/events' } }
  },
}

// ---------------------------------------------------------------- Kalshi

const kalshi = {
  id: 'kalshi',
  name: 'Kalshi',
  category: 'prediction',
  region: 'US',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://kalshi.com',
  note: '美国合规事件合约（公开 read API）；本机网络常不可达',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 8000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 20)
    const url = 'https://api.elections.kalshi.com/trade-api/v2/markets?limit=' + limit + '&status=open'
    const res = await ctx.getJson(url, { headers: BROWSER, timeoutMs: 6000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error), blocked: res.status === 0 } }
    const rows = res.json && Array.isArray(res.json.markets) ? res.json.markets : []
    const items = []
    for (const row of rows.slice(0, limit)) {
      const ticker = String(row.ticker || '')
      const last = num(row.last_price)
      const yesBid = num(row.yes_bid)
      const price = last !== null ? last : yesBid
      items.push({
        id: 'kalshi:' + ticker,
        title: String(row.title || row.subtitle || ticker).slice(0, 180) + (price !== null ? ' · Yes ' + cents(price) : ''),
        url: ticker ? 'https://kalshi.com/markets/' + ticker : 'https://kalshi.com',
        publishedAt: num(row.close_time ? Date.parse(row.close_time) : null),
        summary:
          '成交 ' + humanMoney(row.volume) + ' · 持仓 ' + humanMoney(row.open_interest) +
          (row.close_time ? ' · 到期 ' + String(row.close_time).slice(0, 10) : ''),
        tags: ['预测市场', 'Kalshi'],
        payload: {
          ticker: ticker,
          price: price,
          yesBid: yesBid,
          volume: num(row.volume),
          openInterest: num(row.open_interest),
          closeTime: row.close_time || '',
        },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'kalshi/v2/markets' } }
  },
}

// ---------------------------------------------------------------- Manifold

const manifold = {
  id: 'manifold',
  name: 'Manifold',
  category: 'prediction',
  region: 'GLOBAL',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://manifold.markets',
  note: '社区预测市场（虚拟积分）；本机网络常不可达',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 10000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 20)
    const url = 'https://api.manifold.markets/v0/markets?limit=' + limit
    const res = await ctx.getJson(url, { headers: BROWSER, timeoutMs: 7000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error), blocked: res.status === 0 } }
    const rows = Array.isArray(res.json) ? res.json : []
    const items = []
    for (const row of rows.slice(0, limit)) {
      if (row.isResolved === true) continue
      const probability = num(row.probability)
      items.push({
        id: 'manifold:' + String(row.id || ''),
        title: String(row.question || '').slice(0, 180) + (probability !== null ? ' · ' + pct(probability) : ''),
        url: String(row.url || (row.id ? 'https://manifold.markets/m/' + row.id : 'https://manifold.markets')),
        publishedAt: num(row.createdTime),
        summary:
          '成交 ' + humanMoney(row.volume) + ' · 交易者 ' + (row.uniqueBettorCount === undefined ? '—' : String(row.uniqueBettorCount)) +
          (row.closeTime ? ' · 到期 ' + new Date(row.closeTime).toISOString().slice(0, 10) : ''),
        tags: ['预测市场', 'Manifold'],
        payload: {
          probability: probability,
          volume: num(row.volume),
          bettors: num(row.uniqueBettorCount),
          outcomeType: String(row.outcomeType || ''),
        },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'manifold/v0/markets' } }
  },
}

// ---------------------------------------------------------------- Metaculus

const metaculus = {
  id: 'metaculus',
  name: 'Metaculus',
  category: 'prediction',
  region: 'GLOBAL',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://www.metaculus.com',
  note: '预测聚合（2026 起 API 需要 token，配 METACULUS_TOKEN 后可用）',
  needsKey: true,
  keyEnv: 'METACULUS_TOKEN',
  rateLimit: { perMinute: 10 },
  timeoutMs: 15000,
  async fetch(ctx, params) {
    const token = process.env.METACULUS_TOKEN || ''
    if (!token) return { items: [], meta: { error: 'missing METACULUS_TOKEN' } }
    const limit = limitOf(params, 20)
    const url = 'https://www.metaculus.com/api2/questions/?limit=' + limit + '&order_by=-activity'
    const res = await ctx.getJson(url, {
      headers: Object.assign({}, BROWSER, { authorization: 'Token ' + token }),
      timeoutMs: 12000,
    })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const rows = res.json && Array.isArray(res.json.results) ? res.json.results : []
    const items = []
    for (const row of rows.slice(0, limit)) {
      const cp = row.community_prediction && row.community_prediction.full
      const q2 = cp && cp.q2
      const probability = q2 === undefined ? null : Number(q2)
      items.push({
        id: 'metaculus:' + String(row.id || ''),
        title: String(row.title || '').slice(0, 180) + (probability !== null ? ' · 社区 ' + pct(probability) : ''),
        url: row.id ? 'https://www.metaculus.com/questions/' + row.id + '/' : 'https://www.metaculus.com',
        publishedAt: num(row.publish_time ? Date.parse(row.publish_time) : null),
        summary:
          '预测者 ' + (row.number_of_forecasters === undefined ? '—' : String(row.number_of_forecasters)) +
          (row.close_time ? ' · 截止 ' + String(row.close_time).slice(0, 10) : ''),
        tags: ['预测市场', 'Metaculus'],
        payload: { probability: probability, forecasters: num(row.number_of_forecasters) },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'metaculus/api2/questions' } }
  },
}

export const adapters = [polymarket, kalshi, manifold, metaculus]


