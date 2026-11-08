/**
 * Shipping: the dry-bulk freight benchmark and sea state at the chokepoints.
 *
 * BDI comes from Eastmoney's global-index quote (`100.BDI`), which mirrors the
 * Baltic Exchange daily print. Sea state comes from Open-Meteo Marine (free, no key)
 * — wave height at the straits that actually move commodity prices.
 */

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json, text/javascript, */*',
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Eastmoney quotes indices scaled by 100. */
function scaled(value) {
  const n = num(value)
  return n === null ? null : n / 100
}

// ---------------------------------------------------------------- BDI

const bdi = {
  id: 'bdi',
  name: '波罗的海干散货指数',
  category: 'shipping',
  region: 'GLOBAL',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://quote.eastmoney.com/center/gridlist.html#globalindex',
  note: 'BDI 干散货运价锚，全球大宗商品海运成本的风向标（东财指数行情）',
  needsKey: false,
  rateLimit: { perMinute: 30 },
  timeoutMs: 10000,
  async fetch(ctx) {
    const url =
      'https://push2.eastmoney.com/api/qt/stock/get?secid=100.BDI&fields=f57,f58,f43,f44,f45,f46,f60,f86,f169,f170'
    const res = await ctx.getJson(url, { headers: BROWSER, referer: 'https://quote.eastmoney.com/', timeoutMs: 8000 })
    const data = res.ok && res.json && res.json.data
    if (!data) return { items: [], meta: { error: 'http ' + (res.status || res.error) + ' (no quote payload)' } }
    const price = scaled(data.f43)
    const prev = scaled(data.f60)
    const change = scaled(data.f169)
    const changePct = scaled(data.f170)
    if (price === null) return { items: [], meta: { error: 'BDI quote empty' } }
    const at = num(data.f86)
    const item = {
      id: 'bdi:latest',
      title: '波罗的海BDI指数 ' + price.toFixed(1) + ' ' + (changePct === null ? '' : (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%'),
      url: 'https://quote.eastmoney.com/center/gridlist.html#globalindex',
      publishedAt: at ? at * 1000 : Date.now(),
      summary:
        '前值 ' + (prev === null ? '—' : prev.toFixed(1)) +
        ' · 涨跌 ' + (change === null ? '—' : (change >= 0 ? '+' : '') + change.toFixed(1)) +
        ' · 干散货运价锚，直接映射铁矿石/煤炭/粮食的海运成本',
      tags: ['航运', 'BDI', '干散货'],
      payload: {
        symbol: 'BDI',
        name: String(data.f58 || '波罗的海BDI指数'),
        price: price,
        prevClose: prev,
        change: change,
        changePct: changePct,
      },
    }
    return { items: [item], meta: { total: 1, endpoint: 'em/100.BDI' } }
  },
}

// ---------------------------------------------------------------- 海峡浪高

const CHOKEPOINTS = [
  { id: 'malacca', name: '马六甲海峡', lat: 1.35, lon: 103.8 },
  { id: 'suez', name: '苏伊士运河', lat: 30.0, lon: 32.5 },
  { id: 'panama', name: '巴拿马运河', lat: 9.0, lon: -79.5 },
  { id: 'cape', name: '好望角', lat: -34.4, lon: 18.5 },
  { id: 'shanghai', name: '上海外海', lat: 31.2, lon: 122.0 },
  { id: 'rotterdam', name: '鹿特丹外海', lat: 51.95, lon: 4.1 },
]

function maxOf(list) {
  let best = null
  for (const value of list || []) {
    const n = num(value)
    if (n === null) continue
    if (best === null || n > best) best = n
  }
  return best
}

const marine = {
  id: 'marine',
  name: '海峡海况',
  category: 'shipping',
  region: 'GLOBAL',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://open-meteo.com/en/docs/marine-weather-api',
  note: '主要海峡与港口的未来 24h 浪高（Open-Meteo Marine，免费），用于判断航路是否受阻',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 14000,
  async fetch(ctx) {
    const lat = CHOKEPOINTS.map((p) => p.lat).join(',')
    const lon = CHOKEPOINTS.map((p) => p.lon).join(',')
    const url =
      'https://marine-api.open-meteo.com/v1/marine?latitude=' + lat + '&longitude=' + lon +
      '&hourly=wave_height,wind_wave_height&forecast_days=1&timezone=Asia%2FShanghai'
    const res = await ctx.getJson(url, { headers: BROWSER, timeoutMs: 12000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const payloads = Array.isArray(res.json) ? res.json : [res.json]
    const items = []
    for (let i = 0; i < payloads.length && i < CHOKEPOINTS.length; i += 1) {
      const spot = CHOKEPOINTS[i]
      const hourly = payloads[i] && payloads[i].hourly
      if (!hourly) continue
      const waves = Array.isArray(hourly.wave_height) ? hourly.wave_height.slice(0, 24) : []
      const windWaves = Array.isArray(hourly.wind_wave_height) ? hourly.wind_wave_height.slice(0, 24) : []
      const peak = maxOf(waves)
      if (peak === null) continue
      const now = waves.find((value) => num(value) !== null)
      items.push({
        id: 'marine:' + spot.id,
        title: spot.name + ' 浪高 ' + Number(now).toFixed(1) + 'm（未来24h 最高 ' + peak.toFixed(1) + 'm）',
        url: 'https://open-meteo.com/en/docs/marine-weather-api',
        publishedAt: Date.now(),
        summary:
          '风浪 ' + (maxOf(windWaves) === null ? '—' : maxOf(windWaves).toFixed(1) + 'm') +
          ' · 经纬 ' + spot.lat + ',' + spot.lon +
          ' · 浪高 >4m 通常意味着航速下降与运价上行',
        tags: ['航运', '海况', spot.name],
        payload: {
          spot: spot.id,
          name: spot.name,
          lat: spot.lat,
          lon: spot.lon,
          waveNow: num(now),
          wavePeak24h: peak,
          windWavePeak24h: maxOf(windWaves),
        },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'open-meteo/marine' } }
  },
}

export const adapters = [bdi, marine]
