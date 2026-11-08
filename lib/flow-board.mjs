/**
 * Flow board: a read-only view over four existing series.
 *
 *   1. flow.market-net           全市场主力净流入 (亿元)
 *   2. flow.market-turnover      全市场成交额   (亿元)
 *   3. flow.northbound-turnover  北向成交额     (亿元)
 *   4. flow.southbound-net       南向净买入     (亿元)
 *
 * Design rules:
 *  - No new data and no local aggregation: it only reads `service.series()`.
 *  - Alignment is a strict date intersection; missing dates are dropped, never
 *    interpolated. `dropped` tells the caller how many dates were lost.
 *  - Series that cannot join the board are reported with a reason instead of being
 *    silently omitted (funding.margin is daily but only 90 points and on a different
 *    calendar origin; options.pcr has no history at all).
 */

const BOARD_IDS = [
  { id: 'flow.market-net', short: '主力净流入', sign: true },
  { id: 'flow.market-turnover', short: '成交额' },
  { id: 'flow.northbound-turnover', short: '北向成交额' },
  { id: 'flow.southbound-net', short: '南向净买入', sign: true },
]

const EXCLUDED = [
  { id: 'funding.margin', reason: '两融余额 90 点且起止日与其他序列不同源，不参与四联对齐' },
  { id: 'options.pcr', reason: '无公开历史源，仅有当日值' },
  { id: 'volatility.vix', reason: '美股波动率，交易日历不同（美股假期与 A 股不重叠）' },
  { id: 'money.gc001', reason: '资金利率，量纲 % 与其他三条亿元序列不可同轴' },
  { id: 'rates.cn-10y', reason: '收益率 %，量纲不同' },
  { id: 'rates.us-10y2y', reason: 'bp，量纲不同' },
  { id: 'rates.cn-us-10y', reason: 'bp，量纲不同' },
  { id: 'shipping.bdi', reason: '指数点位，量纲不同' },
]

function dayOf(t) {
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * @param {Array<{id:string,label?:string,unit?:string,points:Array<{t:number,v:number}>}>} tracked
 * @param {{days?:number}} [options]
 */
export function buildFlowBoard(tracked, options) {
  const opts = options || {}
  const days = Math.max(5, Math.min(Number(opts.days) || 60, 400))
  const byId = new Map((tracked || []).map((entry) => [entry.id, entry]))
  const present = []
  const missing = []
  for (const spec of BOARD_IDS) {
    const entry = byId.get(spec.id)
    if (!entry || !Array.isArray(entry.points) || entry.points.length === 0) {
      missing.push({ id: spec.id, short: spec.short, reason: '该序列尚无数据' })
      continue
    }
    present.push({ spec: spec, entry: entry })
  }
  if (!present.length) {
    return {
      ok: false,
      error: '资金面四联：四条序列均无数据（首次运行先调用 /api/series 触发回填）',
      series: [],
      rows: [],
      missing: missing,
      excluded: EXCLUDED,
    }
  }
  const maps = present.map((item) => {
    const map = new Map()
    for (const point of item.entry.points) map.set(dayOf(point.t), point.v)
    return map
  })
  const union = new Set()
  for (const map of maps) for (const key of map.keys()) union.add(key)
  const common = [...maps[0].keys()].filter((date) => maps.every((map) => map.has(date))).sort()
  const aligned = common.slice(-days)
  const rows = aligned.map((date) => {
    const row = { date: date }
    present.forEach((item, index) => { row[item.spec.id] = maps[index].get(date) })
    return row
  })
  // Per-series latest is reported independently: a series can be one session behind
  // the intersection without invalidating the board.
  const series = present.map((item) => {
    const points = item.entry.points.filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v))
    const last = points[points.length - 1] || null
    const alignedPoints = item.entry.points.filter((point) => common.includes(dayOf(point.t)))
    return {
      id: item.spec.id,
      short: item.spec.short,
      label: item.entry.label || item.spec.id,
      unit: item.entry.unit || '亿元',
      points: alignedPoints.length,
      latest: last ? last.v : null,
      latestDate: last ? dayOf(last.t) : '',
      alignedLatest: alignedPoints.length ? alignedPoints[alignedPoints.length - 1].v : null,
      firstDate: alignedPoints.length ? dayOf(alignedPoints[0].t) : '',
    }
  })
  return {
    ok: true,
    updatedAt: Date.now(),
    unit: '亿元',
    series: series,
    rows: rows,
    window: aligned.length,
    overlap: {
      dates: common.length,
      first: common.length ? common[0] : '',
      last: common.length ? common[common.length - 1] : '',
      dropped: union.size - common.length,
    },
    missing: missing,
    excluded: EXCLUDED,
  }
}
