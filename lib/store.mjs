import { createHash } from 'node:crypto'
import { DEFAULT_WATCHLIST } from './quotes.mjs'
import fs from 'node:fs'
import path from 'node:path'

const INDEX_FILE = 'index.json'
const ARTICLE_DIR = 'cache'
const FAVORITES_FILE = 'favorites.json'
const SETTINGS_FILE = 'settings.json'

export const DEFAULT_CAPS = {
  maxBytes: 30 * 1024 * 1024,
  maxItems: 500,
  ttlHours: 72,
}
const MAX_KEYWORDS = 20
const MAX_FEEDS = 20
const DEFAULT_RSSHUB_BASE = 'https://rsshub.rssforever.com'
export const DEFAULT_ANTIBLOCK = {
  enabled: true,
  rotateUA: true,
  retries: 1,
  hostIntervalMs: 0,
  proxyPool: [],
  autoFallback: true,
  readerProxy: '',
}

function normalizeWatchlist(value) {
  if (!Array.isArray(value)) return JSON.parse(JSON.stringify(DEFAULT_WATCHLIST))
  const out = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24)
    const label = String(item.label || '').trim().slice(0, 40) || id
    if (!id) continue
    const entry = { id: id, label: label }
    for (const key of ['tv', 'yahoo', 'tencent', 'coingecko', 'okx', 'em', 'currency']) {
      if (item[key]) entry[key] = String(item[key]).trim().slice(0, 40)
    }
    if (!entry.tv && !entry.yahoo && !entry.tencent && !entry.coingecko && !entry.okx && !entry.em) continue
    if (out.some((x) => x.id === entry.id)) continue
    out.push(entry)
    if (out.length >= 40) break
  }
  return out.length ? out : JSON.parse(JSON.stringify(DEFAULT_WATCHLIST))
}

function normalizeAntiBlock(value) {
  const def = DEFAULT_ANTIBLOCK
  const src = value && typeof value === 'object' ? value : {}
  const clampInt = (v, lo, hi, fallbackValue) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallbackValue
    return Math.max(lo, Math.min(hi, Math.floor(n)))
  }
  const pool = Array.isArray(src.proxyPool)
    ? src.proxyPool.map((p) => String(p || '').trim()).filter((p) => /^https?:\/\//i.test(p)).slice(0, 10)
    : []
  const readerProxy = /^https?:\/\//i.test(String(src.readerProxy || '').trim()) ? String(src.readerProxy).trim() : ''
  return {
    enabled: src.enabled !== false,
    rotateUA: src.rotateUA !== false,
    retries: clampInt(src.retries, 0, 5, def.retries),
    hostIntervalMs: clampInt(src.hostIntervalMs, 0, 10000, def.hostIntervalMs),
    proxyPool: pool,
    autoFallback: src.autoFallback !== false,
    readerProxy: readerProxy,
  }
}

function normalizeBase(value) {
  const text = String(value == null ? '' : value).trim()
  if (!/^https?:\/\//i.test(text)) return DEFAULT_RSSHUB_BASE
  return text.replace(/\/+$/, '').slice(0, 200)
}

function idOf(url) {
  return createHash('sha1').update(String(url)).digest('hex')
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8')
  fs.renameSync(tmp, file)
}
function sizeOfFile(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}
function normalizeKeywords(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const word = String(item == null ? '' : item).trim()
    if (!word || out.includes(word)) continue
    out.push(word.slice(0, 40))
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}
function normalizeFeeds(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const type = ['rss', 'bing-news', 'google-news', 'rsshub', 'wallstcn', 'eastmoney'].includes(String(item.type || ''))
      ? String(item.type)
      : 'rss'
    const url = String(item.url || '').trim()
    const query = String(item.query || '').trim()
    const route = String(item.route || '').trim()
    if (type === 'rss' && !/^https?:\/\//i.test(url)) continue
    if (type === 'bing-news' && !query && !/^https?:\/\//i.test(url)) continue
    if (type === 'google-news' && !query && !/^https?:\/\//i.test(url)) continue
    if (type === 'rsshub' && !route && !/^https?:\/\//i.test(url)) continue
    const name = String(item.name || '').trim() || url || query || route || type
    const id = String(item.id || '').trim() || 'feed-' + out.length
    const category = String(item.category || '').trim().slice(0, 20)
    const filterSources = Array.isArray(item.filterSources)
      ? item.filterSources.map((s) => String(s).trim()).filter(Boolean).slice(0, 10)
      : []
    const entry = { id: id.slice(0, 40), name: name.slice(0, 60), type: type }
    if (url) entry.url = url
    if (query) entry.query = query
    if (route) entry.route = route
    if (item.hl) entry.hl = String(item.hl).slice(0, 20)
    if (item.gl) entry.gl = String(item.gl).slice(0, 10)
    if (item.ceid) entry.ceid = String(item.ceid).slice(0, 20)
    if (category) entry.category = category
    if (filterSources.length) entry.filterSources = filterSources
    if (out.some((f) => f.type === entry.type && (f.url || '') === (entry.url || '') && (f.query || '') === (entry.query || '') && (f.route || '') === (entry.route || ''))) continue
    out.push(entry)
    if (out.length >= MAX_FEEDS) break
  }
  return out
}

/**
 * Text-only article cache with hard caps (bytes/items/TTL) plus tiny favorites
 * and settings files. Everything is pruned aggressively so a dev machine never
 * accumulates a news archive.
 */
export function createStore(options) {
  const opts = options || {}
  const dataDir = opts.dataDir
  const cacheDir = path.join(dataDir, ARTICLE_DIR)
  fs.mkdirSync(cacheDir, { recursive: true })
  const indexPath = path.join(dataDir, INDEX_FILE)
  const favoritesPath = path.join(dataDir, FAVORITES_FILE)
  const settingsPath = path.join(dataDir, SETTINGS_FILE)

  const seed = Object.assign({}, DEFAULT_CAPS, { keywords: [], feeds: [], rsshubBase: 'https://rsshub.rssforever.com', antiBlock: DEFAULT_ANTIBLOCK, watchlist: DEFAULT_WATCHLIST, quoteRefreshSec: 5 }, readJson(settingsPath, {}), opts.settings || {})
  const settings = {
    maxBytes: Number(seed.maxBytes) || DEFAULT_CAPS.maxBytes,
    maxItems: Number(seed.maxItems) || DEFAULT_CAPS.maxItems,
    ttlHours: Number(seed.ttlHours) || DEFAULT_CAPS.ttlHours,
    keywords: normalizeKeywords(seed.keywords),
    feeds: normalizeFeeds(seed.feeds),
    rsshubBase: normalizeBase(seed.rsshubBase),
    antiBlock: normalizeAntiBlock(seed.antiBlock),
    watchlist: normalizeWatchlist(seed.watchlist),
    quoteRefreshSec: Math.max(3, Math.min(300, Number(seed.quoteRefreshSec) || 5)),
  }
  let index = readJson(indexPath, {})
  if (!index || typeof index !== 'object') index = {}
  let favorites = readJson(favoritesPath, {})
  if (!favorites || typeof favorites !== 'object') favorites = {}

  function saveIndex() {
    writeJson(indexPath, index)
  }
  function saveSettings() {
    writeJson(settingsPath, settings)
  }
  function saveFavorites() {
    writeJson(favoritesPath, favorites)
  }
  function totalBytes() {
    let sum = 0
    for (const id of Object.keys(index)) sum += sizeOfFile(path.join(cacheDir, id + '.json'))
    return sum
  }
  function removeEntry(id) {
    try {
      fs.rmSync(path.join(cacheDir, id + '.json'), { force: true })
    } catch {}
    delete index[id]
  }
  function prune() {
    const now = Date.now()
    const ttlMs = Math.max(1, settings.ttlHours) * 3600 * 1000
    for (const id of Object.keys(index)) {
      const entry = index[id]
      if (!entry || now - (entry.ts || 0) > ttlMs) removeEntry(id)
    }
    const remaining = Object.keys(index)
      .map((id) => ({ id: id, ts: index[id].ts || 0 }))
      .sort((a, b) => a.ts - b.ts)
    let bytes = totalBytes()
    while (remaining.length && (remaining.length > settings.maxItems || bytes > settings.maxBytes)) {
      const victim = remaining.shift()
      bytes -= sizeOfFile(path.join(cacheDir, victim.id + '.json'))
      removeEntry(victim.id)
    }
    saveIndex()
  }

  prune()

  return {
    dir: dataDir,
    cacheDir: cacheDir,
    caps() {
      return {
        maxBytes: settings.maxBytes,
        maxItems: settings.maxItems,
        ttlHours: settings.ttlHours,
      }
    },
    settings() {
      return JSON.parse(JSON.stringify(settings))
    },
    rsshubBase() {
      return settings.rsshubBase
    },
    antiBlock() {
      return JSON.parse(JSON.stringify(settings.antiBlock))
    },
    watchlist() {
      return JSON.parse(JSON.stringify(settings.watchlist))
    },
    quoteRefreshSec() {
      return settings.quoteRefreshSec
    },
    get(url) {
      const id = idOf(url)
      const entry = index[id]
      if (!entry) return null
      const ttlMs = Math.max(1, settings.ttlHours) * 3600 * 1000
      if (Date.now() - (entry.ts || 0) > ttlMs) {
        removeEntry(id)
        saveIndex()
        return null
      }
      const payload = readJson(path.join(cacheDir, id + '.json'), null)
      if (!payload || !payload.article) {
        removeEntry(id)
        saveIndex()
        return null
      }
      return payload.article
    },
    put(article) {
      if (!article || !article.original || !article.body) return
      const id = idOf(article.original)
      const payload = { article: article, ts: Date.now() }
      writeJson(path.join(cacheDir, id + '.json'), payload)
      index[id] = {
        url: article.original,
        title: article.title || '',
        sourceHost: article.sourceHost || '',
        chars: String(article.body).length,
        ts: Date.now(),
      }
      prune()
    },
    stats() {
      return {
        dataDir: dataDir,
        items: Object.keys(index).length,
        bytes: totalBytes(),
        maxBytes: settings.maxBytes,
        maxItems: settings.maxItems,
        ttlHours: settings.ttlHours,
      }
    },
    clear() {
      index = {}
      for (const file of fs.readdirSync(cacheDir)) {
        try {
          fs.rmSync(path.join(cacheDir, file), { force: true })
        } catch {}
      }
      saveIndex()
    },
    updateSettings(patch) {
      const p = patch && typeof patch === 'object' ? patch : {}
      if (Number.isFinite(Number(p.maxBytes))) settings.maxBytes = Math.max(1024 * 1024, Number(p.maxBytes))
      if (Number.isFinite(Number(p.maxItems))) settings.maxItems = Math.max(10, Math.floor(Number(p.maxItems)))
      if (Number.isFinite(Number(p.ttlHours))) settings.ttlHours = Math.max(1, Math.floor(Number(p.ttlHours)))
      if (Array.isArray(p.keywords)) settings.keywords = normalizeKeywords(p.keywords)
      if (Array.isArray(p.feeds)) settings.feeds = normalizeFeeds(p.feeds)
      if (typeof p.rsshubBase === 'string') settings.rsshubBase = normalizeBase(p.rsshubBase)
      if (p.antiBlock && typeof p.antiBlock === 'object') settings.antiBlock = normalizeAntiBlock(Object.assign({}, settings.antiBlock, p.antiBlock))
      if (Array.isArray(p.watchlist)) settings.watchlist = normalizeWatchlist(p.watchlist)
      if (Number.isFinite(Number(p.quoteRefreshSec))) settings.quoteRefreshSec = Math.max(3, Math.min(300, Math.floor(Number(p.quoteRefreshSec))))
      saveSettings()
      prune()
      return this.settings()
    },
    listFavorites() {
      return Object.keys(favorites)
        .map((url) => Object.assign({ url: url }, favorites[url]))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    },
    toggleFavorite(article) {
      if (!article || !article.original) return { added: false }
      const url = article.original
      if (favorites[url]) {
        delete favorites[url]
        saveFavorites()
        return { added: false }
      }
      favorites[url] = {
        title: article.title || '',
        sourceHost: article.sourceHost || '',
        ts: Date.now(),
      }
      saveFavorites()
      return { added: true }
    },
    removeFavorite(url) {
      delete favorites[url]
      saveFavorites()
    },
    isFavorite(url) {
      return Boolean(favorites[url])
    },
  }
}
