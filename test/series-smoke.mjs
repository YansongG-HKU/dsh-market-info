/** Series store regression tests (deterministic, no network). */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSeriesStore } from '../lib/series.mjs'

let passed = 0
let failed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name) }
  catch (e) { failed += 1; console.log('  FAIL ' + name + '  ' + (e && e.message ? e.message : e)) }
}

const dir = 'F:/dsh插件创造/.tmp/mi-series-test'
fs.rmSync(dir, { recursive: true, force: true })

await test('appends a point and reads it back', () => {
  const store = createSeriesStore({ dataDir: dir })
  assert.equal(store.append('x', 1.5), true)
  const points = store.series('x')
  assert.equal(points.length, 1)
  assert.equal(points[0].v, 1.5)
})

await test('throttles identical values inside the gap window', () => {
  const store = createSeriesStore({ dataDir: dir })
  store.append('y', 2)
  assert.equal(store.append('y', 2), false, 'same value within 5 minutes is dropped')
  assert.equal(store.series('y').length, 1)
  assert.equal(store.append('y', 3), true, 'a changed value is always kept')
  assert.equal(store.series('y').length, 2)
})

await test('caps the series and drops the oldest points', () => {
  const store = createSeriesStore({ dataDir: dir })
  const base = Date.now()
  for (let i = 0; i < 300; i += 1) store.append('z', i, base + i * 6 * 60 * 1000)
  const points = store.series('z', 500)
  assert.ok(points.length <= 240, 'capped at 240, got ' + points.length)
  assert.equal(points[points.length - 1].v, 299, 'newest point kept')
})

await test('persists across store instances', async () => {
  const a = createSeriesStore({ dataDir: dir })
  a.append('p', 42)
  await new Promise((r) => setTimeout(r, 2200))
  const b = createSeriesStore({ dataDir: dir })
  const points = b.series('p')
  assert.equal(points.length, 1)
  assert.equal(points[0].v, 42)
})

await test('tolerates a corrupt file', () => {
  const badDir = 'F:/dsh插件创造/.tmp/mi-series-bad'
  fs.rmSync(badDir, { recursive: true, force: true })
  fs.mkdirSync(badDir, { recursive: true })
  fs.writeFileSync(path.join(badDir, 'series.json'), '{not json', 'utf8')
  const store = createSeriesStore({ dataDir: badDir })
  assert.deepEqual(store.series('anything'), [])
  assert.equal(store.append('ok', 1), true)
})

console.log('')
await test('backfill merges by timestamp and never duplicates', () => {
  const dir2 = 'F:/dsh插件创造/.tmp/mi-series-backfill'
  fs.rmSync(dir2, { recursive: true, force: true })
  const store = createSeriesStore({ dataDir: dir2 })
  const base = Date.parse('2026-09-01T00:00:00Z')
  const day = 86400000
  assert.equal(store.backfill('h', [{ t: base, v: 1 }, { t: base + day, v: 2 }]), 2)
  assert.equal(store.backfill('h', [{ t: base, v: 9 }, { t: base + 2 * day, v: 3 }]), 1)
  const points = store.series('h')
  assert.equal(points.length, 3)
  assert.equal(points[0].v, 1, 'existing point is kept, not overwritten')
  assert.equal(points[2].v, 3)
})
await test('tracked series catalogue is consistent', async () => {
  const { TRACKED_SERIES } = await import('../lib/series.mjs')
  assert.ok(TRACKED_SERIES.length >= 10, 'expected at least 10 tracked series, got ' + TRACKED_SERIES.length)
  const ids = TRACKED_SERIES.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, 'series ids must be unique')
  for (const entry of TRACKED_SERIES) {
    assert.ok(entry.label, entry.id + ' needs a label')
    assert.equal(typeof entry.pick, 'function', entry.id + ' needs a picker')
  }
  // The cross-border series must come from the aggregate rows, not the per-channel ones.
  assert.ok(ids.includes('flow.northbound-turnover'))
  assert.ok(ids.includes('flow.southbound-net'))
  assert.ok(ids.includes('flow.market-net'), 'verified full-market net inflow series present')
})
await test('flow series share a single unit and are all cross-border/market level', async () => {
  const { TRACKED_SERIES } = await import('../lib/series.mjs')
  const flow = TRACKED_SERIES.filter((entry) => entry.id.startsWith('flow.'))
  assert.ok(flow.length >= 3, 'expected northbound/southbound/market flow series, got ' + flow.length)
  for (const entry of flow) {
    assert.equal(entry.unit, '亿元', entry.id + ' must be expressed in 亿元')
    assert.equal(typeof entry.pick, 'function', entry.id + ' needs a picker')
  }
  const ids = flow.map((entry) => entry.id)
  assert.ok(ids.includes('flow.market-net'), 'verified market total series present')
  assert.ok(ids.includes('flow.northbound-turnover'), 'northbound turnover present')
  assert.ok(ids.includes('flow.southbound-net'), 'southbound net present')
})
await test('flow board aligns on the strict date intersection', async () => {
  const { buildFlowBoard } = await import('../lib/flow-board.mjs')
  const day = (n) => Date.parse('2026-11-0' + n + 'T00:00:00Z')
  const tracked = [
    { id: 'flow.market-net', label: '全市场主力净流入', unit: '亿元', points: [{ t: day(1), v: 1 }, { t: day(3), v: 3 }, { t: day(4), v: 4 }] },
    { id: 'flow.market-turnover', label: '全市场成交额', unit: '亿元', points: [{ t: day(1), v: 10 }, { t: day(3), v: 30 }] },
    { id: 'flow.northbound-turnover', label: '北向成交额', unit: '亿元', points: [{ t: day(1), v: 100 }, { t: day(3), v: 300 }, { t: day(5), v: 500 }] },
    { id: 'flow.southbound-net', label: '南向净买入', unit: '亿元', points: [{ t: day(1), v: 2 }, { t: day(3), v: 6 }, { t: day(4), v: 8 }] },
    { id: 'funding.margin', label: '两融余额', unit: '亿元', points: [{ t: day(1), v: 1 }] },
    { id: 'options.pcr', label: '期权 PCR', unit: '', points: [] },
  ]
  const board = buildFlowBoard(tracked)
  assert.equal(board.ok, true)
  assert.equal(board.series.length, 4, 'four flow series join the board')
  assert.deepEqual(board.rows.map((r) => r.date), ['2026-11-01', '2026-11-03'], 'intersection only, no interpolation')
  assert.equal(board.rows[1]['flow.market-net'], 3)
  assert.equal(board.overlap.dropped, 2, '04 and 05 are not common to all four')
  const excluded = board.excluded.map((entry) => entry.id)
  assert.ok(excluded.includes('funding.margin') && excluded.includes('options.pcr'))
  assert.ok(board.missing.length === 0, 'all four series were present here')
})

await test('flow board reports a usable error when nothing is backfilled', async () => {
  const { buildFlowBoard } = await import('../lib/flow-board.mjs')
  const board = buildFlowBoard([])
  assert.equal(board.ok, false)
  assert.ok(/回填/.test(board.error))
})

console.log(passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exit(1)
