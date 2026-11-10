import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectSystemProxy, fetchText } from './net.mjs'
import { createStore, DEFAULT_CAPS } from './store.mjs'
import { DEFAULT_FEEDS, DEFAULT_RSSHUB_BASE, fetchFeeds } from './feed.mjs'
import { findReadable, searchWeb, rankHits } from './unwall.mjs'
import { DEFAULT_WATCHLIST, HISTORY_RANGES, fetchHistory, fetchQuotes } from './quotes.mjs'
import { adapters as SOURCE_ADAPTERS } from './sources/all.mjs'
import { createSourceLayer } from './sources/index.mjs'
import { getJson as fastGetJson, request as fastRequest } from './net-fast.mjs'
import { createCompanyDesk } from './company.mjs'
import { createSeriesStore, TRACKED_SERIES } from './series.mjs'

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
  let feedInFlight = null
  let quoteCache = null
  let quoteInFlight = null
  let quoteFailures = 0
  let quoteBlockedUntil = 0
  const historyCache = new Map()
  /** Per-source health counters, in memory only (lightweight, resets on restart). */
  const sourceHealth = new Map()
  /**
   * Third data plane: official disclosure / macro / policy / flows.
   * It owns its own SWR cache and hardware fast-path, so it stays independent of
   * the feed and quote caches.
   */
  const sourceLayer = createSourceLayer({
    adapters: SOURCE_ADAPTERS,
    log: (message) => log('[sources] ' + message),
  })
  /** Ids already shown in a brief; null until the first brief runs. */
  let briefSeen = null
  /** Per-company dossier: entity resolution + quote + financials + filings + reports. */
  const companyDesk = createCompanyDesk({
    sourceLayer: sourceLayer,
    log: (message) => log('[company] ' + message),
  })
  const companyDeps = { getJson: fastGetJson, request: fastRequest }
  /**
   * Headlines mentioning one company, read from the news plane's own cache. No
   * extra network call: if the panel has not loaded the feed yet the leg simply
   * reports that instead of adding a slow request to the dossier.
   */
  companyDeps.newsFor = async function (name) {
    const needle = String(name || '').trim().toLowerCase()
    if (needle.length < 2) return []
    if (!feedCache || !feedCache.data || !Array.isArray(feedCache.data.items)) return []
    const hits = []
    for (const item of feedCache.data.items) {
      const hay = (String(item.title || '') + ' ' + String(item.summary || '')).toLowerCase()
      if (hay.indexOf(needle) < 0) continue
      hits.push({
        id: 'news:' + item.id,
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt,
        summary: item.summary,
        source: item.source || item.sourceId || '',
      })
      if (hits.length >= 12) break
    }
    return hits
  }
  /** Derived-number history (PCR, rate spreads, BDI) persisted next to settings. */
  const seriesStore = createSeriesStore({ dataDir: dataDir, log: (message) => log('[series] ' + message) })

  /**
   * Backfill the tracked series from public history so a fresh install opens on a
   * real curve instead of a single point.
   *
   *   rates.*      Eastmoney treasury curve report, 60 rows (~3 months of trading days)
   *   shipping.bdi Eastmoney daily kline for the index
   *   options.pcr  no public history source — forward-only, and we say so
   */
  let backfillState = 'idle'
  async function ensureBackfill(force) {
    if (force) {
      backfillState = 'idle'
      seriesStore.clear()
    }
    if (backfillState === 'done' || backfillState === 'running') return
    backfillState = 'running'
    try {
      const curve = await fastGetJson(
        'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD' +
          '&columns=ALL&pageSize=60&sortColumns=SOLAR_DATE&sortTypes=-1&source=WEB&client=WEB',
        { timeoutMs: 15000, accept: 'application/json' },
      )
      const rows = curve && curve.json && curve.json.result && Array.isArray(curve.json.result.data) ? curve.json.result.data : []
      const cn10 = []
      const us10y2y = []
      const spread = []
      for (const row of rows) {
        const at = Date.parse(String(row.SOLAR_DATE || '').slice(0, 10) + 'T00:00:00Z')
        if (!Number.isFinite(at)) continue
        const cn = Number(row.EMM00166469)
        const us10 = Number(row.EMG00001310)
        const us2 = Number(row.EMG00001306)
        if (Number.isFinite(cn)) cn10.push({ t: at, v: cn })
        if (Number.isFinite(us10) && Number.isFinite(us2)) us10y2y.push({ t: at, v: (us10 - us2) * 100 })
        if (Number.isFinite(us10) && Number.isFinite(cn)) spread.push({ t: at, v: (us10 - cn) * 100 })
      }
      const a = seriesStore.backfill('rates.cn-10y', cn10)
      const b = seriesStore.backfill('rates.us-10y2y', us10y2y)
      const c = seriesStore.backfill('rates.cn-us-10y', spread)

      // VIX has a public full-history CSV, so its curve needs no local accumulation.
      // Only fetched when the series is empty: a fresh machine pays once, steady
      // state pays nothing.
      if (seriesStore.series('volatility.vix', 2).length < 2) {
        try {
          const csv = await fetchText(
            'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv',
            { timeoutMs: 20000, headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/csv,*/*' } },
          )
          const lines = String((csv && csv.text) || '').trim().split(/\r?\n/)
          const points = []
          for (const line of lines.slice(1)) {
            const parts = line.split(',')
            if (parts.length < 5) continue
            // CBOE writes MM/DD/YYYY, not ISO — Date.parse handles that directly.
            const at = Date.parse(parts[0])
            const close = Number(parts[4])
            if (Number.isFinite(at) && Number.isFinite(close)) points.push({ t: at, v: close })
          }
          const added = seriesStore.backfill('volatility.vix', points.slice(-120))
          log('[series] backfilled vix=' + added)
        } catch (error) {
          log('[series] vix backfill failed: ' + String(error && error.message ? error.message : error))
        }
      }
      // Margin financing has a public daily history report; the balance is
      // RZYE (融资余额) + RQYE (融券余额), both in yuan.
      try {
        const marginUrl =
          'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ' +
          '&columns=ALL&pageSize=90&sortColumns=DIM_DATE&sortTypes=-1&source=WEB&client=WEB'
        const marginRes = await fastGetJson(marginUrl, { timeoutMs: 15000, accept: 'application/json' })
        const marginRows =
          marginRes && marginRes.json && marginRes.json.result && Array.isArray(marginRes.json.result.data)
            ? marginRes.json.result.data
            : []
        const marginPoints = []
        for (const row of marginRows) {
          const at = Date.parse(String(row.DIM_DATE || '').slice(0, 10) + 'T00:00:00Z')
          const balance = (Number(row.RZYE) + Number(row.RQYE)) / 1e8
          if (Number.isFinite(at) && Number.isFinite(balance) && balance > 0) marginPoints.push({ t: at, v: balance })
        }
        const m = seriesStore.backfill('funding.margin', marginPoints)
        log('[series] backfilled margin=' + m)
      } catch (error) {
        log('[series] margin backfill failed: ' + String(error && error.message ? error.message : error))
      }

      // Full-market main net inflow: the sum of the two index flows equals the
      // all-A share total (verified once against 5,218 stocks: −524.97 vs −524.95 亿).
      // Two requests instead of the 100 an industry aggregation would need.
      try {
        const parts = []
        for (const secid of ['1.000001', '0.399001']) {
          const res = await fastGetJson(
            'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=0&klt=101&secid=' + secid +
              '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',
            { timeoutMs: 15000, accept: 'application/json' },
          )
          const klines = res && res.json && res.json.data && Array.isArray(res.json.data.klines) ? res.json.data.klines : []
          parts.push(klines)
        }
        const byDate = new Map()
        for (const klines of parts) {
          for (const line of klines) {
            const cells = String(line).split(',')
            const at = Date.parse(cells[0] + 'T00:00:00Z')
            const net = Number(cells[1])
            if (!Number.isFinite(at) || !Number.isFinite(net)) continue
            byDate.set(at, (byDate.get(at) || 0) + net / 1e8)
          }
        }
        const points = Array.from(byDate.entries()).map((pair) => ({ t: pair[0], v: pair[1] }))
        const added = seriesStore.backfill('flow.market-net', points)
        log('[series] backfilled market-net=' + added)
      } catch (error) {
        log('[series] market-net backfill failed: ' + String(error && error.message ? error.message : error))
      }
      // Market turnover: same two indices, kline f57 carries the amount in yuan.
      try {
        const sums = new Map()
        for (const secid of ['1.000001', '0.399001']) {
          const res = await fastGetJson(
            'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid +
              '&klt=101&fqt=0&lmt=120&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57',
            { timeoutMs: 15000, accept: 'application/json' },
          )
          const klines = res && res.json && res.json.data && Array.isArray(res.json.data.klines) ? res.json.data.klines : []
          for (const line of klines) {
            const cells = String(line).split(',')
            const at = Date.parse(cells[0] + 'T00:00:00Z')
            const amount = Number(cells[6])
            if (!Number.isFinite(at) || !Number.isFinite(amount)) continue
            sums.set(at, (sums.get(at) || 0) + amount / 1e8)
          }
        }
        const points = Array.from(sums.entries()).map((pair) => ({ t: pair[0], v: pair[1] }))
        log('[series] backfilled market-turnover=' + seriesStore.backfill('flow.market-turnover', points))
      } catch (error) {
        log('[series] market-turnover backfill failed: ' + String(error && error.message ? error.message : error))
      }

      // Cross-border flows. Northbound net buy is no longer disclosed at all
      // (FUND_INFLOW/NET_DEAL_AMT are null for 001/003/005), so only the northbound
      // turnover and the still-published southbound net buy go into the series.
      //   MUTUAL_TYPE: 001=沪股通 003=深股通 005=北向合计; 002=港股通(沪) 004=港股通(深) 006=南向合计
      try {
        const mutualUrl =
          'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_MUTUAL_DEAL_HISTORY' +
          '&columns=ALL&pageSize=800&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB'
        const mutualRes = await fastGetJson(mutualUrl, { timeoutMs: 25000, accept: 'application/json' })
        const mutualRows =
          mutualRes && mutualRes.json && mutualRes.json.result && Array.isArray(mutualRes.json.result.data)
            ? mutualRes.json.result.data
            : []
        const turnover = []
        const southNet = []
        for (const row of mutualRows) {
          const at = Date.parse(String(row.TRADE_DATE || '').slice(0, 10) + 'T00:00:00Z')
          if (!Number.isFinite(at)) continue
          if (row.MUTUAL_TYPE === '005' && Number.isFinite(Number(row.DEAL_AMT))) {
            turnover.push({ t: at, v: Number(row.DEAL_AMT) / 100 })
          }
          if (row.MUTUAL_TYPE === '006' && Number.isFinite(Number(row.NET_DEAL_AMT))) {
            southNet.push({ t: at, v: Number(row.NET_DEAL_AMT) / 100 })
          }
        }
        const nb = seriesStore.backfill('flow.northbound-turnover', turnover)
        const sb = seriesStore.backfill('flow.southbound-net', southNet)
        log('[series] backfilled northbound-turnover=' + nb + ' southbound-net=' + sb)
      } catch (error) {
        log('[series] mutual backfill failed: ' + String(error && error.message ? error.message : error))
      }

      const kline = await fastGetJson(
        'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=100.BDI&klt=101&fqt=0&lmt=60&end=20500101' +
          '&fields1=f1,f2,f3,f4&fields2=f51,f53',
        { timeoutMs: 15000, accept: 'application/json' },
      )
      const lines = kline && kline.json && kline.json.data && Array.isArray(kline.json.data.klines) ? kline.json.data.klines : []
      const bdi = []
      for (const line of lines) {
        const parts = String(line).split(',')
        const at = Date.parse(parts[0] + 'T00:00:00Z')
        const value = Number(parts[1])
        if (Number.isFinite(at) && Number.isFinite(value)) bdi.push({ t: at, v: value })
      }
      // Repo rates have a daily kline too, so the overnight funding price gets the
      // same 60-day treatment as the bond curve.
      const repoKline = await fastGetJson(
        'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.204001&klt=101&fqt=0&lmt=60&end=20500101' +
          '&fields1=f1,f2,f3,f4&fields2=f51,f53',
        { timeoutMs: 15000, accept: 'application/json' },
      )
      const repoLines = repoKline && repoKline.json && repoKline.json.data && Array.isArray(repoKline.json.data.klines)
        ? repoKline.json.data.klines
        : []
      const gc = []
      for (const line of repoLines) {
        const parts = String(line).split(',')
        const at = Date.parse(parts[0] + 'T00:00:00Z')
        const value = Number(parts[1])
        if (Number.isFinite(at) && Number.isFinite(value)) gc.push({ t: at, v: value })
      }
      const e = seriesStore.backfill('money.gc001', gc)
      const d = seriesStore.backfill('shipping.bdi', bdi)
      backfillState = 'done'
      log('[series] backfilled rates cn10y=' + a + ' us10y2y=' + b + ' cn-us=' + c + ' bdi=' + d + ' gc001=' + e)
    } catch (error) {
      backfillState = 'idle'
      log('[series] backfill failed: ' + String(error && error.message ? error.message : error))
    }
  }
  const SERIES_SOURCES = ['treasury-curve', 'option-board', 'bdi', 'repo-rates']

  /**
   * Record tracked history straight from the sources that produce it. Reading the
   * merged collection would be wrong: the response is balanced and sliced, so the
   * items a series depends on may simply not be in the returned page.
   */
  async function recordSeries() {
    const results = await Promise.all(
      SERIES_SOURCES.map((id) => sourceLayer.fetchOne(id, {}, {}).catch(() => null)),
    )
    const items = []
    for (const result of results) {
      for (const item of (result && result.items) || []) items.push(item)
    }
    for (const entry of TRACKED_SERIES) {
      const value = entry.pick(items)
      if (Number.isFinite(value)) seriesStore.append(entry.id, value)
    }
    // Margin balance is not in the collected items: append it from its own report,
    // at most every six hours (the underlying series is daily anyway).
    try {
      const points = seriesStore.series('funding.margin', 2)
      const lastAt = points.length ? points[points.length - 1].t : 0
      if (Date.now() - lastAt > 6 * 3600 * 1000) {
        const res = await fastGetJson(
          'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ' +
            '&columns=ALL&pageSize=1&sortColumns=DIM_DATE&sortTypes=-1&source=WEB&client=WEB',
          { timeoutMs: 12000, accept: 'application/json' },
        )
        const row = res && res.json && res.json.result && res.json.result.data && res.json.result.data[0]
        if (row) {
          const at = Date.parse(String(row.DIM_DATE || '').slice(0, 10) + 'T00:00:00Z')
          const balance = (Number(row.RZYE) + Number(row.RQYE)) / 1e8
          if (Number.isFinite(at) && Number.isFinite(balance) && balance > 0) {
            seriesStore.append('funding.margin', balance, at)
          }
        }
      }
    } catch (error) {
      log('[series] margin append failed: ' + String(error && error.message ? error.message : error))
    }
    // Same light touch for the cross-border flows: one report call, at most once
    // every six hours, appending the aggregate rows (005 northbound turnover,
    // 006 southbound net).
    try {
      const flowPoints = seriesStore.series('flow.southbound-net', 2)
      const flowLastAt = flowPoints.length ? flowPoints[flowPoints.length - 1].t : 0
      const lastTradingDay = Date.now() - 20 * 3600 * 1000
      if (flowLastAt < lastTradingDay) {
        const res = await fastGetJson(
          'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_MUTUAL_DEAL_HISTORY' +
            '&columns=ALL&pageSize=6&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB',
          { timeoutMs: 12000, accept: 'application/json' },
        )
        const rows = res && res.json && res.json.result && res.json.result.data ? res.json.result.data : []
        for (const row of rows) {
          const at = Date.parse(String(row.TRADE_DATE || '').slice(0, 10) + 'T00:00:00Z')
          if (!Number.isFinite(at)) continue
          if (row.MUTUAL_TYPE === '005' && Number.isFinite(Number(row.DEAL_AMT))) {
            seriesStore.append('flow.northbound-turnover', Number(row.DEAL_AMT) / 100, at)
          }
          if (row.MUTUAL_TYPE === '006' && Number.isFinite(Number(row.NET_DEAL_AMT))) {
            seriesStore.append('flow.southbound-net', Number(row.NET_DEAL_AMT) / 100, at)
          }
        }
      }
    } catch (error) {
      log('[series] flow append failed: ' + String(error && error.message ? error.message : error))
    }
    // Full-market net inflow: two index series, appended once a day (it is a daily
    // figure). Same throttle idea as above, so steady state costs two requests a day.
    try {
      const points = seriesStore.series('flow.market-net', 2)
      const lastAt = points.length ? points[points.length - 1].t : 0
      if (lastAt < Date.now() - 20 * 3600 * 1000) {
        const sums = new Map()
        for (const secid of ['1.000001', '0.399001']) {
          const res = await fastGetJson(
            'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=5&klt=101&secid=' + secid +
              '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',
            { timeoutMs: 12000, accept: 'application/json' },
          )
          const klines = res && res.json && res.json.data && Array.isArray(res.json.data.klines) ? res.json.data.klines : []
          for (const line of klines) {
            const cells = String(line).split(',')
            const at = Date.parse(cells[0] + 'T00:00:00Z')
            const net = Number(cells[1])
            if (!Number.isFinite(at) || !Number.isFinite(net)) continue
            sums.set(at, (sums.get(at) || 0) + net / 1e8)
          }
        }
        for (const pair of sums.entries()) seriesStore.append('flow.market-net', pair[1], pair[0])
      }
    } catch (error) {
      log('[series] market-net append failed: ' + String(error && error.message ? error.message : error))
    }
  }
  /**
   * Prefetch the hot set shortly after the plugin loads. Fire-and-forget: the
   * panel's first open then renders from a warm cache instead of waiting on the
   * network. Disable with config `warmSources: false`.
   */
  if (cfg.warmSources !== false) {
    const timer = setTimeout(() => {
      try {
        // Warm the whole plane: the panel should open on a populated cache, and the
        // per-adapter cache is cheap. Each request runs through its own pacing.
        sourceLayer.warm()
        // Fresh installs should open on a real curve, not a single point.
        ensureBackfill().catch(() => {})
      } catch {}
    }, 1500)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

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

  function invalidateFeed() {
    feedCache = null
    feedInFlight = null
  }

  function refreshFeed(signature) {
    if (feedInFlight?.signature === signature) return feedInFlight.request
    const ab = antiBlockSettings()
    const request = fetchFeeds(
      effectiveFeeds(),
      netOptions({ rsshubBase: store.rsshubBase(), autoFallback: ab.enabled && ab.autoFallback }),
    ).then((fresh) => {
      if (feedInFlight?.request === request) {
        recordHealth(fresh.sources)
        feedCache = { at: Date.now(), data: fresh, signature }
      }
      return fresh
    }).finally(() => {
      if (feedInFlight?.request === request) feedInFlight = null
    })
    feedInFlight = { signature, request }
    return request
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
      if (!refresh && feedCache && Date.now() - feedCache.at < FEED_TTL_MS && signature === feedCache.signature) {
        data = Object.assign({ cached: true }, feedCache.data)
      } else {
        data = Object.assign({ cached: false }, await refreshFeed(signature))
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
    /** Every registered adapter plus live health/latency (diagnostics tab). */
    sources() {
      return {
        sources: sourceLayer.list(),
        stats: sourceLayer.stats(),
        categories: sourceLayer.categories,
        regions: sourceLayer.regions,
        cadences: sourceLayer.cadences,
        domains: sourceLayer.domains,
      }
    },
    sourceStats() {
      return sourceLayer.stats()
    },
    /** Raw cross-source collection: disclosures, macro, policy, flows, sanctions. */
    async collect(query) {
      const result = await sourceLayer.collect(query || {})
      // Record the derived numbers worth trending. Cheap: five lookups per call.
      recordSeries().catch((error) => log('[series] record failed: ' + String(error && error.message ? error.message : error)))
      return result
    },
    /** Persisted history for the tracked derived series. */
    async series(options) {
      // rebuild:true throws the local cache away and regenerates it from public
      // sources — that is the whole migration story (the file is a cache, not data).
      await ensureBackfill(options && options.rebuild === true)
      return {
        tracked: TRACKED_SERIES.map((entry) => {
          const points = seriesStore.series(entry.id, 120)
          // Say out loud which series are forward-only: an empty sparkline should
          // read as "no public history source", not as a broken feature.
          return {
            id: entry.id,
            label: entry.label,
            unit: entry.unit,
            points: points,
            hasHistory: points.length >= 2,
            note: points.length >= 2
              ? ''
              : entry.id === 'options.pcr'
                ? '无公开历史源（东财无 PCR 报表、上交所返回 data:null），从首次运行起向前累积'
                : '采样不足 2 个点，等待下一轮刷新',
          }
        }),
      }
    },
    /** One adapter, honouring its own cache. */
    async fetchSource(id, params, refresh) {
      return sourceLayer.fetchOne(String(id || ''), params || {}, { refresh: refresh === true })
    },
    /** Company dossier for a name, pinyin or ticker. */
    async company(query, options) {
      const o = options || {}
      return companyDesk.dossier(query, {
        deps: companyDeps,
        from: o.from ? String(o.from) : '',
        to: o.to ? String(o.to) : '',
        limit: o.limit,
        refresh: o.refresh === true,
      })
    },
    /** Ranked entity candidates only (cheap; used by the search box). */
    async companies(query) {
      const rows = await companyDesk.resolve(query, { deps: companyDeps })
      return { ok: true, query: String(query || ''), candidates: rows.slice(0, 12) }
    },
    /**
     * A deterministic "what happened" digest over the official-source plane.
     *
     * No model call and no network beyond the adapters' own caches, so it is safe
     * to poll. `newCount` / `fresh` compare against the previous brief in the same
     * process, which is what the panel badge and the alert path use.
     */
    async brief(options) {
      const opts = options || {}
      const limit = Math.min(Math.max(Number(opts.limit) || 120, 20), 400)
      const data = await sourceLayer.collect({ limit: limit, refresh: opts.refresh === true })
      const items = data.items || []
      const groups = {}
      for (const key of Object.keys(sourceLayer.categories)) groups[key] = []
      for (const item of items) {
        const bucket = groups[item.category] || (groups[item.category] = [])
        if (bucket.length < 10) bucket.push(item)
      }
      // Domain roll-up: the same items seen through the seven-question lens.
      const domainGroups = {}
      for (const key of Object.keys(sourceLayer.domains || {})) {
        domainGroups[key] = { id: key, label: sourceLayer.domains[key], count: 0, categories: {}, top: [] }
      }
      for (const item of items) {
        const bucket = domainGroups[item.domain]
        if (!bucket) continue
        bucket.count += 1
        bucket.categories[item.category] = (bucket.categories[item.category] || 0) + 1
        if (bucket.top.length < 3) bucket.top.push({ title: item.title, source: item.source, url: item.url })
      }
      const previous = briefSeen
      const fresh = []
      for (const item of items) {
        if (previous && !previous.has(item.id)) fresh.push(item)
      }
      const next = new Set(items.map((item) => item.id))
      if (previous) for (const id of previous) if (next.size < 4000) next.add(id)
      briefSeen = next
      return {
        ok: true,
        fetchedAt: data.fetchedAt,
        ms: data.ms,
        total: items.length,
        newCount: previous ? fresh.length : 0,
        firstRun: !previous,
        groups: groups,
        domains: domainGroups,
        fresh: fresh.slice(0, 40),
        sources: data.sources,
      }
    },
    sourceHealthRows() {
      return sourceLayer.stats().sources
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
      invalidateFeed()
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
      invalidateFeed()
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

