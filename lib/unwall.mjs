import { fetchText, postText } from './net.mjs'
import { decodeEntities as decode, stripTags } from './text.mjs'
import { parseBingNews } from './feed.mjs'

/** Known licensed syndication sites: Bloomberg full text is distributed there free. */
const DOMAIN_SCORE = [
  [/sg\.finance\.yahoo\.com|finance\.yahoo\.com/, 100],
  [/businesstimes\.com\.sg/, 100],
  [/theedgemalaysia\.com/, 96],
  [/economictimes\.indiatimes\.com/, 94],
  [/thehindubusinessline\.com/, 92],
  [/chinadailyhk\.com/, 88],
  [/bnnbloomberg\.ca/, 88],
  [/bloomberglinea\.com/, 86],
  [/financialpost\.com/, 85],
  [/livemint\.com/, 82],
  [/japantimes\.co\.jp/, 80],
  [/moneyweb\.co\.za/, 78],
  [/straitstimes\.com/, 76],
  [/article\.wn\.com/, 60],
  [/msn\.com/, 56],
  [/investing\.com/, 52],
  [/dobenergy\.com|report\.az/, 34],
  [/roic\.ai|docstox|tradow|moomoo|gate\.com|cryptobriefing/, 20],
]
/** Network options shared by every request in this module. */
function netOpts(opts, timeoutMs) {
  const o = opts || {}
  return {
    proxy: o.proxy,
    proxies: o.proxies,
    retries: o.retries,
    rotateUA: o.rotateUA,
    minIntervalMs: o.minIntervalMs,
    timeoutMs: timeoutMs || 25000,
  }
}

const BAD_HOST = /(^|\.)bloomberg\.com$|bloomberg\.co\.jp$/
const WEAK_HOST = /(^|\.)(x|twitter|github|gist|youtube|youtu\.be|facebook|instagram|reddit|tiktok|linkedin|pinterest)\.com$/
const SEARCH_TTL_MS = 60 * 60 * 1000
const searchCache = new Map()

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
function isWeakSource(url) {
  return WEAK_HOST.test(hostOf(url))
}
export function isBloombergUrl(url) {
  return BAD_HOST.test(hostOf(url))
}
const GOOGLE_NEWS_HOST = /(^|\.)news\.google\.com$/
export function isGoogleNewsUrl(url) {
  return GOOGLE_NEWS_HOST.test(hostOf(url))
}
export function phraseOf(text) {
  if (!/^https?:/i.test(text)) return String(text || '').trim()
  try {
    const u = new URL(text)
    const m = u.pathname.match(/\/news\/articles\/\d{4}-\d{2}-\d{2}\/([^/]+)/) || u.pathname.match(/\/([^/]+)$/)
    return (m ? m[1] : '').replace(/-[a-z0-9]{6,}$/i, '').replace(/-/g, ' ').trim()
  } catch {
    return String(text || '')
  }
}


function parseDdg(html, cls) {
  const out = []
  const re = new RegExp('<a[^>]*class="' + cls + '"[^>]*>([\\s\\S]*?)<\\/a>', 'g')
  let m
  while ((m = re.exec(html))) {
    const tag = (m[0].match(/^<a[^>]*>/) || [''])[0]
    const href = (tag.match(/href="([^"]+)"/) || [])[1] || ''
    let url = href
    const u = href.match(/uddg=([^&]+)/)
    if (u) url = decodeURIComponent(u[1])
    if (/^https?:/.test(url)) out.push({ title: stripTags(m[1]), url: url })
  }
  return out
}
function parseYahoo(html) {
  const out = []
  const blocks = html.matchAll(/<div class="dd[^"]*algo[^"]*"[\s\S]*?(?=<div class="dd[^"]*algo|<\/ol>)/g)
  for (const b of blocks) {
    const block = b[0]
    const aTag = block.match(/<a[^>]+href="([^"]*r\.search\.yahoo\.com[^"]*)"/)
    const h3 = block.match(/<h3[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h3>/)
    if (!aTag) continue
    const hs = decode(aTag[1])
    const ru = hs.match(/RU=([^/]+)\/RK=/)
    if (!ru) continue
    let url = ''
    try {
      url = decodeURIComponent(ru[1])
    } catch {
      continue
    }
    if (/^https?:/.test(url)) out.push({ title: h3 ? stripTags(h3[1]) : '', url: url })
  }
  return out
}
function parseBing(html) {
  const out = []
  const blocks = html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)
  for (const a of blocks) {
    const b = a[0]
    const h2 = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)
    const hrefM = b.match(/<h2[^>]*><a[^>]+href="([^"]+)"/)
    let url = hrefM ? decode(hrefM[1]) : ''
    const uB64 = url.match(/[?&]u=a1([A-Za-z0-9_\-]+)/)
    if (uB64) {
      let b64 = uB64[1].replace(/-/g, '+').replace(/_/g, '/')
      while (b64.length % 4) b64 += '='
      try {
        const d = Buffer.from(b64, 'base64').toString('utf8')
        if (/^https?:/.test(d)) url = d
      } catch {}
    }
    if (/^https?:/.test(url)) out.push({ title: h2 ? stripTags(h2[1]) : '', url: url })
  }
  return out
}

/**
 * Search the web for the exact phrase and return ranked candidate URLs.
 * The same phrase is cached in memory for an hour to avoid hammering engines.
 */
async function bingNewsCandidates(phrase, options) {
  const label = String(phrase || '').trim()
  if (!label) return []
  const url = 'https://www.bing.com/news/search?q=' + encodeURIComponent('"' + label + '"') + '&format=RSS&setlang=en-US&cc=US'
  try {
    const r = await fetchText(url, netOpts(options, 18000))
    if (r.status !== 200 || r.blocked) return []
    const items = parseBingNews(r.text, { id: 'fallback', name: 'Bing News' })
    return items.map((item) => ({ title: item.title, url: item.url }))
  } catch {
    return []
  }
}

export async function searchWeb(phrase, options) {
  const opts = options || {}
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const cached = searchCache.get(phrase)
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.hits
  const q = '"' + phrase + '"'
  const engines = [
    { name: 'Yahoo', url: 'https://search.yahoo.com/search?p=' + encodeURIComponent(q) + '&n=20', parse: parseYahoo },
    { name: 'DDG', url: 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), parse: (h) => parseDdg(h, 'result__a') },
    { name: 'Bing', url: 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&cc=US&setlang=en-US&ensearch=1', parse: parseBing },
  ]
  const all = []
  const seen = new Set()
  for (const e of engines) {
    let got = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const r = await fetchText(e.url, netOpts(opts, 20000))
        if (r.status === 200) got = e.parse(r.text)
      } catch {}
      if (got.length) break
      await new Promise((r) => setTimeout(r, 1800))
    }
    if (got.length) {
      log('search ' + e.name + ': ' + got.length)
      for (const h of got) {
        const key = h.url.split('?')[0]
        if (seen.has(key)) continue
        seen.add(key)
        all.push(h)
      }
    }
    if (all.length >= 15) break
  }
  searchCache.set(phrase, { at: Date.now(), hits: all })
  return all
}

function cjkGrams(text) {
  const chars = String(text || '').replace(/[^\u3400-\u9fff]/g, '')
  const grams = []
  for (let i = 0; i < chars.length - 1; i += 1) grams.push(chars.slice(i, i + 2))
  return grams
}
function scoreHit(hit, phrase) {
  const host = hostOf(hit.url)
  if (!host) return -999
  if (BAD_HOST.test(host)) return -999
  let score = 0
  for (const pair of DOMAIN_SCORE) if (pair[0].test(host)) score = Math.max(score, pair[1])
  if (WEAK_HOST.test(host)) score = 8
  const words = phrase.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3)
  const title = String(hit.title || '').toLowerCase()
  if (words.length) {
    score += Math.round((words.filter((w) => title.includes(w)).length / words.length) * 15)
  } else {
    const grams = cjkGrams(phrase)
    if (grams.length) {
      const matched = grams.filter((g) => title.includes(g)).length
      score += Math.round((matched / grams.length) * 15)
    }
  }
  if (score <= 0 && !WEAK_HOST.test(host)) score = 5
  return score
}
export function rankHits(hits, phrase) {
  return hits
    .map((h) => ({ title: h.title, url: h.url, score: scoreHit(h, phrase) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
}

async function deepSearch(phrase, options) {
  const domains = ['finance.yahoo.com', 'businesstimes.com.sg', 'theedgemalaysia.com', 'financialpost.com', 'bnnbloomberg.ca', 'bloomberglinea.com', 'economictimes.indiatimes.com']
  const out = []
  for (const d of domains) {
    const q = 'site:' + d + ' "' + phrase + '"'
    try {
      const r = await fetchText('https://search.yahoo.com/search?p=' + encodeURIComponent(q) + '&n=10', netOpts(options, 15000))
      if (r.status === 200) out.push(...parseYahoo(r.text))
    } catch {}
    await new Promise((r) => setTimeout(r, 1200))
  }
  return rankHits(out, phrase)
}

// ---------- article extraction ----------
function extractJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html))) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return ''
        if (Array.isArray(o)) {
          for (const item of o) {
            const r = walk(item)
            if (r) return r
          }
          return ''
        }
        if (typeof o.articleBody === 'string' && o.articleBody.length > 200) return o.articleBody
        for (const v of Object.values(o)) {
          const r = walk(v)
          if (r) return r
        }
        return ''
      }
      const body = walk(JSON.parse(m[1]))
      if (body) return body
    } catch {}
  }
  return ''
}
const NAV_HINT = /^(Share|Subscribe|Sign in|Log in|Read more|Advertisement|Comments|Download|Follow us|Also read|Latest|Top stories|Cookie|Home|Menu|Search|Newsletters|Watch|Listen|Podcast|Video|Markets|Business|Technology|Opinion|Weather|Sports|Life|More|Sections|React|Copy link|Published:|Updated:|Newsletter)/i
const NAV_JUNK = /(^|\n)(Sections|Sign In|Sign in|Search|Download Our App|Copy link|Share on|React|Latest Latest|Published:|Updated:)\b|\bSign In\b[\s\S]{0,200}\bSign In\b/i
function looksProse(p) {
  if (p.length < 40 || p.length > 3000) return false
  if (NAV_HINT.test(p)) return false
  if (/Sign In|Download Our App|Copy link|Share on (Facebook|X)|Newsletter/.test(p)) return false
  if (p.length > 900 && (p.match(/[.!?。！？]/g) || []).length < 5) return false
  if ((p.match(/\|/g) || []).length > 1) return false
  if (/cookie|javascript|enable js|subscribe to/i.test(p)) return false
  const cjk = (p.match(/[\u3400-\u9fff]/g) || []).length
  const sentences = (p.match(/[.!?。！？](?=[\s"'」』）)]|$)/g) || []).length
  return sentences >= 1 || cjk >= 30
}
function extractParagraphs(html) {
  const containers = []
  const art = html.match(/<article[\s\S]*?<\/article>/i)
  if (art) containers.push(art[0])
  const divs = html.matchAll(/<div[^>]+(?:itemprop="articleBody"|class="[^"]*(?:article-body|articleBody|story-body|article-content|article__body|content-body|entry-content|post-content)[^"]*")[^>]*>([\s\S]*?)<\/div>/gi)
  for (const m of divs) containers.push(m[1])
  const sources = containers.length ? containers : [html]
  for (const src of sources) {
    const paras = []
    const ps = src.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)
    for (const m of ps) {
      const p = stripTags(m[1])
      if (looksProse(p)) paras.push(p)
    }
    if (paras.join('\n\n').length > 200) return paras.join('\n\n')
  }
  const paras = []
  const ps = html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)
  for (const m of ps) {
    const p = stripTags(m[1])
    if (looksProse(p)) paras.push(p)
  }
  return paras.join('\n\n')
}
export function extractArticle(html) {
  const jsonLdBody = extractJsonLd(html)
  const paragraphs = extractParagraphs(html)
  const ldClean = Boolean(jsonLdBody && jsonLdBody.length > 400 && !NAV_JUNK.test(jsonLdBody.slice(0, 400)))
  const paraClean = Boolean(paragraphs && paragraphs.length > 0 && !NAV_JUNK.test(paragraphs.slice(0, 400)))
  // Prefer a clean JSON-LD body when paragraph extraction picked up nav/live-feed
  // chrome; otherwise prefer whichever extraction is substantially longer.
  if (ldClean && (!paraClean || jsonLdBody.length >= paragraphs.length * 0.8)) return decode(jsonLdBody)
  if (paragraphs && paragraphs.length > 0) return decode(paragraphs)
  return jsonLdBody ? decode(jsonLdBody) : ''
}
export function extractTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
  if (og) return stripTags(og[1])
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return t ? stripTags(t[1]).replace(/\s*[-|–]\s*[^-|–]{2,40}$/, '').trim() : ''
}
export function bodyLooksReal(body, phrase) {
  if (!body || body.length < 400) return false
  const words = phrase.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3)
  const hay = body.toLowerCase()
  const cjk = cjkGrams(phrase)
  let ratio
  if (words.length) ratio = words.filter((w) => hay.includes(w)).length / words.length
  else if (cjk.length) ratio = cjk.filter((g) => hay.includes(g)).length / cjk.length
  else ratio = 0
  const sentences = (body.match(/[。！？]/g) || []).length + (body.match(/[.!?](?:\s|$)/g) || []).length
  const needed = cjk.length && !words.length ? 1 : 3
  return ratio >= 0.3 && sentences >= needed
}

const GOOGLE_RESOLVE_TTL = 24 * 3600 * 1000
const googleResolved = new Map()

/**
 * Resolve a Google News article link to the publisher URL.
 * Google News links are JS redirects; the page carries a signature/timestamp
 * pair that the internal batchexecute endpoint exchanges for the real URL.
 */
const GOOGLE_HOST_RE = /(^|\.)google\.com$/i

/** Extract the publisher URL embedded in a Google News article page. */
export function decodeGoogleNewsPage(html) {
  const text = String(html || '')
  const candidates = []
  const patterns = [
    /data-n-au="([^"]+)"/,
    /data-n-aurl="([^"]+)"/,
    /"data-n-au":"([^"]+)"/,
    /href="(https?:\/\/(?!news\.google\.com\/)[^"]+)"/g,
  ]
  for (const pattern of patterns) {
    if (pattern.global) {
      let m
      while ((m = pattern.exec(text))) candidates.push(m[1])
    } else {
      const m = text.match(pattern)
      if (m) candidates.push(m[1])
    }
  }
  for (let raw of candidates) {
    let url = String(raw || '')
      .replace(/\\u0026/g, '&')
      .replace(/\\u003d/g, '=')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .trim()
    if (!/^https?:\/\//i.test(url)) continue
    try {
      const host = new URL(url).hostname
      if (!host || GOOGLE_HOST_RE.test(host) || host === 'news.google.com') continue
      if (/(^|\.)(googleusercontent|gstatic|googleapis)\.com$/.test(host) || /(^|\.)google\.com$/.test(host)) continue
      if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|ico)$/i.test(new URL(url).pathname)) continue
      if (/=w\d+|=s\d+/.test(new URL(url).search + new URL(url).pathname)) continue
      return url
    } catch {}
  }
  return ''
}

async function resolveGoogleNewsPage(url, options) {
  try {
    const artId = (String(url).match(/\/articles\/([^?/]+)/) || [])[1]
    if (!artId) return ''
    const pageUrl = 'https://news.google.com/articles/' + artId + '?hl=en-US&gl=US&ceid=US:en'
    const page = await fetchText(pageUrl, netOpts(options, 15000))
    if (page.status !== 200) return ''
    return decodeGoogleNewsPage(page.text)
  } catch {
    return ''
  }
}

export function parseGartUrlResponse(text) {
  const cleaned = String(text || '').replace(/^\)\]\}'?\s*/, '')
  for (const section of cleaned.split('\n\n')) {
    try {
      const parsed = JSON.parse(section)
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (!Array.isArray(row) || typeof row[2] !== 'string') continue
          if (!row[2].startsWith('["garturlres"')) continue
          try {
            const inner = JSON.parse(row[2])
            if (Array.isArray(inner) && /^https?:/i.test(inner[1])) return inner[1]
          } catch {}
        }
      }
    } catch {}
  }
  const m = cleaned.match(/garturlres"\s*,\s*"(https?:[^"\\]+)"/)
  if (m) return m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
  return ''
}

export async function resolveGoogleNewsUrl(url, options) {
  const opts = options || {}
  const cached = googleResolved.get(url)
  if (cached && Date.now() - cached.at < GOOGLE_RESOLVE_TTL) return cached.url
  const artId = (String(url).match(/\/articles\/([^?/]+)/) || [])[1]
  if (!artId) return ''
  let lastPage = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 700))
    try {
      const page = await fetchText(url, netOpts(opts, 20000))
      if (page.status !== 200) continue
      lastPage = page.text
      const sg = (page.text.match(/data-n-a-sg="([^"]+)"/) || [])[1]
      const ts = (page.text.match(/data-n-a-ts="([^"]+)"/) || [])[1]
      if (!sg || !ts) {
        const fromPage = decodeGoogleNewsPage(page.text)
        if (fromPage) { googleResolved.set(url, { at: Date.now(), url: fromPage }); return fromPage }
        continue
      }
      const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], artId, ts, sg])
      const body = 'f.req=' + encodeURIComponent(JSON.stringify([[[ 'Fbv4je', inner, null, 'generic' ]]]))
      const res = await postText('https://news.google.com/_/DotsSplashUi/data/batchexecute', body, netOpts(opts, 20000))
      if (res.status !== 200) continue
      const decoded = parseGartUrlResponse(res.text)
      if (decoded && /^https?:/i.test(decoded)) {
        googleResolved.set(url, { at: Date.now(), url: decoded })
        return decoded
      }
    } catch {}
  }
  if (lastPage) {
    const fromPage = decodeGoogleNewsPage(lastPage)
    if (fromPage) { googleResolved.set(url, { at: Date.now(), url: fromPage }); return fromPage }
  }
  return ''
}

async function readViaReaderProxy(url, options) {
  const base = String(options.readerProxy || '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return null
  const target = base + '/' + url.replace(/^https?:\/\//i, '')
  try {
    const r = await fetchText(target, netOpts(options, 25000))
    if (r.status !== 200 || r.blocked) return null
    const text = r.text.trim()
    if (text.length < 300) return null
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    const title = (lines[0] || '').replace(/^#+\s*/, '').slice(0, 120) || phraseOf(url)
    return {
      title: title,
      body: lines.join('\n'),
      sourceUrl: target,
      sourceHost: 'reader-proxy',
      original: url,
      viaReaderProxy: true,
    }
  } catch {
    return null
  }
}

async function readDirect(url, options) {
  const opts = options || {}
  try {
    const r = await fetchText(url, netOpts(opts, 25000))
    if (r.status !== 200) throw new Error('HTTP ' + r.status)
    const body = extractArticle(r.text).replace(/[ \t]+\n/g, '\n').trim()
    const title = extractTitle(r.text) || phraseOf(url)
    return { title: title, body: body, sourceUrl: url, sourceHost: hostOf(url), original: url }
  } catch (error) {
    if (opts.readerProxy) {
      const alt = await readViaReaderProxy(url, opts)
      if (alt) return alt
    }
    throw error
  }
}

async function tryCandidates(list, phrase, options, allowWeak) {
  for (const hit of list) {
    if (!allowWeak && isWeakSource(hit.url)) continue
    try {
      const r = await fetchText(hit.url, netOpts(options, 25000))
      if (r.status !== 200) continue
      const body = extractArticle(r.text).replace(/[ \t]+\n/g, '\n').trim()
      if (bodyLooksReal(body, phrase) && !(isWeakSource(hit.url) && body.length < 1200)) {
        return { hit: hit, body: body, title: extractTitle(r.text) || hit.title || phrase }
      }
    } catch {}
  }
  return null
}

/**
 * Turn any article URL into a readable article object.
 * - Partner/syndication URL: read it directly.
 * - Bloomberg URL: search licensed syndication copies and extract full text.
 */
export async function findReadable(original, options) {
  const opts = options || {}
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const titleHint = String(opts.title || '').trim()
  const googleNews = isGoogleNewsUrl(original)
  let target = original
  let resolvedFrom = ''
  if (googleNews) {
    resolvedFrom = await resolveGoogleNewsUrl(original, opts)
    if (!resolvedFrom) {
      resolvedFrom = await resolveGoogleNewsPage(original, opts)
      if (resolvedFrom) log('resolved google news page -> ' + resolvedFrom)
    }
    if (resolvedFrom) {
      target = resolvedFrom
      log('resolved google news -> ' + resolvedFrom)
    }
  }
  const slugPhrase = phraseOf(target)
  const phrase = titleHint || (googleNews && !resolvedFrom ? '' : slugPhrase)
  if (!phrase) return { article: null, candidates: [] }
  log('phrase: ' + phrase)
  let partial = null
  if (!isBloombergUrl(target) && !isGoogleNewsUrl(target)) {
    try {
      const direct = await readDirect(target, opts)
      if (direct.body.length >= 80 && direct.body.length <= 350) partial = direct
      if (direct.body.length > 350) {
        return {
          article: Object.assign({}, direct, { original: original, sourceUrl: direct.sourceUrl, sourceHost: hostOf(direct.sourceUrl), resolvedFrom: resolvedFrom }),
          candidates: [],
        }
      }
    } catch (e) {
      log('direct read failed: ' + String(e && e.message ? e.message : e))
    }
  }
  const hits = await searchWeb(phrase, opts)
  let ranked = rankHits(hits, phrase)
  if (ranked.length < 4) {
    const extra = await bingNewsCandidates(phrase, opts)
    if (extra.length) {
      log('bing news fallback: ' + extra.length)
      ranked = rankHits(hits.concat(extra), phrase)
    }
  }
  log('candidates: ' + ranked.length)
  let got = await tryCandidates(ranked.slice(0, 8), phrase, opts, false)
  if (!got) {
    log('deep search...')
    const deep = await deepSearch(phrase, opts)
    if (deep.length) ranked = deep
    got = await tryCandidates(ranked.slice(0, 8), phrase, opts, false)
  }
  if (!got) {
    const weak = ranked.filter((h) => isWeakSource(h.url)).slice(0, 2)
    if (weak.length) got = await tryCandidates(weak, phrase, opts, true)
  }
  const candidates = ranked.slice(0, 12)
  if (!got) {
    if (partial) {
      return {
        article: Object.assign({}, partial, {
          title: partial.title || titleHint || phrase,
          sourceHost: hostOf(partial.sourceUrl),
          original: original,
          resolvedFrom: resolvedFrom,
          partial: true,
          fetchedAt: Date.now(),
        }),
        candidates: candidates,
      }
    }
    return { article: null, candidates: candidates }
  }
  const article = {
    title: got.title || titleHint || phrase,
    body: got.body,
    sourceUrl: got.hit.url,
    sourceHost: hostOf(got.hit.url),
    original: original,
    resolvedFrom: resolvedFrom,
    fetchedAt: Date.now(),
  }
  return { article: article, candidates: candidates }
}