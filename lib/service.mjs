import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectSystemProxy, fetchText } from './net.mjs'
import { createStore, DEFAULT_CAPS } from './store.mjs'
import { DEFAULT_FEEDS, DEFAULT_RSSHUB_BASE, fetchFeeds } from './feed.mjs'
import { findReadable, searchWeb, rankHits } from './unwall.mjs'
import { DEFAULT_WATCHLIST, HISTORY_RANGES, fetchHistory, fetchQuotes } from './quotes.mjs'

const FEED_TTL_MS = 30 * 60 * 1000

/** Small, disposable cache location: %LOCALAPPDATA%/market-info on Windows. */
export function defaultDataDir() {
  const local = process.env.LOCALAPPDATA
  if (local) return path.join(local, 'dsh-market-info')
  return path.join(os.homedir(), '.dsh-market-info')
}

function readVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.1.0'
  } catch {
    return '0.1.0'
  }
}
function slugify(title) {
  const ascii = String(title || 'article')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return ascii || 'article'
}
/**
 * Assemble the plugin service: one shared store (text cache + favorites +
 * settings), feed aggregation with keyword filtering, the syndication reader,
 * and markdown export.
 */
export function createService(config, logger) {
  const cfg = config && typeof config === 'object' ? config : {}
  const log = typeof logger === 'function' ? logger : () => {}
  const dataDir = cfg.dataDir ? path.resolve(String(cfg.dataDir)) : defaultDataDir()
  let proxy = ''
  if (cfg.proxy === 'off') proxy = ''
  else if (typeof cfg.proxy === 'string' && cfg.proxy.length > 0 && cfg.proxy !== 'system') proxy = cfg.proxy
  else proxy = detectSystemProxy()
  const defaultFeeds = Array.isArray(cfg.feeds) && cfg.feeds.length ? cfg.feeds : DEFAULT_FEEDS
  const settingsSeed = Object.assign({}, DEFAULT_CAPS)
  for (const key of Object.keys(settingsSeed)) {
    if (cfg && Number.isFinite(Number(cfg[key]))) settingsSeed[key] = Number(cfg[key])
  }
  if (Array.isArray(cfg.keywords)) settingsSeed.keywords = cfg.keywords
  if (Array.isArray(cfg.feeds)) settingsSeed.feeds = cfg.feeds
  const store = createStore({ dataDir: dataDir, settings: settingsSeed })
  let feedCache = null
  let feedSignature = ''
  let quoteCache = null
  let quoteInFlight = null
  let quoteFailures = 0
  let quoteBlockedUntil = 0
  const historyCache = new Map()
  /** Per-source health counters, in memory only (lightweight, resets on restart). */
  const sourceHealth = new Map()

  function recordHealth(sources) {
    for (const row of sources || []) {
      const prev = sourceHealth.get(row.id) || {
        id: row.id,
        name: row.name,
        type: row.type,
        category: row.category,
        attempts: 0,
        okCount: 0,
        failCount: 0,
        totalMs: 0,
        lastMs: 0,
        lastOkAt: null,
        lastFailAt: null,
        lastError: '',
        fallbacks: 0,
        lastMode: 'direct',
      }
      prev.name = row.name
      prev.type = row.type
      prev.category = row.category
      prev.attempts += 1
      prev.lastMs = Number(row.ms) || 0
      prev.totalMs += prev.lastMs
      prev.lastMode = row.fallback ? 'fallback' : 'direct'
      if (row.fallback) prev.fallbacks += 1
      if (row.ok) {
        prev.okCount += 1
        prev.lastOkAt = Date.now()
      } else {
        prev.failCount += 1
        prev.lastFailAt = Date.now()
        prev.lastError = row.error || 'unknown error'
      }
      sourceHealth.set(row.id, prev)
    }
  }

  function healthRecords() {
    const list = []
    for (const entry of sourceHealth.values()) {
      const successRate = entry.attempts ? entry.okCount / entry.attempts : 0
      const avgMs = entry.attempts ? Math.round(entry.totalMs / entry.attempts) : 0
      let status = 'unknown'
      if (entry.attempts > 0) {
        if (entry.okCount === 0) status = 'fail'
        else if (entry.lastMode === 'fallback' || successRate < 0.6 || (entry.lastFailAt && entry.lastFailAt > (entry.lastOkAt || 0))) status = 'warn'
        else status = 'ok'
      }
      list.push({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        category: entry.category,
        attempts: entry.attempts,
        ok: entry.okCount,
        fail: entry.failCount,
        successRate: Math.round(successRate * 1000) / 1000,
        avgMs,
        lastMs: entry.lastMs,
        lastOkAt: entry.lastOkAt,
        lastFailAt: entry.lastFailAt,
        lastError: entry.lastError,
        fallbacks: entry.fallbacks,
        lastMode: entry.lastMode,
        status: status,
      })
    }
    return list.sort((a, b) => a.name.localeCompare(b.name))
  }

  function effectiveFeeds() {
    const custom = store.settings().feeds
    return custom.length ? custom : defaultFeeds
  }
  function currentSignature() {
    return JSON.stringify(effectiveFeeds()) + '|' + JSON.stringify(store.settings().keywords)
  }
  function antiBlockSettings() {
    return store.antiBlock()
  }
  /** Network options shared by feed/article/search requests (UA rotation, retries, proxy pool, politeness). */
  function netOptions(extra) {
    const ab = antiBlockSettings()
    const out = {
      proxy: proxy,
      proxies: ab.proxyPool.length ? ab.proxyPool.slice() : (proxy ? [proxy] : []),
      retries: ab.enabled ? ab.retries : 0,
      rotateUA: ab.enabled && ab.rotateUA,
      minIntervalMs: ab.enabled ? ab.hostIntervalMs : 0,
      readerProxy: ab.enabled ? ab.readerProxy : '',
      fallbackDirect: false,
    }
    return Object.assign(out, extra || {})
  }

  return {
    version: readVersion(),
    dataDir: dataDir,
    cfg() {
      return { dataDir: dataDir, proxy: proxy, feeds: effectiveFeeds() }
    },
    async feed(refresh, filters) {
      const f = filters || {}
      const keywords = Array.isArray(f.keywords) ? f.keywords.map((w) => String(w).trim()).filter(Boolean) : store.settings().keywords
      const category = String(f.category || '').trim()
      const source = String(f.source || '').trim()
      const signature = currentSignature()
      let data
      if (!refresh && feedCache && Date.now() - feedCache.at < FEED_TTL_MS && signature === feedSignature) {
        data = Object.assign({ cached: true }, feedCache.data)
      } else {
        const ab = antiBlockSettings()
        const fresh = await fetchFeeds(effectiveFeeds(), netOptions({ rsshubBase: store.rsshubBase(), autoFallback: ab.enabled && ab.autoFallback }))
        recordHealth(fresh.sources)
        feedCache = { at: Date.now(), data: fresh }
        feedSignature = signature
        data = Object.assign({ cached: false }, fresh)
      }
      const filtered = applyFilters(data, keywords, category, source)
      return {
        cached: data.cached === true,
        items: filtered.items,
        sources: data.sources,
        fetchedAt: data.fetchedAt,
        keywords: keywords,
        category: category,
        source: source,
      }
    },
    async quotes(refresh, overrides) {
      const sec = Math.max(3, store.quoteRefreshSec())
      const ttl = Math.max(2000, (sec - 1) * 1000)
      if (!refresh && quoteCache && Date.now() - quoteCache.at < ttl) {
        return Object.assign({ cached: true }, quoteCache.data)
      }
      if (Date.now() < quoteBlockedUntil) {
        if (quoteCache) return Object.assign({ cached: true, degraded: true }, quoteCache.data)
        return { quotes: [], missing: [], sources: [], fetchedAt: Date.now(), cached: false, degraded: true }
      }
      if (quoteInFlight) return quoteInFlight
      quoteInFlight = (async () => {
        try {
          const data = await fetchQuotes(store.watchlist(), Object.assign(netOptions({}), overrides || {}))
          if (data.quotes.length > 0) {
            quoteCache = { at: Date.now(), data: data }
            quoteFailures = 0
            return Object.assign({ cached: false, degraded: false }, data)
          }
          quoteFailures += 1
          if (quoteFailures >= 2) quoteBlockedUntil = Date.now() + 30000
          if (quoteCache) return Object.assign({ cached: true, degraded: true }, quoteCache.data)
          return Object.assign({ cached: false, degraded: true }, data)
        } finally {
          quoteInFlight = null
        }
      })()
      return quoteInFlight
    },
    async history(id, range, refresh) {
      const wanted = store.watchlist().find((item) => item.id === id) || DEFAULT_WATCHLIST.find((item) => item.id === id)
      if (!wanted) return { ok: false, error: 'unknown symbol: ' + String(id) }
      const span = HISTORY_RANGES.includes(range) ? range : '1d'
      const key = wanted.id + '|' + span
      const ttl = span === '1d' ? 30000 : 300000
      const hit = historyCache.get(key)
      if (!refresh && hit && Date.now() - hit.at < ttl) return Object.assign({ cached: true }, hit.data)
      const data = await fetchHistory(wanted, span, netOptions({}))
      if (!data) {
        if (hit) return Object.assign({ cached: true, stale: true }, hit.data)
        return { ok: false, error: 'no history for ' + wanted.id, id: wanted.id, range: span }
      }
      const payload = {
        ok: true,
        id: wanted.id,
        label: wanted.label,
        symbol: wanted.tv || wanted.yahoo || wanted.tencent || wanted.coingecko || wanted.id,
        range: span,
        points: data.points,
        high: data.high,
        low: data.low,
        prevClose: data.prevClose === undefined ? null : data.prevClose,
        price: data.price === undefined ? null : data.price,
        source: data.source,
        fetchedAt: Date.now(),
      }
      historyCache.set(key, { at: Date.now(), data: payload })
      return Object.assign({ cached: false }, payload)
    },
    async read(url, options) {
      const opts = options || {}
      if (!opts.refresh) {
        const hit = store.get(url)
        if (hit) return { ok: true, cached: true, article: hit }
      }
      const result = await findReadable(url, Object.assign(netOptions(), { log: log, title: opts.title ? String(opts.title) : '' }))
      if (!result.article) return { ok: false, candidates: result.candidates || [] }
      store.put(result.article)
      return { ok: true, cached: false, article: result.article }
    },
    presets() {
      return DEFAULT_FEEDS
    },
    health() {
      return healthRecords()
    },
    async netTest(target) {
      const url = String(target || '').trim()
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url must be http(s)' }
      const started = Date.now()
      try {
        const res = await fetchText(url, Object.assign(netOptions(), { timeoutMs: 20000 }))
        return {
          ok: res.status >= 200 && res.status < 400 && !res.blocked,
          status: res.status,
          blocked: res.blocked === true,
          blockKind: res.blockKind || '',
          viaProxy: res.viaProxy === true,
          attempts: res.attempts || 1,
          ms: Date.now() - started,
          chars: res.text.length,
          finalUrl: res.finalUrl,
          preview: res.text.replace(/\s+/g, ' ').slice(0, 160),
        }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e), ms: Date.now() - started }
      }
    },
    exportFeeds() {
      return {
        format: 'market-info-feeds',
        version: 1,
        exportedAt: new Date().toISOString(),
        rsshubBase: store.rsshubBase(),
        feeds: effectiveFeeds(),
      }
    },
    importFeeds(payload) {
      const raw = payload && typeof payload === 'object' && Array.isArray(payload.feeds) ? payload.feeds : (Array.isArray(payload) ? payload : [])
      if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'no feeds in payload' }
      const patch = { feeds: raw }
      if (typeof payload.rsshubBase === 'string') patch.rsshubBase = payload.rsshubBase
      store.updateSettings(patch)
      feedCache = null
      feedSignature = ''
      return { ok: true, imported: effectiveFeeds().length, feeds: effectiveFeeds(), rsshubBase: store.rsshubBase() }
    },
    async search(query) {
      const q = String(query || '').trim()
      if (!q) return { ok: false, error: 'empty query' }
      const hits = await searchWeb(q, Object.assign(netOptions(), { log: log }))
      return { ok: true, query: q, results: rankHits(hits, q).slice(0, 20) }
    },
    async exportMarkdown(url) {
      const target = String(url || '')
      if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'url must be http(s)' }
      let article = store.get(target)
      if (!article) {
        const result = await findReadable(target, Object.assign(netOptions(), { log: log }))
        if (!result.article) return { ok: false, error: 'no readable copy', candidates: result.candidates || [] }
        article = result.article
        store.put(article)
      }
      const markdown = '# ' + (article.title || 'Untitled') + '\n\n- 转载来源: ' + article.sourceUrl + '\n- 原始链接: ' + article.original + '\n\n' + article.body + '\n'
      return { ok: true, markdown: markdown, filename: slugify(article.title) + '.md', article: article }
    },
    cache() {
      return store.stats()
    },
    clearCache() {
      store.clear()
      return store.stats()
    },
    favorites() {
      return store.listFavorites()
    },
    toggleFavorite(article) {
      return store.toggleFavorite(article)
    },
    removeFavorite(url) {
      store.removeFavorite(url)
      return store.listFavorites()
    },
    isFavorite(url) {
      return store.isFavorite(url)
    },
    settings() {
      const settings = store.settings()
      return Object.assign({}, store.caps(), {
        proxy: proxy,
        proxyMode: cfg.proxy === 'off' ? 'off' : cfg.proxy && cfg.proxy !== 'system' ? 'manual' : 'system',
        feeds: effectiveFeeds(),
        rsshubBase: settings.rsshubBase,
        antiBlock: settings.antiBlock,
        watchlist: settings.watchlist,
        quoteRefreshSec: settings.quoteRefreshSec,
        keywords: settings.keywords,
        version: readVersion(),
        dataDir: dataDir,
      })
    },
    updateSettings(patch) {
      const p = patch && typeof patch === 'object' ? patch : {}
      if (typeof p.proxy === 'string') {
        if (p.proxy === 'off') proxy = ''
        else if (p.proxy === 'system' || p.proxy === '') proxy = detectSystemProxy()
        else proxy = p.proxy
      }
      store.updateSettings(p)
      feedCache = null
      feedSignature = ''
      quoteCache = null
      historyCache.clear()
      return this.settings()
    },
  }
}

function matchesKeywords(item, keywords) {
  if (!keywords || keywords.length === 0) return true
  const hay = (String(item.title || '') + ' ' + String(item.summary || '') + ' ' + String(item.creator || '')).toLowerCase()
  return keywords.some((word) => hay.includes(String(word).toLowerCase()))
}

function applyFilters(data, keywords, category, source) {
  let items = data.items || []
  if (keywords && keywords.length) items = items.filter((item) => matchesKeywords(item, keywords))
  if (category) items = items.filter((item) => String(item.category || '') === category)
  if (source) items = items.filter((item) => item.sourceId === source || item.source === source)
  return { items: items }
}

