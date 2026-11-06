import { fetchText, postText } from './net.mjs'

/**
 * Market data module: public quote endpoints with a batched primary provider
 * (TradingView scanner), regional provider (Tencent), and fallbacks
 * (Yahoo chart, CoinGecko). Requests are cached by the service layer; providers
 * run in order and only ask for the symbols they can serve, so a normal refresh
 * is usually ONE batched HTTP call.
 */
export const DEFAULT_WATCHLIST = [
  { id: 'spx', label: '标普500', tv: 'SP:SPX', yahoo: '^GSPC', em: '100.SPX', currency: 'USD' },
  { id: 'ndx', label: '纳斯达克100', tv: 'NASDAQ:NDX', yahoo: '^NDX', em: '100.NDX', currency: 'USD' },
  { id: 'dji', label: '道琼斯', tv: 'DJ:DJI', yahoo: '^DJI', em: '100.DJIA', currency: 'USD' },
  { id: 'hsi', label: '恒生指数', tv: 'TVC:HSI', yahoo: '^HSI', tencent: 'hkHSI', em: '100.HSI', currency: 'HKD' },
  { id: 'sse', label: '上证指数', tencent: 'sh000001', tv: 'SSE:000001', yahoo: '000001.SS', em: '1.000001', currency: 'CNY' },
  { id: 'szse', label: '深证成指', tencent: 'sz399001', tv: 'SZSE:399001', yahoo: '399001.SZ', em: '0.399001', currency: 'CNY' },
  { id: 'n225', label: '日经225', tv: 'TVC:NI225', yahoo: '^N225', em: '100.N225', currency: 'JPY' },
  { id: 'dxy', label: '美元指数', tv: 'TVC:DXY', yahoo: 'DX-Y.NYB', em: '100.UDI', currency: '' },
  { id: 'eurusd', label: 'EUR/USD', tv: 'FX:EURUSD', yahoo: 'EURUSD=X', em: '119.EURUSD', currency: '' },
  { id: 'usdcny', label: 'USD/CNY', tv: 'FX_IDC:USDCNY', yahoo: 'USDCNY=X', em: '133.USDCNH', currency: 'CNY' },
  { id: 'us10y', label: '美债10Y', tv: 'TVC:US10Y', yahoo: '^TNX', currency: '%' },
  { id: 'gold', label: '黄金', tv: 'TVC:GOLD', yahoo: 'GC=F', em: '101.GC00Y', currency: 'USD' },
  { id: 'oil', label: 'WTI 原油', tv: 'NYMEX:CL1!', yahoo: 'CL=F', em: '102.CL00Y', currency: 'USD' },
  { id: 'btc', label: 'BTC', tv: 'BITSTAMP:BTCUSD', yahoo: 'BTC-USD', coingecko: 'bitcoin', okx: 'BTC-USDT', currency: 'USD' },
  { id: 'eth', label: 'ETH', tv: 'BITSTAMP:ETHUSD', yahoo: 'ETH-USD', coingecko: 'ethereum', okx: 'ETH-USDT', currency: 'USD' },
  { id: 'aapl', label: 'AAPL', tv: 'NASDAQ:AAPL', yahoo: 'AAPL', em: '105.AAPL', currency: 'USD' },
]

const TV_COLUMNS = ['close', 'change', 'change_abs', 'volume', 'open', 'high', 'low', 'prev_close', 'name', 'description']

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
function quoteOf(item, price, changePct, changeAbs, volume, source, extra) {
  const e = extra || {}
  const prev = e.prevClose !== undefined && e.prevClose !== null ? e.prevClose : price !== null && changeAbs !== null ? price - changeAbs : null
  let pct = changePct
  if (pct === null && prev !== null && prev !== 0) pct = ((price - prev) / prev) * 100
  return {
    id: item.id,
    label: item.label,
    symbol: item.tv || item.tencent || item.yahoo || item.coingecko || item.id,
    price: price,
    changePct: pct === null ? null : Math.round(pct * 100) / 100,
    changeAbs: changeAbs === null ? null : Math.round(changeAbs * 10000) / 10000,
    volume: volume,
    open: e.open === undefined ? null : e.open,
    high: e.high === undefined ? null : e.high,
    low: e.low === undefined ? null : e.low,
    prevClose: prev,
    currency: item.currency || '',
    source: source,
    ts: Date.now(),
  }
}

/** Parse a TradingView scanner response into id -> quote. */
export function parseTradingViewScanner(text, items) {
  const out = new Map()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return out
  }
  const rows = Array.isArray(payload && payload.data) ? payload.data : []
  const byTicker = new Map(items.filter((i) => i.tv).map((i) => [i.tv.toUpperCase(), i]))
  for (const row of rows) {
    const item = byTicker.get(String(row.s || '').toUpperCase())
    if (!item) continue
    const d = Array.isArray(row.d) ? row.d : []
    out.set(item.id, quoteOf(item, num(d[0]), num(d[1]), num(d[2]), num(d[3]), 'tradingview', { open: num(d[4]), high: num(d[5]), low: num(d[6]), prevClose: num(d[7]) }))
  }
  return out
}

/** Parse Tencent qt.gtimg.cn batch payload: v_sh000001="..." */
export function parseTencentQuotes(text, items) {
  const out = new Map()
  const src = String(text || '')
  for (const item of items) {
    if (!item.tencent) continue
    const code = item.tencent.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
    const m = src.match(new RegExp('v_' + code + '="([^"]*)"'))
    if (!m) continue
    const parts = m[1].split('~')
    const price = num(parts[3])
    const prev = num(parts[4])
    let changeAbs = num(parts[31])
    let changePct = num(parts[32])
    if (changePct === null && price !== null && prev !== null && prev !== 0) changePct = ((price - prev) / prev) * 100
    if (changeAbs === null && price !== null && prev !== null) changeAbs = price - prev
    if (price === null) continue
    out.set(item.id, quoteOf(item, price, changePct, changeAbs, num(parts[6]), 'tencent'))
  }
  return out
}

/** Parse a Yahoo Finance chart payload. */
export function parseYahooChart(text, item) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  const meta = payload && payload.chart && payload.chart.result && payload.chart.result[0] && payload.chart.result[0].meta
  if (!meta) return null
  const price = num(meta.regularMarketPrice)
  if (price === null) return null
  const prev = num(meta.chartPreviousClose) !== null ? num(meta.chartPreviousClose) : num(meta.previousClose)
  const changeAbs = prev !== null ? price - prev : null
  const changePct = prev !== null && prev !== 0 ? ((price - prev) / prev) * 100 : null
  return quoteOf(item, price, changePct, changeAbs, num(meta.regularMarketVolume), 'yahoo')
}

/** Parse CoinGecko simple/price payload. */
export function parseCoingecko(text, items) {
  const out = new Map()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return out
  }
  for (const item of items) {
    if (!item.coingecko || !payload[item.coingecko]) continue
    const row = payload[item.coingecko]
    const price = num(row.usd)
    if (price === null) continue
    out.set(item.id, quoteOf(item, price, num(row.usd_24h_change), null, null, 'coingecko'))
  }
  return out
}

let yahooNextAt = 0
let scannerNextAt = 0

async function paceYahoo() {
  const wait = Math.max(0, yahooNextAt - Date.now())
  yahooNextAt = Math.max(Date.now(), yahooNextAt) + 1200
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}
async function paceScanner() {
  const wait = Math.max(0, scannerNextAt - Date.now())
  scannerNextAt = Math.max(Date.now(), scannerNextAt) + 2500
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

function networkOptions(options, timeoutMs) {
  const o = options || {}
  return {
    proxy: o.proxy,
    proxies: o.proxies,
    retries: o.retries,
    rotateUA: o.rotateUA,
    minIntervalMs: o.minIntervalMs,
    timeoutMs: timeoutMs,
  }
}

/** Provider registry. Each provider serves only items carrying its symbol field. */
export const PROVIDERS = [
  {
    name: 'tradingview',
    supports: (item) => Boolean(item.tv),
    async fetch(items, options) {
      await paceScanner()
      const body = JSON.stringify({
        symbols: { tickers: items.map((i) => i.tv).slice(0, 50), query: { types: [] } },
        columns: TV_COLUMNS,
      })
      const r = await postText('https://scanner.tradingview.com/global/scan', body, Object.assign(networkOptions(options, 15000), { contentType: 'application/json' }))
      if (r.status !== 200 || r.blocked) throw new Error('HTTP ' + r.status)
      return parseTradingViewScanner(r.text, items)
    },
  },
  {
    name: 'tencent',
    supports: (item) => Boolean(item.tencent),
    async fetch(items, options) {
      const url = 'https://qt.gtimg.cn/q=' + items.map((i) => i.tencent).join(',')
      const r = await fetchText(url, networkOptions(options, 12000))
      if (r.status !== 200 || r.blocked) throw new Error('HTTP ' + r.status)
      return parseTencentQuotes(r.text, items)
    },
  },
  {
    name: 'yahoo',
    supports: (item) => Boolean(item.yahoo),
    async fetch(items, options) {
      const out = new Map()
      for (const item of items) {
        try {
          const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(item.yahoo) + '?range=1d&interval=1d'
          const r = await fetchText(url, networkOptions(options, 12000))
          if (r.status !== 200 || r.blocked) continue
          const quote = parseYahooChart(r.text, item)
          if (quote) out.set(item.id, quote)
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      return out
    },
  },
  {
    name: 'coingecko',
    supports: (item) => Boolean(item.coingecko),
    async fetch(items, options) {
      const ids = items.map((i) => i.coingecko).join(',')
      const url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + encodeURIComponent(ids) + '&vs_currencies=usd&include_24hr_change=true'
      const r = await fetchText(url, networkOptions(options, 12000))
      if (r.status !== 200 || r.blocked) throw new Error('HTTP ' + r.status)
      return parseCoingecko(r.text, items)
    },
  },
]

/**
 * Fetch quotes for a watchlist. Providers run in order; the loop stops once all
 * symbols are filled. Inject options.providers in tests for deterministic runs.
 */
export async function fetchQuotes(watchlist, options) {
  const opts = options || {}
  const items = Array.isArray(watchlist) && watchlist.length ? watchlist : DEFAULT_WATCHLIST
  const providers = Array.isArray(opts.providers) && opts.providers.length ? opts.providers : PROVIDERS
  const remaining = new Map(items.map((item) => [item.id, item]))
  const collected = new Map()
  const sources = []
  for (const provider of providers) {
    const targets = Array.from(remaining.values()).filter((item) => {
      try {
        return provider.supports(item)
      } catch {
        return false
      }
    })
    if (targets.length === 0) continue
    const started = Date.now()
    try {
      const got = await provider.fetch(targets, opts)
      for (const [id, quote] of got) {
        if (!remaining.has(id)) continue
        collected.set(id, quote)
        remaining.delete(id)
      }
      sources.push({ name: provider.name, ok: got.size > 0, count: got.size, ms: Date.now() - started, error: got.size ? '' : 'no quotes' })
    } catch (error) {
      sources.push({ name: provider.name, ok: false, count: 0, ms: Date.now() - started, error: String(error && error.message ? error.message : error) })
    }
    if (remaining.size === 0) break
  }
  return {
    quotes: items.map((item) => collected.get(item.id)).filter(Boolean),
    missing: Array.from(remaining.keys()),
    sources: sources,
    fetchedAt: Date.now(),
  }
}

// ---------- history / charts ----------
export const HISTORY_RANGES = ['1d', '5d', '1mo', '3mo', '1y']
const YAHOO_RANGE = {
  '1d': { range: '1d', interval: '5m' },
  '5d': { range: '5d', interval: '15m' },
  '1mo': { range: '1mo', interval: '1d' },
  '3mo': { range: '3mo', interval: '1d' },
  '1y': { range: '1y', interval: '1d' },
}

function pointsOf(timestamps, closes) {
  const points = []
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) return points
  for (let i = 0; i < timestamps.length; i += 1) {
    const price = num(closes[i])
    const t = Number(timestamps[i])
    if (price === null || !Number.isFinite(t)) continue
    points.push({ t: t * 1000, price: price })
  }
  return points
}
function seriesOf(points) {
  let high = null
  let low = null
  for (const p of points) {
    if (high === null || p.price > high) high = p.price
    if (low === null || p.price < low) low = p.price
  }
  return { points: points, high: high, low: low }
}

/** Parse a Yahoo spark multi-symbol payload into id -> points. */
export function parseYahooSpark(text, items) {
  const out = new Map()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return out
  }
  const rows = payload && payload.spark && Array.isArray(payload.spark.result) ? payload.spark.result : []
  const bySymbol = new Map(items.filter((i) => i.yahoo).map((i) => [String(i.yahoo).toUpperCase(), i]))
  for (const row of rows) {
    const item = bySymbol.get(String(row.symbol || '').toUpperCase())
    if (!item) continue
    const response = Array.isArray(row.response) && row.response.length ? row.response[0] : null
    if (!response) continue
    const quote = response.indicators && response.indicators.quote && response.indicators.quote[0]
      ? response.indicators.quote[0]
      : {}
    const points = pointsOf(response.timestamp, quote.close)
    if (points.length > 1) out.set(item.id, points)
  }
  return out
}

/** Parse a Yahoo v8 chart payload into points + meta. */
export function parseYahooChartSeries(text) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  const result = payload && payload.chart && payload.chart.result && payload.chart.result[0]
  if (!result || !Array.isArray(result.timestamp)) return null
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0] ? result.indicators.quote[0] : {}
  const points = pointsOf(result.timestamp, quote.close)
  if (points.length < 2) return null
  return {
    points: points,
    prevClose: num(result.meta && result.meta.chartPreviousClose),
    price: num(result.meta && result.meta.regularMarketPrice),
  }
}

/** Parse the Tencent minute payload (A-share fallback) into points. */
export function parseTencentMinute(text, code) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  const row = payload && payload.data && payload.data[code] && payload.data[code].data
  if (!row || !Array.isArray(row.data)) return null
  const day = String(row.date || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')
  const points = []
  for (const line of row.data) {
    const parts = String(line).split(' ')
    const hhmm = parts[0]
    const price = num(parts[1])
    if (!hhmm || price === null) continue
    const hh = hhmm.slice(0, 2)
    const mm = hhmm.slice(2, 4)
    const t = Date.parse(day + 'T' + hh + ':' + mm + ':00+08:00')
    if (!Number.isFinite(t)) continue
    points.push({ t: t, price: price })
  }
  return points.length > 1 ? points : null
}

function historyNetOptions(options, timeoutMs) {
  const o = options || {}
  return {
    proxy: o.proxy,
    proxies: o.proxies,
    retries: 0,
    rotateUA: o.rotateUA,
    minIntervalMs: o.minIntervalMs,
    timeoutMs: timeoutMs || 6000,
  }
}

/**
 * One batched Yahoo spark request for intraday (1d) series of many symbols,
 * with Tencent minute fallback for CN indices when spark misses them.
 */
export async function fetchIntradaySeries(items, options) {
  const opts = options || {}
  const targets = items.filter((i) => i.yahoo)
  const out = new Map()
  let source = ''
  if (targets.length) {
    const symbols = targets.map((i) => i.yahoo).join(',')
    const sparkUrl = 'https://query1.finance.yahoo.com/v7/finance/spark?symbols=' + encodeURIComponent(symbols) + '&range=1d&interval=5m'
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await paceYahoo()
      const r = await fetchText(sparkUrl, historyNetOptions(opts, 7000))
      if (r.status === 200 && !r.blocked) {
        const map = parseYahooSpark(r.text, targets)
        for (const [id, points] of map) out.set(id, points)
        source = 'yahoo'
        break
      }
      if (r.status === 429 || r.blocked) await new Promise((resolve) => setTimeout(resolve, 2800))
    }
  }
  for (const item of items) {
    if (out.has(item.id) || !item.tencent) continue
    try {
      const r = await fetchText('https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=' + encodeURIComponent(item.tencent), historyNetOptions(opts, 12000))
      if (r.status !== 200 || r.blocked) continue
      const points = parseTencentMinute(r.text, item.tencent)
      if (points) { out.set(item.id, points); source = source ? source + '+tencent' : 'tencent' }
    } catch {}
  }
  return { points: out, source: source }
}


let emNextAt = 0
async function paceEm() {
  const wait = Math.max(0, emNextAt - Date.now())
  emNextAt = Math.max(Date.now(), emNextAt) + 450
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

const EM_KLT = {
  '1d': { klt: '5', limit: 240 },
  '5d': { klt: '15', limit: 300 },
  '1mo': { klt: '101', limit: 30 },
  '3mo': { klt: '101', limit: 90 },
  '1y': { klt: '101', limit: 250 },
}

/** Parse Eastmoney kline bars (f51 datetime, f52 open, f53 close, f54 high, f55 low). */
export function parseEastmoneyKlines(text) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  const rows = payload && payload.data && Array.isArray(payload.data.klines) ? payload.data.klines : []
  const points = []
  for (const row of rows) {
    const parts = String(row).split(',')
    const stamp = String(parts[0] || '').trim()
    const price = num(parts[2])
    if (!stamp || price === null) continue
    const iso = stamp.replace(' ', 'T')
    const t = Date.parse(iso.length <= 10 ? iso + 'T00:00:00' : iso)
    if (!Number.isFinite(t)) continue
    points.push({ t: t, price: price })
  }
  return points.length > 1 ? points : null
}

async function fetchEastmoneyHistory(item, range, options) {
  if (!item.em) return null
  const spec = EM_KLT[range] || EM_KLT['1d']
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + encodeURIComponent(item.em) + '&klt=' + spec.klt + '&fqt=1&lmt=' + spec.limit + '&end=20500101&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await paceEm()
    try {
      const r = await fetchText(url, historyNetOptions(options, 12000))
      if (r.status === 200 && !r.blocked) {
        const points = parseEastmoneyKlines(r.text)
        if (points) return Object.assign(seriesOf(points), { id: item.id, range: range, source: 'eastmoney' })
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  return null
}

const OKX_BAR = { '1d': '5m', '5d': '15m', '1mo': '1D', '3mo': '1D', '1y': '1D' }

/** Parse OKX candles (newest first: [ts, open, high, low, close, ...]). */
export function parseOkxCandles(text) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  const rows = payload && Array.isArray(payload.data) ? payload.data : []
  const points = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const t = Number(row[0])
    const price = num(row[4])
    if (!Number.isFinite(t) || price === null) continue
    points.push({ t: t, price: price })
  }
  points.sort((a, b) => a.t - b.t)
  return points.length > 1 ? points : null
}

async function fetchOkxHistory(item, range, options) {
  if (!item.okx) return null
  const bar = OKX_BAR[range] || '5m'
  const url = 'https://www.okx.com/api/v5/market/candles?instId=' + encodeURIComponent(item.okx) + '&bar=' + bar + '&limit=300'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await paceEm()
    try {
      const r = await fetchText(url, historyNetOptions(options, 12000))
      if (r.status === 200 && !r.blocked) {
        const points = parseOkxCandles(r.text)
        if (points) return Object.assign(seriesOf(points), { id: item.id, range: range, source: 'okx' })
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return null
}

const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']

async function fetchYahooChart(item, spec, options) {
  if (!item.yahoo) return null
  const hosts = YAHOO_HOSTS
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const host = hosts[attempt % hosts.length]
    await paceYahoo()
    try {
      const url = 'https://' + host + '/v8/finance/chart/' + encodeURIComponent(item.yahoo) + '?range=' + spec.range + '&interval=' + spec.interval
      const r = await fetchText(url, historyNetOptions(options, 10000))
      if (r.status === 200 && !r.blocked) {
        const parsed = parseYahooChartSeries(r.text)
        if (parsed) return parsed
      }
      if (r.status === 429 || r.blocked) await new Promise((resolve) => setTimeout(resolve, 1500))
      else await new Promise((resolve) => setTimeout(resolve, 350))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  return null
}

/** Fetch one symbol's series for a range; 1d uses the batched spark path. */
export async function fetchHistory(item, range, options) {
  const opts = options || {}
  const target = YAHOO_RANGE[range] ? range : '1d'
  const em = await fetchEastmoneyHistory(item, target, opts)
  if (em) return em
  const okx = await fetchOkxHistory(item, target, opts)
  if (okx) return okx
  if (target === '1d' && item.yahoo) {
    const intraday = await fetchIntradaySeries([item], opts)
    const points = intraday.points.get(item.id)
    if (points) return Object.assign(seriesOf(points), { id: item.id, range: target, source: intraday.source || 'yahoo' })
  }
  const spec = YAHOO_RANGE[target]
  const parsed = await fetchYahooChart(item, spec, opts)
  if (!parsed) return null
  return Object.assign(seriesOf(parsed.points), {
    id: item.id,
    range: target,
    source: 'yahoo',
    prevClose: parsed.prevClose,
    price: parsed.price,
  })
}
