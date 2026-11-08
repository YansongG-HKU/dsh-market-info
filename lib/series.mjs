/**
 * Persisted time series for a handful of derived numbers (option PCR, rate
 * spreads, ...). One small JSON file, appended on every collection and read back
 * by the dashboard so a single point becomes a trend.
 *
 * Design notes:
 *  - bounded: at most `cap` points per series, oldest dropped;
 *  - throttled: a point is only appended when the value actually changes or the
 *    last point is older than `minGapMs` (a 30s refresh must not build 1000 rows);
 *  - best-effort: a broken file never takes the panel down.
 */
import fs from 'node:fs'
import path from 'node:path'

const CAP = 240
const MIN_GAP_MS = 5 * 60 * 1000

export function createSeriesStore(options) {
  const opts = options || {}
  const dir = opts.dataDir || ''
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const file = dir ? path.join(dir, 'series.json') : ''
  /** id -> [{ t, v }] */
  let data = {}
  let loaded = false
  let writeTimer = null

  function load() {
    if (loaded) return
    loaded = true
    if (!file || !fs.existsSync(file)) return
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') data = parsed
    } catch (error) {
      log('series file unreadable, starting fresh: ' + String(error && error.message ? error.message : error))
      data = {}
    }
  }

  function scheduleWrite() {
    if (!file || writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(data), 'utf8')
      } catch (error) {
        log('series write failed: ' + String(error && error.message ? error.message : error))
      }
    }, 2000)
    if (writeTimer && typeof writeTimer.unref === 'function') writeTimer.unref()
  }

  function append(id, value, at) {
    if (!id || !Number.isFinite(value)) return false
    load()
    const list = Array.isArray(data[id]) ? data[id] : []
    const now = Number.isFinite(at) ? at : Date.now()
    const last = list[list.length - 1]
    if (last && Math.abs(last.v - value) < 1e-9 && now - last.t < MIN_GAP_MS) return false
    if (last && now - last.t < MIN_GAP_MS && Math.abs(last.v - value) < 1e-9) return false
    list.push({ t: now, v: Number(value.toFixed(6)) })
    while (list.length > CAP) list.shift()
    data[id] = list
    scheduleWrite()
    return true
  }

  /**
   * Merge historical points into a series (backfill). Points are keyed by day so a
   * re-run never duplicates; the cap still applies. Used to give a fresh install a
   * real curve instead of one point that only grows while the process is alive.
   */
  function backfill(id, points) {
    if (!id || !Array.isArray(points) || !points.length) return 0
    load()
    const merged = new Map()
    for (const point of Array.isArray(data[id]) ? data[id] : []) merged.set(point.t, point.v)
    let added = 0
    for (const point of points) {
      if (!point || !Number.isFinite(point.t) || !Number.isFinite(point.v)) continue
      if (merged.has(point.t)) continue
      merged.set(point.t, Number(point.v.toFixed(6)))
      added += 1
    }
    const list = Array.from(merged.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => ({ t: entry[0], v: entry[1] }))
    while (list.length > CAP) list.shift()
    data[id] = list
    if (added) scheduleWrite()
    return added
  }
  /** Drop everything: used by an explicit rebuild (fresh machine, or a corrupted cache). */
  function clear() {
    data = {}
    loaded = true
    scheduleWrite()
    return true
  }
  function series(id, limit) {
    load()
    const list = Array.isArray(data[id]) ? data[id] : []
    return list.slice(-(limit || 60))
  }

  function ids() {
    load()
    return Object.keys(data)
  }

  return { append: append, backfill: backfill, series: series, clear: clear, ids: ids, file: () => file }
}

/**
 * Derived numbers worth keeping as history. Each entry reads one collected item
 * and returns the numeric value to store.
 */
export const TRACKED_SERIES = [
  {
    id: 'funding.margin',
    label: '两融余额',
    unit: '亿元',
    // Backfilled from the margin-history report; steady-state append is done by the
    // service (the flow adapter's snapshot does not carry the exact balance).
    pick: (items) => {
      const row = items.find((item) => item.sourceId === 'margin')
      if (!row || !row.payload) return null
      const n = Number(row.payload.balanceYi !== undefined ? row.payload.balanceYi : NaN)
      return Number.isFinite(n) ? n : null
    },
  },  {
    id: 'flow.market-net',
    label: '全市场主力净流入',
    unit: '亿元',
    // 沪综指(1.000001) + 深成指(0.399001) 的 fflow 日线之和 == 全 A 个股 f62 合计
    // （实测 −524.97 vs −524.95 亿，误差 0.02 亿），因此 2 次请求即可拿到全市场口径。
    pick: () => null,
  },  {
    id: 'flow.market-turnover',
    label: '全市场成交额',
    unit: '亿元',
    // 沪综指 + 深成指 日线 f57（元）之和，与 market-net 同源同日，天然对齐。
    pick: () => null,
  },
  {
    id: 'flow.northbound-turnover',
    label: '北向成交额',
    unit: '亿元',
    // 005 = 001(沪股通) + 003(深股通); the aggregate row is the only northbound
    // number still published — net buy stopped being disclosed.
    pick: () => null,
  },
  {
    id: 'flow.southbound-net',
    label: '南向净买入',
    unit: '亿元',
    // 006 = 002(港股通沪) + 004(港股通深). NET_DEAL_AMT == BUY_AMT - SELL_AMT verified.
    pick: () => null,
  },
  {
    id: 'volatility.vix',    label: 'VIX 恐慌指数',
    unit: '',
    pick: (items) => {
      const row = items.find((item) => item.sourceId === 'cboe')
      if (!row || !row.payload) return null
      for (const key of ['price', 'value', 'last', 'close', 'vix']) {
        const n = Number(row.payload[key])
        if (Number.isFinite(n) && n > 0) return n
      }
      return null
    },
  },  {
    id: 'options.pcr',
    label: '期权 PCR',
    unit: '',
    pick: (items) => {
      const row = items.find((item) => item.id === 'options:pcr')
      return row && row.payload ? row.payload.pcr : null
    },
  },
  {
    id: 'rates.cn-us-10y',
    label: '中美 10Y 利差',
    unit: 'bp',
    pick: (items) => {
      const row = items.find((item) => item.id === 'rates:cn-us-10y')
      return row && row.payload ? row.payload.spread * 100 : null
    },
  },
  {
    id: 'rates.us-10y2y',
    label: '美国 10Y-2Y',
    unit: 'bp',
    pick: (items) => {
      const row = items.find((item) => item.id === 'rates:us-10y2y')
      return row && row.payload ? row.payload.spread * 100 : null
    },
  },
  {
    id: 'rates.cn-10y',
    label: '中国 10Y',
    unit: '%',
    pick: (items) => {
      const row = items.find((item) => item.id === 'rates:CN10年')
      return row && row.payload ? row.payload.value : null
    },
  },
  {
    id: 'money.gc001',
    label: '隔夜回购 GC001',
    unit: '%',
    pick: (items) => {
      const row = items.find((item) => item.payload && item.payload.code === 'GC001')
      return row && row.payload ? row.payload.rate : null
    },
  },
  {
    id: 'shipping.bdi',
    label: 'BDI',
    unit: '',
    pick: (items) => {
      const row = items.find((item) => item.sourceId === 'bdi')
      if (!row) return null
      const hit = Number(/\s(\d+(?:\.\d+)?)\s/.exec(String(row.title || '')) && /\s(\d+(?:\.\d+)?)\s/.exec(String(row.title || ''))[1])
      return Number.isFinite(hit) ? hit : null
    },
  },
]
