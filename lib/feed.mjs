import { fetchText } from './net.mjs'
import { stripTags } from './text.mjs'

/**
 * Default headline sources. Provider descriptors:
 *  - rss         : classic RSS/Atom feed at feed.url
 *  - bing-news   : Bing News RSS built from feed.query (direct publisher URLs)
 *  - google-news : Google News RSS search (headline only; reading falls back to
 *                  title search because the article link is a JS redirect)
 *  - rsshub      : RSSHub route (feed.route) resolved against options.rsshubBase
 *  - wallstcn    : 华尔街见闻 7x24 JSON API
 *  - eastmoney   : 东方财富 快讯 JSONP API
 */
export const DEFAULT_FEEDS = [
  { id: 'bnn', name: 'BNN Bloomberg', type: 'rss', url: 'https://www.bnnbloomberg.ca/arc/outboundfeeds/rss/', category: '国际' },
  { id: 'reuters', name: 'Reuters', type: 'bing-news', query: 'Reuters', filterSources: ['Reuters'], category: '通讯社' },
  { id: 'bloomberg-bing', name: 'Bloomberg', type: 'bing-news', query: 'Bloomberg', filterSources: ['Bloomberg'], category: '通讯社' },
  { id: 'google-news-reuters-cn', name: 'Google News · 路透中文', type: 'google-news', query: 'when:24h 路透社', hl: 'zh-CN', gl: 'CN', ceid: 'CN:zh-Hans', category: '中文' },
  { id: 'cnbc', name: 'CNBC', type: 'rss', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', category: '美股' },
  { id: 'marketwatch', name: 'MarketWatch', type: 'rss', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', category: '美股' },
  { id: 'wsj-markets', name: 'WSJ Markets', type: 'rss', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', category: '美股' },
  { id: 'wsj-world', name: 'WSJ World', type: 'rss', url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', category: '国际' },
  { id: 'ft', name: 'Financial Times', type: 'rss', url: 'https://www.ft.com/rss/home', category: '国际' },
  { id: 'bbc-business', name: 'BBC Business', type: 'rss', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: '国际' },
  { id: 'guardian-business', name: 'Guardian Business', type: 'rss', url: 'https://www.theguardian.com/uk/business/rss', category: '国际' },
  { id: 'economist', name: 'The Economist', type: 'rss', url: 'https://www.economist.com/business/rss.xml', category: '深度' },
  { id: 'investing', name: 'Investing.com', type: 'rss', url: 'https://www.investing.com/rss/news.rss', category: '市场' },
  { id: 'yahoo-news', name: 'Yahoo News', type: 'rss', url: 'https://news.yahoo.com/rss/', category: '国际' },
  { id: 'aljazeera', name: 'Al Jazeera', type: 'rss', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: '国际' },
  { id: 'wallstcn', name: '华尔街见闻', type: 'wallstcn', category: '中文' },
  { id: 'eastmoney', name: '东方财富快讯', type: 'eastmoney', category: '中文' },
  { id: 'rsshub-36kr', name: '36氪快讯', type: 'rsshub', route: '/36kr/newsflashes', category: '中文' },
  { id: 'rsshub-caixin', name: '财新', type: 'rsshub', route: '/caixin/latest', category: '中文' },
]

export const FEED_TYPES = ['rss', 'bing-news', 'google-news', 'rsshub', 'wallstcn', 'eastmoney']
export const DEFAULT_RSSHUB_BASE = 'https://rsshub.rssforever.com'

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g
function unwrap(value) {
  return String(value == null ? '' : value).replace(CDATA, '$1').trim()
}
function pick(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'))
  return m ? unwrap(m[1]) : ''
}
function toIso(value) {
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
function baseItem(feed) {
  return {
    source: feed.name,
    sourceId: feed.id,
    category: feed.category || '',
  }
}
function stripOutletSuffix(title, outlet) {
  if (!outlet) return title
  const lower = outlet.toLowerCase()
  for (const sep of [' | ', ' - ', ' — ']) {
    const tail = (sep + outlet).toLowerCase()
    if (title.toLowerCase().endsWith(tail)) return title.slice(0, title.length - (sep + outlet).length).trim()
    const tail2 = (sep + lower.replace(/\.(com|co\.uk|net)$/, '')).toLowerCase()
    if (title.toLowerCase().endsWith(tail2)) return title.slice(0, title.length - (sep + lower.replace(/\.(com|co\.uk|net)$/, '')).length).trim()
  }
  return title
}

/** Parse RSS 2.0 into plain items (rss + rsshub providers). */
export function parseRss(xml, feed) {
  const items = []
  const source = feed || { id: '', name: '' }
  const blocks = String(xml || '').matchAll(/<item[\s>][\s\S]*?<\/item>/g)
  for (const b of blocks) {
    const block = b[0]
    const title = stripTags(pick(block, 'title'))
    const link = pick(block, 'link') || pick(block, 'guid')
    if (!title || !/^https?:/i.test(link)) continue
    items.push(Object.assign(baseItem(source), {
      title: title,
      url: link.trim(),
      summary: stripTags(pick(block, 'description')).slice(0, 220),
      creator: stripTags(pick(block, 'dc:creator') || pick(block, 'author')),
      date: toIso(pick(block, 'pubDate')),
    }))
  }
  return items
}

/** Decode the publisher URL out of a Bing News apiclick redirect. */
export function decodeBingNewsLink(link) {
  const raw = String(link || '').replace(/&amp;/g, '&').replace(/&#38;/g, '&')
  const m = raw.match(/[?&]url=([^&]+)/)
  if (!m) return /^https?:/.test(raw) && !/bing\.com/i.test(raw) ? raw : ''
  try {
    const url = decodeURIComponent(m[1])
    return /^https?:/i.test(url) ? url : ''
  } catch {
    return ''
  }
}

/** Parse a Bing News RSS feed into items with direct publisher URLs. */
export function parseBingNews(xml, feed) {
  const items = []
  const source = feed || { id: '', name: '' }
  const whitelist = Array.isArray(source.filterSources) && source.filterSources.length
    ? source.filterSources.map((s) => String(s).toLowerCase())
    : []
  const blocks = String(xml || '').matchAll(/<item[\s>][\s\S]*?<\/item>/g)
  for (const b of blocks) {
    const block = b[0]
    const title = stripTags(pick(block, 'title'))
    const url = decodeBingNewsLink(pick(block, 'link'))
    if (!title || !url) continue
    const outlet = stripTags(pick(block, 'News:Source') || pick(block, 'source'))
    items.push(Object.assign(baseItem(source), {
      title: stripOutletSuffix(title, outlet),
      url: url,
      summary: stripTags(pick(block, 'description')).slice(0, 220),
      creator: outlet,
      outlet: outlet,
      date: toIso(pick(block, 'pubDate')),
    }))
  }
  if (whitelist.length) {
    const filtered = items.filter((item) => whitelist.some((w) => String(item.outlet || '').toLowerCase().includes(w)))
    if (filtered.length) return filtered
  }
  return items
}

/**
 * Parse a Google News RSS search feed. The item link is a news.google.com JS
 * redirect, so items carry readHint (the headline); the reader resolves the
 * full text by title search instead of fetching the redirect.
 */
export function parseGoogleNews(xml, feed) {
  const items = []
  const source = feed || { id: '', name: '' }
  const blocks = String(xml || '').matchAll(/<item[\s>][\s\S]*?<\/item>/g)
  for (const b of blocks) {
    const block = b[0]
    const rawTitle = stripTags(pick(block, 'title'))
    const link = pick(block, 'link')
    if (!rawTitle || !/^https?:/i.test(link)) continue
    const outletM = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)
    const outlet = outletM ? stripTags(outletM[1]) : ''
    const title = stripOutletSuffix(rawTitle, outlet)
    items.push(Object.assign(baseItem(source), {
      title: title,
      url: link.trim(),
      readHint: title,
      via: 'google-news',
      summary: stripTags(pick(block, 'description')).slice(0, 220),
      creator: outlet,
      outlet: outlet,
      date: toIso(pick(block, 'pubDate')),
    }))
  }
  return items
}

/** Parse the 华尔街见闻 7x24 JSON payload. */
export function parseWallstcn(text, feed) {
  const source = feed || { id: 'wallstcn', name: '华尔街见闻' }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const list = data && data.data && Array.isArray(data.data.items) ? data.data.items : []
  const items = []
  for (const item of list) {
    const content = stripTags(item.content || item.content_text || '')
    if (!content) continue
    const title = (String(item.title || '').trim() || content).slice(0, 90)
    items.push(Object.assign(baseItem(source), {
      title: title,
      url: item.uri || ('https://wallstreetcn.com/livenews/' + item.id),
      summary: content.slice(0, 220),
      creator: item.author && item.author.display_name ? item.author.display_name : '',
      date: item.display_time ? new Date(item.display_time * 1000).toISOString() : null,
      category: item.global_channel_name || source.category || '',
    }))
  }
  return items
}

/** Parse the 东方财富 快讯 JSONP payload (var ajaxResult={...}). */
export function parseEastmoney(text, feed) {
  const source = feed || { id: 'eastmoney', name: '东方财富快讯' }
  const raw = String(text || '')
  const start = raw.indexOf('{')
  if (start < 0) return []
  let data
  try {
    data = JSON.parse(raw.slice(start).replace(/;\s*$/, ''))
  } catch {
    return []
  }
  const list = data && Array.isArray(data.LivesList) ? data.LivesList : []
  const items = []
  for (const item of list) {
    const title = stripTags(item.title || item.simtitle || '')
    const link = item.url_w || item.url_unique || item.url_m || ''
    if (!title || !/^https?:/i.test(link)) continue
    const stamp = String(item.showtime || '').trim()
    const date = stamp ? new Date(stamp.replace(' ', 'T') + '+08:00').toISOString() : null
    items.push(Object.assign(baseItem(source), {
      title: title,
      url: link,
      summary: stripTags(item.digest || item.simdigest || '').slice(0, 220),
      creator: item.editor_name || '',
      date: Number.isFinite(Date.parse(date)) ? date : null,
    }))
  }
  return items
}

function bingNewsUrl(feed) {
  if (feed.url) return feed.url
  const query = feed.query || feed.name || 'business'
  return 'https://www.bing.com/news/search?q=' + encodeURIComponent(query) + '&format=rss&setmkt=en-US&setlang=en-US&cc=US'
}
function googleNewsUrl(feed) {
  if (feed.url) return feed.url
  const query = feed.query || feed.name || 'business'
  const hl = feed.hl || 'en-US'
  const gl = feed.gl || 'US'
  const ceid = feed.ceid || 'US:en'
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) +
    '&hl=' + encodeURIComponent(hl) + '&gl=' + encodeURIComponent(gl) + '&ceid=' + encodeURIComponent(ceid)
}
export function rsshubUrl(feed, baseUrl) {
  if (feed.url) return feed.url
  const base = String(baseUrl || DEFAULT_RSSHUB_BASE).replace(/\/+$/, '')
  const route = String(feed.route || '').trim()
  return base + (route.startsWith('/') ? route : '/' + route)
}

function netOpts(options) {
  const opts = options || {}
  return {
    proxy: opts.proxy,
    proxies: opts.proxies,
    retries: opts.retries,
    rotateUA: opts.rotateUA,
    minIntervalMs: opts.minIntervalMs,
  }
}

/** Bing News site:<domain> as an automatic fallback when a feed is blocked. */
async function bingSiteFallback(feed, options) {
  let domain = ''
  try {
    domain = new URL(feed.url).hostname.replace(/^www\./, '')
  } catch {
    return []
  }
  if (!domain) return []
  const query = 'site:' + domain
  const url = 'https://www.bing.com/news/search?q=' + encodeURIComponent(query) + '&format=rss&setmkt=en-US&setlang=en-US&cc=US'
  try {
    const r = await fetchText(url, Object.assign(netOpts(options), { timeoutMs: options.timeoutMs || 18000 }))
    if (r.status !== 200) return []
    return parseBingNews(r.text, { id: feed.id, name: feed.name, category: feed.category })
      .map((item) => Object.assign({}, item, { via: 'bing-news-fallback' }))
  } catch {
    return []
  }
}

/** Fetch one configured feed through its provider (with per-source latency). */
async function fetchOne(feed, options) {
  const type = feed.type || 'rss'
  const timeout = options.timeoutMs || 18000
  const started = Date.now()
  let items = []
  if (type === 'wallstcn') {
    const url = feed.url || 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30&accept=article'
    const r = await fetchText(url, Object.assign(netOpts(options), { timeoutMs: timeout }))
    if (r.status !== 200) throw new Error('HTTP ' + r.status)
    items = parseWallstcn(r.text, feed)
  } else if (type === 'eastmoney') {
    const url = feed.url || 'https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html'
    const r = await fetchText(url, Object.assign(netOpts(options), { timeoutMs: timeout }))
    if (r.status !== 200) throw new Error('HTTP ' + r.status)
    items = parseEastmoney(r.text, feed)
  } else if (type === 'bing-news') {
    const r = await fetchText(bingNewsUrl(feed), Object.assign(netOpts(options), { timeoutMs: timeout }))
    if (r.status !== 200) throw new Error('HTTP ' + r.status)
    items = parseBingNews(r.text, feed)
  } else if (type === 'google-news') {
    const r = await fetchText(googleNewsUrl(feed), Object.assign(netOpts(options), { timeoutMs: timeout }))
    if (r.status !== 200) throw new Error('HTTP ' + r.status)
    items = parseGoogleNews(r.text, feed)
  } else if (type === 'rsshub') {
    const r = await fetchText(rsshubUrl(feed, options.rsshubBase), Object.assign(netOpts(options), { timeoutMs: timeout }))
    if (r.status !== 200) throw new Error('HTTP ' + r.status)
    items = parseRss(r.text, feed)
  } else {
    const r = await fetchText(feed.url, Object.assign(netOpts(options), { timeoutMs: timeout }))
    if (r.status !== 200) throw new Error('HTTP ' + r.status)
    items = parseRss(r.text, feed)
  }
  return { items: items, ms: Date.now() - started }
}

/**
 * Fetch every configured feed in parallel, merge, dedupe and sort by date.
 * Each source row carries ok/count/ms/error so the panel can show health.
 */
export async function fetchFeeds(feeds, options) {
  const opts = options || {}
  const list = Array.isArray(feeds) && feeds.length ? feeds : DEFAULT_FEEDS
  const results = await Promise.all(
    list.map(async (feed) => {
      const started = Date.now()
      const fallbackEnabled = opts.autoFallback !== false
      try {
        const got = await fetchOne(feed, opts)
        if (got.items.length > 0) {
          return { feed: feed, ok: true, error: '', items: got.items, ms: got.ms, fallback: false }
        }
        if (!fallbackEnabled) {
          return { feed: feed, ok: false, error: 'no items', items: [], ms: got.ms, fallback: false }
        }
        const fallbackItems = await bingSiteFallback(feed, opts)
        return {
          feed: feed,
          ok: fallbackItems.length > 0,
          error: fallbackItems.length ? 'fallback: no items' : 'no items',
          items: fallbackItems,
          ms: Date.now() - started,
          fallback: fallbackItems.length > 0,
        }
      } catch (e) {
        const message = String(e && e.message ? e.message : e)
        if (fallbackEnabled) {
          const fallbackItems = await bingSiteFallback(feed, opts)
          if (fallbackItems.length > 0) {
            return { feed: feed, ok: true, error: 'fallback: ' + message.slice(0, 80), items: fallbackItems, ms: Date.now() - started, fallback: true }
          }
        }
        return { feed: feed, ok: false, error: message, items: [], ms: Date.now() - started, fallback: false }
      }
    }),
  )
  const seen = new Set()
  const items = []
  const perSourceMax = Number(opts.perSourceMax) > 0 ? Number(opts.perSourceMax) : 20
  for (const r of results) {
    const own = r.items
      .slice()
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, perSourceMax)
    for (const item of own) {
      const key = String(item.url).split('?')[0]
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
  }
  items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 240
  return {
    items: items.slice(0, limit),
    sources: results.map((r) => ({
      id: r.feed.id,
      name: r.feed.name,
      type: r.feed.type || 'rss',
      category: r.feed.category || '',
      ok: r.ok,
      count: r.items.length,
      ms: r.ms,
      fallback: r.fallback === true,
      error: r.error,
    })),
    fetchedAt: Date.now(),
  }
}
