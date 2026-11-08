/**
 * World monitor: geopolitics, natural hazards (satellite/agency event feeds) and
 * weather that actually moves commodity and shipping markets.
 *
 * All three are free, key-less public APIs.
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

function limitOf(params, fallback) {
  const n = Number(params && params.limit)
  return Math.min(Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback, 60)
}

// ---------------------------------------------------------------- GDELT 地缘

/** GDELT stamps are `YYYYMMDDTHHMMSSZ`. */
function gdeltTime(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(raw || ''))
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

const gdelt = {
  id: 'gdelt',
  name: 'GDELT 全球事件',
  category: 'geo',
  region: 'GLOBAL',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://www.gdeltproject.org/',
  note: '全球冲突 / 制裁 / 战争相关报道（GDELT DOC 公开 API）；该接口较慢且限流，返回条数已压到 25',
  needsKey: false,
  rateLimit: { perMinute: 3 },
  timeoutMs: 24000,
  async fetch(ctx, params) {
    const limit = Math.min(limitOf(params, 20), 25)
    const keyword = String((params && params.q) || '"armed conflict" OR "military strike" OR sanctions OR war OR 制裁 OR 冲突')
    // GDELT rejects bare OR chains: the terms must be parenthesised.
    const query = '(' + keyword + ')'
    const url =
      'https://api.gdeltproject.org/api/v2/doc/doc?query=' + encodeURIComponent(query) +
      '&mode=artlist&maxrecords=' + limit + '&format=json&sort=datedesc&timespan=1d'
    const res = await ctx.getJson(url, { headers: BROWSER, timeoutMs: 20000 })
    if (!res.ok) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const rows = res.json && Array.isArray(res.json.articles) ? res.json.articles : []
    if (!rows.length) {
      return { items: [], meta: { error: res.jsonError ? 'bad payload: ' + res.jsonError.slice(0, 80) : 'no articles in window' } }
    }
    const items = []
    for (const row of rows.slice(0, limit)) {
      const title = String(row.title || '').trim()
      if (!title) continue
      items.push({
        id: 'gdelt:' + String(row.url || title).slice(0, 120),
        title: title.slice(0, 180),
        url: String(row.url || ''),
        publishedAt: gdeltTime(row.seendate),
        summary:
          (row.domain ? row.domain : '') +
          (row.sourcecountry ? ' · ' + row.sourcecountry : '') +
          (row.language ? ' · ' + row.language : '') +
          ' · 全球冲突/制裁监测',
        tags: ['地缘', String(row.sourcecountry || '')],
        payload: {
          domain: String(row.domain || ''),
          country: String(row.sourcecountry || ''),
          language: String(row.language || ''),
        },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'gdelt/doc', query: keyword } }
  },
}

// ---------------------------------------------------------------- UN News 地缘

/** Minimal RSS item reader (no dependency; the feeds are stable). */
function rssItems(xml, limit) {
  const out = []
  const blocks = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/g) || []
  for (const block of blocks.slice(0, limit)) {
    const pick = (tag) => {
      const m = new RegExp('<' + tag + '[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + tag + '>').exec(block)
      return m ? m[1].trim() : ''
    }
    out.push({
      title: pick('title').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
      link: pick('link'),
      pubDate: pick('pubDate'),
      description: pick('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      categories: (block.match(/<category[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/g) || [])
        .map((c) => c.replace(/<[^>]+>/g, '').trim())
        .filter(Boolean)
        .slice(0, 4),
    })
  }
  return out
}

const unNews = {
  id: 'un-news',
  name: '联合国新闻·和平安全',
  category: 'geo',
  region: 'GLOBAL',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://news.un.org/en/news/topic/peace-and-security',
  note: '联合国新闻和平与安全频道 RSS，覆盖冲突、制裁、人道危机；稳定且快',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 12000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 30)
    const url = 'https://news.un.org/feed/subscribe/en/news/topic/peace-and-security/feed/rss.xml'
    const res = await ctx.request(url, {
      headers: Object.assign({}, BROWSER, { accept: 'application/rss+xml, application/xml, text/xml, */*' }),
      timeoutMs: 10000,
    })
    if (!res.ok) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const rows = rssItems(res.text, limit)
    if (!rows.length) return { items: [], meta: { error: 'no rss items' } }
    const items = []
    for (const row of rows) {
      if (!row.title) continue
      items.push({
        id: 'un-news:' + String(row.link || row.title).slice(0, 140),
        title: row.title.slice(0, 180),
        url: row.link || 'https://news.un.org/en/news/topic/peace-and-security',
        publishedAt: row.pubDate ? Date.parse(row.pubDate) : null,
        summary: row.description.slice(0, 300),
        tags: ['地缘', '联合国'].concat(row.categories),
        payload: { categories: row.categories },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'un-news/rss' } }
  },
}

// ---------------------------------------------------------------- NASA EONET

const EONET_CN = {
  Wildfires: '野火',
  'Severe Storms': '强风暴',
  Volcanoes: '火山',
  Floods: '洪水',
  Earthquakes: '地震',
  'Sea and Lake Ice': '海冰',
  Drought: '干旱',
  'Temperature Extremes': '极端温度',
  Manmade: '人为事件',
  'Dust and Haze': '沙尘',
  Snow: '降雪',
  Landslides: '滑坡',
  'Water Color': '水体异常',
}

const eonet = {
  id: 'eonet',
  name: 'NASA 自然事件',
  category: 'weather',
  region: 'GLOBAL',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://eonet.gsfc.nasa.gov/',
  note: '卫星/机构汇总的全球自然灾害（野火、强风暴、火山、洪水、地震）；5–6s，可接受',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 16000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 20)
    const url = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=' + limit
    const res = await ctx.getJson(url, { headers: BROWSER, timeoutMs: 12000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const rows = Array.isArray(res.json.events) ? res.json.events : []
    if (!rows.length) return { items: [], meta: { error: 'no open events' } }
    const items = []
    for (const row of rows.slice(0, limit)) {
      const category = row.categories && row.categories[0] ? row.categories[0].title : 'Event'
      const cn = EONET_CN[category] || category
      const geometry = Array.isArray(row.geometry) ? row.geometry[0] : null
      const source = Array.isArray(row.sources) && row.sources[0] ? row.sources[0] : null
      items.push({
        id: 'eonet:' + String(row.id || ''),
        title: '【' + cn + '】' + String(row.title || '').slice(0, 150),
        url: (source && source.url) || row.link || 'https://eonet.gsfc.nasa.gov/',
        publishedAt: geometry && geometry.date ? Date.parse(geometry.date) : null,
        summary:
          String(row.description || '').slice(0, 160) +
          (geometry && Array.isArray(geometry.coordinates)
            ? ' · ' + geometry.coordinates[0] + ',' + geometry.coordinates[1]
            : '') +
          (source ? ' · 来源 ' + source.id : ''),
        tags: ['自然灾害', cn],
        payload: {
          category: category,
          categoryCn: cn,
          geometryType: geometry ? String(geometry.type || '') : '',
        },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'eonet/v3/events' } }
  },
}

// ---------------------------------------------------------------- 天气

const CITIES = [
  { id: 'beijing', name: '北京', lat: 39.9, lon: 116.4 },
  { id: 'shanghai', name: '上海', lat: 31.23, lon: 121.47 },
  { id: 'guangzhou', name: '广州', lat: 23.13, lon: 113.26 },
  { id: 'zhengzhou', name: '郑州', lat: 34.75, lon: 113.62 },
  { id: 'chengdu', name: '成都', lat: 30.57, lon: 104.07 },
  { id: 'harbin', name: '哈尔滨', lat: 45.75, lon: 126.65 },
]

function round1(value) {
  const n = num(value)
  return n === null ? '—' : n.toFixed(1)
}

const weather = {
  id: 'weather',
  name: '主要农业区天气',
  category: 'weather',
  region: 'CN',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://open-meteo.com/',
  note: '六个主产区未来 3 天降水与气温（Open-Meteo，免费）；对农产品与物流成本有直接影响',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 14000,
  async fetch(ctx) {
    const lat = CITIES.map((c) => c.lat).join(',')
    const lon = CITIES.map((c) => c.lon).join(',')
    const url =
      'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&forecast_days=3&timezone=Asia%2FShanghai'
    const res = await ctx.getJson(url, { headers: BROWSER, timeoutMs: 12000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const payloads = Array.isArray(res.json) ? res.json : [res.json]
    const items = []
    for (let i = 0; i < payloads.length && i < CITIES.length; i += 1) {
      const city = CITIES[i]
      const daily = payloads[i] && payloads[i].daily
      if (!daily || !Array.isArray(daily.time)) continue
      const rain = daily.precipitation_sum || []
      const tmax = daily.temperature_2m_max || []
      const tmin = daily.temperature_2m_min || []
      const prob = daily.precipitation_probability_max || []
      const total = rain.reduce((sum, value) => sum + (num(value) || 0), 0)
      items.push({
        id: 'weather:' + city.id,
        title: city.name + ' 未来3天降水 ' + total.toFixed(1) + 'mm · 最高 ' + round1(tmax[0]) + '°',
        url: 'https://open-meteo.com/en/docs',
        publishedAt: Date.now(),
        summary:
          '今日 ' + round1(tmax[0]) + '°/' + round1(tmin[0]) + '° 降水 ' + round1(rain[0]) + 'mm（概率 ' + round1(prob[0]) + '%）' +
          ' · 明日降水 ' + round1(rain[1]) + 'mm' +
          ' · 后日降水 ' + round1(rain[2]) + 'mm',
        tags: ['气候', '天气', city.name],
        payload: {
          city: city.id,
          name: city.name,
          rainfall3d: Number(total.toFixed(1)),
          today: { max: num(tmax[0]), min: num(tmin[0]), rain: num(rain[0]), probability: num(prob[0]) },
          tomorrowRain: num(rain[1]),
          dayAfterRain: num(rain[2]),
        },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'open-meteo/forecast' } }
  },
}

export const adapters = [unNews, gdelt, eonet, weather]
