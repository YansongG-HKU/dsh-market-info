/**
 * Source adapter layer.
 *
 * The panel already has two data planes: `feed.mjs` (news) and `quotes.mjs`
 * (prices). This is the third one: official disclosures, macro releases, policy,
 * flows and sanctions — the "facts" layer that no news source can substitute for.
 *
 * Every source is an adapter object collected in an `adapters` array exported by
 * one module under lib/sources/. The contract is documented in
 * docs/SOURCE-CONTRACT.md; the runner below gives all of them the same behaviour:
 *
 *   stale-while-revalidate cache · single-flight · per-source deadline ·
 *   politeness pacing · parallel fan-out · health and latency accounting.
 *
 * Adapters never throw. An adapter that fails returns whatever it has; the runner
 * records the failure and keeps the last good payload for the UI.
 */
import { getJson, postJson, request, mapLimit, withTimeout, poolStats } from '../net-fast.mjs'

/** Human labels for the categories the UI groups by. */
export const CATEGORIES = {
  // pricing — what things trade at
  futures: '期货',
  fx: '外汇',
  rates: '利率',
  volatility: '波动率',
  options: '期权',
  prediction: '预测',
  // funding — where money goes
  flow: '资金流',
  money: '资金利率',
  bond: '债券',
  // issuer — what companies disclose
  filing: '披露',
  corporate: '公司行动',
  research: '研报',
  // macro — the backdrop
  macro: '宏观',
  policy: '政策',
  industry: '行业',
  // risk — what can break
  sanction: '制裁',
  geo: '地缘',
  weather: '气候',
  // real — physical economy
  shipping: '航运',
  flash: '快讯',
}

/**
 * Domains group categories into the six questions a finance panel has to answer:
 * what it costs, where money moves, what issuers say, what the macro backdrop is,
 * what could break, and what the physical economy is doing.
 */
export const DOMAINS = {
  pricing: '价格与交易',
  funding: '资金与利率',
  issuer: '发行人与披露',
  macro: '宏观与政策',
  risk: '风险与合规',
  real: '实体运行',
  wire: '快讯与事件',
}

const DOMAIN_BY_CATEGORY = {
  futures: 'pricing',
  fx: 'pricing',
  rates: 'pricing',
  volatility: 'pricing',
  options: 'pricing',
  prediction: 'pricing',
  flow: 'funding',
  money: 'funding',
  bond: 'funding',
  filing: 'issuer',
  corporate: 'issuer',
  research: 'issuer',
  macro: 'macro',
  policy: 'macro',
  industry: 'macro',
  sanction: 'risk',
  geo: 'risk',
  weather: 'risk',
  shipping: 'real',
  flash: 'wire',
}

function domainOf(adapter) {
  return DOMAIN_BY_CATEGORY[adapter && adapter.category] || ''
}

/**
 * Refresh cadence tiers, assigned per source from measured live behaviour
 * (see `_scratch/measure-cadence.mjs`: newest-item age + median gap between items).
 *
 *   T0 实时   盘中逐笔 / 秒级        30 s
 *   T1 快速   分钟到半小时           10 min
 *   T2 常规   小时级                 3 h
 *   T3 低频   日 / 周 / 月级          12 h
 *
 * Cadence is the single source of truth for TTL: an adapter does not get to pick a
 * value that contradicts what its publisher actually does.
 */
export const CADENCES = {
  T0: { id: 'T0', label: '实时', ttlMs: 30 * 1000, hint: '盘中逐笔级：期货、板块、快讯、延迟报价' },
  T1: { id: 'T1', label: '快速', ttlMs: 10 * 60 * 1000, hint: '分钟到半小时：公告、研报、资金流、天气、预测市场' },
  T2: { id: 'T2', label: '常规', ttlMs: 3 * 60 * 60 * 1000, hint: '小时级：央行、宏观数据、航运指数、灾害事件' },
  T3: { id: 'T3', label: '低频', ttlMs: 12 * 60 * 60 * 1000, hint: '日 / 周 / 月级：制裁名单、COT、月报、季度报表' },
}

/** Measured assignment. Anything not listed falls back to the category TTL. */
const CADENCE_BY_ID = {
  // T0 — quote-like, changes within the session
  'fut-cn': 'T0',
  'fut-global': 'T0',
  sector: 'T0',
  cboe: 'T0',
  'sina-live': 'T0',
  'ths-live': 'T0',
  'fx-major': 'T0',
  'repo-rates': 'T0',
  'option-board': 'T0',
  // T1 — publishes through the day, or refreshed from a daily table
  cninfo: 'T1',
  sse: 'T1',
  szse: 'T1',
  hkex: 'T1',
  'sec-fulltext': 'T1',
  'em-report': 'T1',
  blocktrade: 'T1',
  'un-news': 'T1',
  gdelt: 'T1',
  hsgt: 'T1',
  lhb: 'T1',
  'ths-fundflow': 'T1',
  weather: 'T1',
  marine: 'T1',
  polymarket: 'T1',
  kalshi: 'T1',
  manifold: 'T1',
  metaculus: 'T1',
  // T2 — a handful of updates a day
  bdi: 'T2',
  cfets: 'T2',
  fed: 'T2',
  ecb: 'T2',
  pbc: 'T2',
  nbs: 'T2',
  eonet: 'T2',
  fred: 'T2',
  margin: 'T2',
  'treasury-curve': 'T2',
  dividend: 'T2',
  lift: 'T2',
  'holder-change': 'T2',
  forecast: 'T2',
  // T3 — weekly / monthly / quarterly
  ofac: 'T3',
  treasury: 'T3',
  'sec-xbrl': 'T3',
  cftc: 'T3',
  safe: 'T3',
  customs: 'T3',
  bls: 'T3',
  'cb-issue': 'T3',
}

function cadenceOf(adapter) {
  if (!adapter) return null
  // An adapter may declare its own cadence (used by tests and new sources);
  // otherwise the measured registry above decides.
  if (adapter.cadence && CADENCES[adapter.cadence]) return CADENCES[adapter.cadence]
  return CADENCES[CADENCE_BY_ID[adapter.id]] || null
}

export const REGIONS = {
  CN: '中国',
  US: '美国',
  EU: '欧洲',
  JP: '日本',
  HK: '香港',
  GLOBAL: '全球',
}

/** Cache lifetimes keyed by category: disclosures move slowly, macro prints are day-scale. */
const TTL_BY_CATEGORY = {
  filing: 20 * 60 * 1000,
  macro: 60 * 60 * 1000,
  policy: 60 * 60 * 1000,
  flow: 6 * 60 * 60 * 1000,
  sanction: 12 * 60 * 60 * 1000,
  volatility: 60 * 1000,
  flash: 2 * 60 * 1000,
  research: 30 * 60 * 1000,
  industry: 5 * 60 * 1000,
  futures: 15 * 1000,
  prediction: 10 * 60 * 1000,
  shipping: 30 * 60 * 1000,
  geo: 10 * 60 * 1000,
  weather: 30 * 60 * 1000,
}

const DEFAULT_DEADLINE_MS = 6500
/** How long a collection waits before answering with whatever is ready. */
const DEFAULT_BUDGET_MS = 6000
/**
 * Adapter concurrency. Each adapter fans out to 1–6 HTTP requests, so launching all
 * 33 at once saturates the egress and unrelated hosts start timing out. Ten at a
 * time is reliable; the warm cache is what keeps the panel fast, not a wider burst.
 */
const ADAPTER_CONCURRENCY = 10

function nowMs() {
  return Date.now()
}

/**
 * Stable cache key from the handful of params adapters actually use.
 *
 * `limit` is deliberately NOT part of the key: it is a display-side slice, and
 * letting it in fragments the cache (collect(60) then brief(120) would refetch
 * every source). Collections always request the adapter maximum and slice after
 * the merge instead.
 */
function cacheKey(id, params) {
  const p = params || {}
  const parts = [id]
  for (const key of ['q', 'from', 'to', 'symbol', 'code', 'orgId', 'region', 'category', 'days']) {
    if (p[key] !== undefined && p[key] !== null && p[key] !== '') parts.push(key + '=' + String(p[key]))
  }
  return parts.join('|')
}

/** How many rows one adapter is asked for; adapters clamp to their own max. */
const FETCH_LIMIT = 60

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Sort a latency ring buffer and pick a quantile. */
function quantile(values, q) {
  if (!values || values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[index]
}

export function createSourceLayer(options) {
  const opts = options || {}
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const adapters = Array.isArray(opts.adapters) ? opts.adapters.filter((a) => a && a.id && typeof a.fetch === 'function') : []

  /** adapterId -> adapter */
  const byId = new Map()
  for (const adapter of adapters) byId.set(adapter.id, adapter)

  /** cacheKey -> { at, data } */
  const cache = new Map()
  /** cacheKey -> { promise, at } (single flight, with a start stamp) */
  const inflight = new Map()
  /** adapterId -> health record */
  const health = new Map()
  /** adapterId -> number[] (last 40 latencies) */
  const latencies = new Map()
  /** adapterId -> last call timestamp, for pacing */
  const lastCall = new Map()
  /** adapterId -> promise chain, so a slow adapter never overlaps itself */
  const chain = new Map()
  /**
   * adapterId -> { until, reason }. A host that times out or refuses connections is
   * almost always blocked for a while, not slow; retrying it on every refresh costs
   * seconds and buys nothing. Manual `refresh` still probes it.
   */
  const backoff = new Map()
  const BACKOFF_MS = 15 * 60 * 1000
  /**
   * How long a source is benched after a network failure. A real-time source that
   * fails once must not sit out for 15 minutes — it is the one users notice. The
   * slower the tier, the less a short outage matters.
   */
  const BACKOFF_BY_CADENCE = {
    T0: 60 * 1000,
    T1: 5 * 60 * 1000,
    T2: 10 * 60 * 1000,
    T3: BACKOFF_MS,
  }

  function backoffMsFor(adapter) {
    const cadence = cadenceOf(adapter)
    return (cadence && BACKOFF_BY_CADENCE[cadence.id]) || BACKOFF_MS
  }
  const BACKOFF_PATTERN = /timeout|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|http 429|rate limit/i

  function healthOf(id) {
    let row = health.get(id)
    if (!row) {
      row = { attempts: 0, ok: 0, fail: 0, empty: 0, lastMs: 0, lastOkAt: null, lastFailAt: null, lastError: '', stale: 0 }
      health.set(id, row)
    }
    return row
  }

  function recordLatency(id, ms) {
    const list = latencies.get(id) || []
    list.push({ ms: Math.round(ms), at: nowMs() })
    if (list.length > 40) list.shift()
    latencies.set(id, list)
  }

  function ttlOf(adapter) {
    // Cadence wins: it is derived from measured publish behaviour, not a guess.
    const cadence = cadenceOf(adapter)
    if (cadence) return cadence.ttlMs
    return num(adapter.ttlMs, TTL_BY_CATEGORY[adapter.category] || 5 * 60 * 1000)
  }

  /** Wait out the politeness budget for one adapter (per-minute ceiling). */
  async function pace(id) {
    const adapter = byId.get(id)
    const perMinute = num(adapter && adapter.rateLimit && adapter.rateLimit.perMinute, 0)
    if (!perMinute || perMinute <= 0) return
    const minGap = Math.ceil(60000 / perMinute)
    const previous = lastCall.get(id) || 0
    const wait = previous + minGap - nowMs()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastCall.set(id, nowMs())
  }

  /** Serialise calls per adapter: official endpoints dislike bursts from one host. */
  function serialise(id, task) {
    const previous = chain.get(id) || Promise.resolve()
    const next = previous.then(task, task)
    chain.set(id, next.catch(() => {}))
    return next
  }

  function buildContext(adapter, signal) {
    const scoped = options => ({ ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal })
    return {
      getJson: (href, options) => getJson(href, scoped(options)),
      postJson: (href, body, options) => postJson(href, body, scoped(options)),
      // Raw request, for pages that are not JSON or not UTF-8 (e.g. GBK listings).
      request: (href, requestOptions) => request(href, scoped(requestOptions)),
      log: log,
      signal: signal,
      fetchJson: (href, requestOptions) => getJson(href, scoped(requestOptions)),
      region: adapter.region,
    }
  }

  /**
   * Execute one adapter and normalise its payload.
   * Returns { items, meta, ms, error } and never rejects.
   */
  async function runAdapter(adapter, params, extra) {
    const started = nowMs()
    const controller = new AbortController()
    const deadline = num(adapter.timeoutMs, DEFAULT_DEADLINE_MS)
    const timer = setTimeout(() => controller.abort(new Error('adapter deadline exceeded')), deadline)
    const task = (async () => {
      try {
        const result = await adapter.fetch(buildContext(adapter, controller.signal), params || {}, extra || {})
        const raw = result && Array.isArray(result.items) ? result.items : []
        const items = raw
          .filter((item) => item && (item.title || item.url))
          .map((item) => ({
            id: String(item.id || item.url || item.title || ''),
            title: String(item.title || ''),
            url: item.url ? String(item.url) : '',
            publishedAt: num(item.publishedAt, 0) || null,
            sourceId: adapter.id,
            source: adapter.name,
            category: item.category || adapter.category,
            domain: domainOf(adapter),
            region: adapter.region,
            tier: adapter.tier,
            summary: item.summary ? String(item.summary).slice(0, 600) : '',
            tags: Array.isArray(item.tags) ? item.tags.slice(0, 8).map(String) : [],
            payload: item.payload && typeof item.payload === 'object' ? item.payload : undefined,
          }))
        const meta = (result && result.meta) || undefined
        // An adapter may answer "here is why I am empty" (blocked / missing key /
        // layout changed). That is not a throw, but it is the only useful diagnosis
        // the panel has, so carry it out of the adapter instead of swallowing it.
        const note = meta && meta.error ? String(meta.error) : ''
        return { items: items, meta: meta, ms: nowMs() - started, error: '', note: note }
      } catch (error) {
        return { items: [], meta: undefined, ms: nowMs() - started, error: String(error && error.message ? error.message : error) }
      }
    })()
    const raced = await withTimeout(task, deadline + 1200, adapter.id)
    clearTimeout(timer)
    try {
      controller.abort()
    } catch {}
    if (raced && raced.__timeout) {
      return { items: [], meta: undefined, ms: nowMs() - started, error: 'deadline ' + deadline + 'ms' }
    }
    return raced
  }

  function applyHealth(adapter, result) {
    const row = healthOf(adapter.id)
    row.attempts += 1
    row.lastMs = result.ms
    recordLatency(adapter.id, result.ms)
    // Adapters never throw: a network failure arrives as `meta.error` -> `note`, so
    // backoff has to look at both, otherwise a blocked host is "successfully empty"
    // and gets retried on every refresh.
    const failureText = result.error || result.note || ''
    if (result.error) {
      row.fail += 1
      row.lastFailAt = nowMs()
      row.lastError = result.error
      if (BACKOFF_PATTERN.test(result.error)) {
        backoff.set(adapter.id, { until: nowMs() + backoffMsFor(adapter), reason: result.error })
      }
    } else {
      row.ok += 1
      row.lastOkAt = nowMs()
      row.lastError = ''
      if ((result.items || []).length === 0) {
        row.empty += 1
        row.lastError = result.note || 'empty result'
        if (result.note && BACKOFF_PATTERN.test(result.note)) {
          backoff.set(adapter.id, { until: nowMs() + backoffMsFor(adapter), reason: result.note })
        }
      } else {
        backoff.delete(adapter.id)
        // Newest item timestamp, so the panel can show data freshness next to latency.
        let newest = 0
        for (const item of result.items) {
          const at = Number(item.publishedAt)
          if (Number.isFinite(at) && at > newest) newest = at
        }
        row.lastItemAt = newest > 0 ? newest : null
      }
    }
  }

  /**
   * Fetch one source with stale-while-revalidate.
   *
   * @param {string} id adapter id
   * @param {object} params adapter-specific query
   * @param {{refresh?:boolean, allowStale?:boolean}} callOptions
   */
  async function fetchOne(id, params, callOptions) {
    const adapter = byId.get(id)
    if (!adapter) return { ok: false, sourceId: id, error: 'unknown source: ' + id, items: [] }
    const call = callOptions || {}
    // Normalise the row count so every caller shares one cache entry per query shape.
    const query = Object.assign({}, params || {}, { limit: FETCH_LIMIT })
    const key = cacheKey(id, query)
    const hit = cache.get(key)
    const ttl = ttlOf(adapter)

    // Recently unreachable host: answer immediately instead of paying the timeout again.
    if (!call.refresh) {
      const paused = backoff.get(id)
      if (paused && paused.until > nowMs()) {
        if (hit) {
          return { ok: true, sourceId: id, cached: true, stale: true, ms: 0, ageMs: nowMs() - hit.at, items: hit.data.items, meta: hit.data.meta, note: 'backoff: ' + paused.reason }
        }
        return {
          ok: false,
          sourceId: id,
          cached: false,
          stale: false,
          backoff: true,
          ms: 0,
          ageMs: 0,
          items: [],
          error: 'backoff: ' + paused.reason,
          note: '15 分钟退避中：' + paused.reason,
        }
      }
    } else {
      backoff.delete(id)
    }

    if (!call.refresh && hit && nowMs() - hit.at < ttl) {
      return { ok: true, sourceId: id, cached: true, stale: false, ms: 0, ageMs: nowMs() - hit.at, items: hit.data.items, meta: hit.data.meta }
    }
    // Stale but usable: answer immediately, revalidate in the background.
    if (!call.refresh && hit && call.allowStale !== false) {
      healthOf(id).stale += 1
      void revalidate(adapter, query, key)
      return { ok: true, sourceId: id, cached: true, stale: true, ms: 0, ageMs: nowMs() - hit.at, items: hit.data.items, meta: hit.data.meta }
    }
    return revalidate(adapter, query, key)
  }

  /** Single-flight revalidation; stores the payload and returns the envelope. */
  function revalidate(adapter, params, key) {
    const existing = inflight.get(key)
    if (existing) return existing.promise
    const task = serialise(adapter.id, async () => {
      await pace(adapter.id)
      const result = await runAdapter(adapter, params, {})
      applyHealth(adapter, result)
      if (!result.error) {
        cache.set(key, { at: nowMs(), data: { items: result.items, meta: result.meta } })
      } else if (byId.get(adapter.id).verbose) {
        log('source ' + adapter.id + ' failed: ' + result.error)
      }
      return {
        ok: !result.error,
        sourceId: adapter.id,
        cached: false,
        stale: false,
        ms: result.ms,
        ageMs: 0,
        items: result.items,
        meta: result.meta,
        note: result.note || undefined,
        error: result.error || undefined,
      }
    })
    inflight.set(key, { promise: task, at: nowMs() })
    task.finally(() => {
      const current = inflight.get(key)
      if (current && current.promise === task) inflight.delete(key)
    })
    return task
  }

  /** How long the in-flight request for this key has been running (-1 = none). */
  function inflightAge(key) {
    const hit = inflight.get(key)
    return hit ? nowMs() - hit.at : -1
  }

  /**
   * Fetch several sources in parallel, each with its own cache and deadline.
   *
   * `callOptions.budgetMs` is the wall-clock budget for this collection. Sources
   * that have not answered within it are reported as `pending` and their promise
   * is left running, so it still lands in the cache for the next refresh. That is
   * what keeps a single dead host from stalling the whole panel.
   */
  async function fetchMany(ids, params, callOptions) {
    const call = callOptions || {}
    const wanted = Array.isArray(ids) && ids.length ? ids : adapters.map((a) => a.id)
    const budgetMs = num(call.budgetMs, DEFAULT_BUDGET_MS)
    const started = nowMs()
    // Budget is wall-clock for the whole collection, not per adapter: with a wave
    // scheduler a per-adapter budget would add up to waves x budget (33 adapters at
    // concurrency 10 meant a 10s cold call against a 6s budget).
    const deadlineAt = budgetMs > 0 ? started + budgetMs : 0
    const results = await mapLimit(wanted, Math.max(4, Math.min(wanted.length, ADAPTER_CONCURRENCY)), async (id) => {
      // A previous collection may still be waiting on this exact request. Do not
      // queue behind it: answer "pending" now and let it land in the cache, otherwise
      // one slow host makes every subsequent refresh slow too.
      const adapter = byId.get(id)
      if (adapter && !call.refresh) {
        const probeKey = cacheKey(id, Object.assign({}, params || {}, { limit: FETCH_LIMIT }))
        const age = inflightAge(probeKey)
        const staleAfter = Math.min(budgetMs || 0, 2000)
        if (age >= staleAfter) {
          return { ok: false, sourceId: id, pending: true, cached: false, stale: false, ms: age, ageMs: 0, items: [], error: 'pending (already in flight)' }
        }
      }
      const task = fetchOne(id, params, call)
      if (!deadlineAt) return task
      const remaining = deadlineAt - nowMs()
      if (remaining <= 0) {
        // Keep it running in the background so the next collection hits the cache.
        void task.catch(() => {})
        return { ok: false, sourceId: id, pending: true, cached: false, stale: false, ms: 0, ageMs: 0, items: [], error: 'pending (budget exhausted)' }
      }
      const raced = await withTimeout(task, remaining, id)
      if (raced && raced.__timeout) {
        return { ok: false, sourceId: id, pending: true, cached: false, stale: false, ms: remaining, ageMs: 0, items: [], error: 'pending (budget ' + budgetMs + 'ms)' }
      }
      return raced
    })
    const items = []
    const sources = []
    let pending = 0
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index] || { ok: false, sourceId: wanted[index], error: 'no result', items: [] }
      if (result.pending) pending += 1
      sources.push({
        id: result.sourceId,
        ok: result.ok === true,
        cached: result.cached === true,
        stale: result.stale === true,
        pending: result.pending === true,
        backoff: result.backoff === true,
        ms: result.ms || 0,
        ageMs: result.ageMs || 0,
        count: (result.items || []).length,
        note: result.note || '',
        error: result.error || '',
      })
      for (const item of result.items || []) items.push(item)
    }
    return {
      items: dedupe(items),
      sources: sources,
      ms: nowMs() - started,
      fetchedAt: nowMs(),
      pending: pending,
      partial: pending > 0,
    }
  }

  function dedupe(items) {
    const seen = new Set()
    const out = []
    for (const item of items) {
      const key = item.id || item.url || item.title
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
    return out
  }

  /** Sort newest first, keeping undated rows at the end. */
  function byRecency(a, b) {
    return (b.publishedAt || 0) - (a.publishedAt || 0)
  }

  /**
   * Round-robin the category buckets before slicing.
   *
   * Without this a mostly-announcement feed pushes every macro print, sanction and
   * flow row past the limit, so "the latest N things" collapses to "the latest N
   * filings". Each bucket keeps its own newest-first order.
   */
  function balanceByCategory(items) {
    const buckets = new Map()
    const order = []
    for (const item of items) {
      const key = item.category || 'other'
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = []
        buckets.set(key, bucket)
        order.push(key)
      }
      bucket.push(item)
    }
    if (order.length < 2) return items
    const out = []
    for (let row = 0; out.length < items.length; row += 1) {
      let advanced = false
      for (const key of order) {
        const bucket = buckets.get(key)
        if (row < bucket.length) {
          out.push(bucket[row])
          advanced = true
        }
      }
      if (!advanced) break
    }
    return out
  }

  /**
   * Cross-source collection used by the panel and the model tools.
   *
   * @param {{categories?:string[], regions?:string[], ids?:string[], limit?:number,
   *          params?:object, refresh?:boolean}} query
   */
  async function collect(query) {
    const q = query || {}
    const categories = Array.isArray(q.categories) && q.categories.length ? q.categories : Object.keys(CATEGORIES)
    const domains = Array.isArray(q.domains) && q.domains.length ? q.domains.map((d) => String(d).toLowerCase()) : []
    const regions = Array.isArray(q.regions) && q.regions.length ? q.regions.map((r) => String(r).toUpperCase()) : []
    let chosen = adapters.filter((a) => categories.includes(a.category))
    if (domains.length) chosen = chosen.filter((a) => domains.includes(domainOf(a)))
    if (regions.length) chosen = chosen.filter((a) => regions.includes(String(a.region || '').toUpperCase()))
    if (Array.isArray(q.tiers) && q.tiers.length) {
      const wantedTiers = q.tiers.map((t) => String(t).toUpperCase())
      chosen = chosen.filter((a) => {
        const cadence = cadenceOf(a)
        return cadence && wantedTiers.includes(cadence.id)
      })
    }
    // Hot sources first: under a wall-clock budget, the data that goes stale fastest
    // must not be the data that gets cut off by the long tail.
    const rank = { T0: 0, T1: 1, T2: 2, T3: 3 }
    chosen = chosen
      .map((adapter, index) => ({ adapter, index }))
      .sort((a, b) => {
        const ca = cadenceOf(a.adapter)
        const cb = cadenceOf(b.adapter)
        const ra = ca ? rank[ca.id] : 4
        const rb = cb ? rank[cb.id] : 4
        return ra === rb ? a.index - b.index : ra - rb
      })
      .map((entry) => entry.adapter)
    if (Array.isArray(q.ids) && q.ids.length) {
      const wanted = new Set(q.ids.map(String))
      chosen = adapters.filter((a) => wanted.has(a.id))
    }
    const params = q.params && typeof q.params === 'object' ? q.params : {}
    // One cache entry per query shape: always ask for the max, slice after merging.
    params.limit = FETCH_LIMIT
    // T3 sources (weekly / monthly / quarterly) do not belong in a cold start: they
    // add seven slow, mostly-failing requests to a six-second budget and their data
    // rarely changes. Fetch them in a background phase unless explicitly asked for.
    const wantsCold = q.includeCold === true || (Array.isArray(q.tiers) && q.tiers.map((t) => String(t).toUpperCase()).includes('T3'))
    // Defer only the T3 sources that are not already cached and fresh: once the
    // background phase has filled them, the next collection serves them like any
    // other source instead of hiding them from the "all" view forever.
    const isFresh = (adapter) => {
      const entry = cache.get(cacheKey(adapter.id, params))
      if (!entry) return false
      return nowMs() - entry.at < ttlOf(adapter)
    }
    const primary = wantsCold ? chosen : chosen.filter((a) => {
      const cadence = cadenceOf(a)
      return !cadence || cadence.id !== 'T3' || isFresh(a)
    })
    const deferred = wantsCold ? [] : chosen.filter((a) => primary.indexOf(a) < 0)
    const data = await fetchMany(primary.map((a) => a.id), params, {
      refresh: q.refresh === true,
      budgetMs: q.budgetMs === undefined ? DEFAULT_BUDGET_MS : num(q.budgetMs, DEFAULT_BUDGET_MS),
    })
    if (deferred.length) {
      // Start the slow tier only after the hot tiers have answered: firing it in
      // parallel would put seven rarely-changing request paths in the same burst.
      const coldIds = deferred.map((a) => a.id)
      void fetchMany(coldIds, Object.assign({}, params), { budgetMs: 30000 }).catch(() => {})
    }
    const limit = Math.max(1, num(q.limit, 200))
    const sorted = data.items.slice().sort(byRecency)
    return {
      items: (q.balanced === false ? sorted : balanceByCategory(sorted)).slice(0, limit),
      sources: data.sources,
      ms: data.ms,
      fetchedAt: data.fetchedAt,
      pending: data.pending || 0,
      partial: data.partial === true,
      deferred: deferred.length,
      deferredIds: deferred.map((a) => a.id),
      categories: categories,
      regions: regions,
      domains: domains,
    }
  }

  /** Public metadata for the settings page and the UI source tab. */
  function list() {
    return adapters.map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      category: adapter.category,
      categoryLabel: CATEGORIES[adapter.category] || adapter.category,
      domain: domainOf(adapter),
      domainLabel: DOMAINS[domainOf(adapter)] || '',
      region: adapter.region,
      regionLabel: REGIONS[adapter.region] || adapter.region || '',
      tier: adapter.tier || 'A',
      capability: Array.isArray(adapter.capability) ? adapter.capability : ['list'],
      needsKey: adapter.needsKey === true,
      keyEnv: adapter.keyEnv || '',
      homepage: adapter.homepage || '',
      note: adapter.note || '',
      ttlMs: ttlOf(adapter),
      cadence: (cadenceOf(adapter) || {}).id || '',
      cadenceLabel: (cadenceOf(adapter) || {}).label || '',
      rateLimit: adapter.rateLimit || null,
    }))
  }

  /** Health + latency snapshot for the diagnostics tab. */
  function stats() {
    const rows = []
    for (const adapter of adapters) {
      const row = health.get(adapter.id) || { attempts: 0, ok: 0, fail: 0, empty: 0, lastMs: 0, lastOkAt: null, lastFailAt: null, lastError: '', stale: 0, lastItemAt: null }
      const samples = latencies.get(adapter.id) || []
      const sampleMs = samples.map((sample) => sample.ms)
      const successRate = row.attempts ? row.ok / row.attempts : 0
      const cadence = cadenceOf(adapter)
      let status = 'unknown'
      if (row.attempts > 0) {
        if (row.ok === 0) status = 'fail'
        else if (row.empty === row.ok) status = 'empty'
        else if (successRate < 0.6 || (row.lastFailAt && row.lastFailAt > (row.lastOkAt || 0))) status = 'warn'
        else status = 'ok'
      }
      rows.push({
        id: adapter.id,
        name: adapter.name,
        category: adapter.category,
        region: adapter.region,
        tier: adapter.tier || 'A',
        domain: domainOf(adapter),
        domainLabel: DOMAINS[domainOf(adapter)] || '',
        cadence: cadence ? cadence.id : '',
        cadenceLabel: cadence ? cadence.label : '',
        ttlMs: ttlOf(adapter),
        lastItemAt: row.lastItemAt,
        freshnessMs: row.lastItemAt ? Math.max(0, nowMs() - row.lastItemAt) : null,
        attempts: row.attempts,
        ok: row.ok,
        fail: row.fail,
        empty: row.empty,
        stale: row.stale,
        successRate: Math.round(successRate * 1000) / 1000,
        lastMs: row.lastMs,
        p50: quantile(sampleMs, 0.5),
        p95: quantile(sampleMs, 0.95),
        samples: sampleMs.length,
        // Last 16 latencies, oldest first: the panel draws this as a sparkline so a
        // single 9s outlier is visibly different from a source that is always slow.
        series: samples.slice(-16).map((sample) => sample.ms),
        lastOkAt: row.lastOkAt,
        lastFailAt: row.lastFailAt,
        lastError: row.lastError,
        backoffUntil: (backoff.get(adapter.id) || {}).until || 0,
        status: status,
      })
    }
    return {
      sources: rows,
      cache: { keys: cache.size, inflight: inflight.size },
      pool: poolStats(),
      cadences: CADENCES,
      totals: {
        sources: adapters.length,
        ok: rows.filter((r) => r.status === 'ok').length,
        warn: rows.filter((r) => r.status === 'warn').length,
        empty: rows.filter((r) => r.status === 'empty').length,
        fail: rows.filter((r) => r.status === 'fail').length,
        p50: quantile(rows.map((r) => r.p50).filter(Boolean), 0.5),
        p95: quantile(rows.map((r) => r.p95).filter(Boolean), 0.95),
      },
    }
  }

  /** Prefetch a set of sources without blocking; used on agent start / panel open. */
  function warm(ids, params) {
    // A cold start warms everything except the T3 tail: monthly and quarterly
    // sources can wait for the background phase that collect() schedules.
    const wanted = Array.isArray(ids) && ids.length
      ? ids
      : adapters
          .filter((adapter) => {
            const cadence = cadenceOf(adapter)
            return !cadence || cadence.id !== 'T3'
          })
          .map((adapter) => adapter.id)
    for (const id of wanted) {
      const adapter = byId.get(id)
      if (!adapter) continue
      const key = cacheKey(id, params)
      if (cache.has(key)) continue
      void revalidate(adapter, params || {}, key).catch(() => {})
    }
  }

  function invalidate() {
    cache.clear()
  }

  function has(adapterId) {
    return byId.has(adapterId)
  }

  return {
    adapters: adapters,
    list: list,
    fetchOne: fetchOne,
    fetchMany: fetchMany,
    collect: collect,
    stats: stats,
    warm: warm,
    invalidate: invalidate,
    has: has,
    categories: CATEGORIES,
    regions: REGIONS,
    cadences: CADENCES,
    domains: DOMAINS,
  }
}
