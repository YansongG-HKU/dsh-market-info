/**
 * Source-layer regression tests.
 *
 * Everything here is deterministic: the runner is exercised with fake adapters so
 * the cache / single-flight / deadline / dedupe contracts stay honest even when
 * the network is down. Real adapters are probed separately by test/source-probe.mjs.
 *
 *   node test/sources-smoke.mjs
 */
import assert from 'node:assert/strict'
import { createSourceLayer } from '../lib/sources/index.mjs'
import { adapters as realAdapters } from '../lib/sources/all.mjs'
import { createService } from '../lib/service.mjs'

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    failures.push({ name: name, error: error })
    console.log('  FAIL ' + name + '  ' + (error && error.message ? error.message : error))
  }
}

function item(n, extra) {
  return Object.assign(
    {
      id: 'item-' + n,
      title: 'Item ' + n,
      url: 'https://example.com/' + n,
      publishedAt: 1700000000000 + n * 1000,
      summary: 'summary ' + n,
    },
    extra || {},
  )
}

function fakeAdapter(overrides) {
  return Object.assign(
    {
      id: 'fake',
      name: 'Fake',
      category: 'filing',
      region: 'CN',
      tier: 'A',
      capability: ['list'],
      rateLimit: { perMinute: 6000 },
      calls: 0,
      lastParams: null,
      async fetch(_ctx, params) {
        this.calls += 1
        this.lastParams = params
        return { items: [item(1), item(2), item(3)], meta: { total: 3 } }
      },
    },
    overrides || {},
  )
}

function fakeContext() {
  return { getJson: async () => ({ ok: false, error: 'offline' }), postJson: async () => ({ ok: false }), log: () => {} }
}

console.log('source layer')

await test('registry exposes metadata', async () => {
  const layer = createSourceLayer({ adapters: [fakeAdapter()] })
  const list = layer.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'fake')
  assert.equal(list[0].categoryLabel, '披露')
  assert.equal(list[0].regionLabel, '中国')
})

await test('fetchOne returns normalised items', async () => {
  const adapter = fakeAdapter()
  const layer = createSourceLayer({ adapters: [adapter] })
  const result = await layer.fetchOne('fake', {}, { refresh: true })
  assert.equal(result.ok, true)
  assert.equal(result.items.length, 3)
  assert.equal(result.items[0].sourceId, 'fake')
  assert.equal(result.items[0].source, 'Fake')
  assert.equal(result.items[0].category, 'filing')
  assert.equal(result.items[0].region, 'CN')
  assert.equal(adapter.calls, 1)
})

await test('second call is served from cache without hitting the adapter', async () => {
  const adapter = fakeAdapter()
  const layer = createSourceLayer({ adapters: [adapter] })
  await layer.fetchOne('fake', {}, { refresh: true })
  const second = await layer.fetchOne('fake', {})
  assert.equal(adapter.calls, 1)
  assert.equal(second.cached, true)
  assert.equal(second.items.length, 3)
})

await test('refresh bypasses the cache', async () => {
  const adapter = fakeAdapter()
  const layer = createSourceLayer({ adapters: [adapter] })
  await layer.fetchOne('fake', {}, { refresh: true })
  await layer.fetchOne('fake', {}, { refresh: true })
  assert.equal(adapter.calls, 2)
})

await test('params produce distinct cache keys', async () => {
  const adapter = fakeAdapter()
  const layer = createSourceLayer({ adapters: [adapter] })
  await layer.fetchOne('fake', { q: 'a' }, { refresh: true })
  await layer.fetchOne('fake', { q: 'b' }, { refresh: true })
  assert.equal(adapter.calls, 2)
})

await test('stale payload is served immediately while revalidating', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const adapter = fakeAdapter({
    ttlMs: 1,
    async fetch() {
      calls += 1
      if (calls > 1) await gate
      return { items: [item(1)] }
    },
  })
  const layer = createSourceLayer({ adapters: [adapter] })
  await layer.fetchOne('fake', {}, { refresh: true })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const stale = await layer.fetchOne('fake', {})
  assert.equal(stale.stale, true)
  assert.equal(stale.cached, true)
  assert.equal(stale.items.length, 1)
  release()
})

await test('concurrent calls share one flight', async () => {
  let calls = 0
  const adapter = fakeAdapter({
    async fetch() {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { items: [item(1)] }
    },
  })
  const layer = createSourceLayer({ adapters: [adapter] })
  const results = await Promise.all([
    layer.fetchOne('fake', {}, { refresh: true }),
    layer.fetchOne('fake', {}, { refresh: true }),
    layer.fetchOne('fake', {}, { refresh: true }),
  ])
  assert.equal(calls, 1)
  assert.equal(results.filter((r) => r.items.length === 1).length, 3)
})

await test('a failing adapter degrades instead of throwing', async () => {
  const adapter = fakeAdapter({
    async fetch() {
      throw new Error('boom')
    },
  })
  const layer = createSourceLayer({ adapters: [adapter] })
  const result = await layer.fetchOne('fake', {}, { refresh: true })
  assert.equal(result.ok, false)
  assert.equal(result.items.length, 0)
  assert.match(result.error, /boom/)
  const stats = layer.stats()
  assert.equal(stats.sources[0].fail, 1)
  assert.equal(stats.sources[0].status, 'fail')
})

await test('a hanging adapter respects the deadline', async () => {
  const adapter = fakeAdapter({
    timeoutMs: 80,
    fetch() {
      return new Promise(() => {})
    },
  })
  const layer = createSourceLayer({ adapters: [adapter] })
  const started = Date.now()
  const result = await layer.fetchOne('fake', {}, { refresh: true })
  const elapsed = Date.now() - started
  assert.equal(result.ok, false)
  assert.match(result.error, /deadline/)
  assert.ok(elapsed < 6000, 'deadline took too long: ' + elapsed)
})

await test('unknown adapter id is reported, not thrown', async () => {
  const layer = createSourceLayer({ adapters: [fakeAdapter()] })
  const result = await layer.fetchOne('nope', {}, {})
  assert.equal(result.ok, false)
  assert.match(result.error, /unknown source/)
})

await test('fetchMany merges and dedupes across adapters', async () => {
  const a = fakeAdapter({ id: 'a', name: 'A' })
  const b = fakeAdapter({
    id: 'b',
    name: 'B',
    async fetch() {
      return { items: [item(1), item(9)] }
    },
  })
  const layer = createSourceLayer({ adapters: [a, b] })
  const data = await layer.fetchMany(['a', 'b'], {}, { refresh: true })
  assert.equal(data.items.length, 4, 'expected item-1 deduped: ' + data.items.length)
  assert.equal(data.sources.length, 2)
  assert.equal(data.sources[0].count, 3)
})

await test('collect filters by category and region', async () => {
  const cn = fakeAdapter({ id: 'cn', category: 'filing', region: 'CN' })
  const us = fakeAdapter({
    id: 'us',
    name: 'US',
    category: 'macro',
    region: 'US',
    async fetch() {
      return { items: [item(5)] }
    },
  })
  const layer = createSourceLayer({ adapters: [cn, us] })
  const filings = await layer.collect({ categories: ['filing'], refresh: true })
  assert.equal(filings.items.length, 3)
  const usOnly = await layer.collect({ categories: ['macro', 'filing'], regions: ['US'], refresh: true })
  assert.equal(usOnly.items.length, 1)
  assert.equal(usOnly.items[0].region, 'US')
})

await test('items are sorted newest first', async () => {
  const layer = createSourceLayer({ adapters: [fakeAdapter()] })
  const data = await layer.collect({ limit: 10, refresh: true })
  assert.deepEqual(data.items.map((i) => i.id), ['item-3', 'item-2', 'item-1'])
})

await test('item limit is honoured', async () => {
  const layer = createSourceLayer({ adapters: [fakeAdapter()] })
  const data = await layer.collect({ limit: 2, refresh: true })
  assert.equal(data.items.length, 2)
})

await test('stats reports latency quantiles after traffic', async () => {
  const adapter = fakeAdapter()
  const layer = createSourceLayer({ adapters: [adapter] })
  await layer.fetchOne('fake', {}, { refresh: true })
  await layer.fetchOne('fake', { q: 'x' }, { refresh: true })
  const stats = layer.stats()
  assert.equal(stats.sources.length, 1)
  assert.ok(stats.sources[0].p50 >= 0)
  assert.ok(stats.sources[0].p95 >= 0)
  assert.equal(stats.sources[0].attempts, 2)
  assert.ok(stats.pool.length >= 1)
})

await test('adapters never see a missing ctx helper', async () => {
  let seen = null
  const adapter = fakeAdapter({
    async fetch(ctx) {
      seen = ctx
      return { items: [item(1)] }
    },
  })
  const layer = createSourceLayer({ adapters: [adapter] })
  await layer.fetchOne('fake', {}, { refresh: true })
  assert.equal(typeof seen.getJson, 'function')
  assert.equal(typeof seen.postJson, 'function')
  assert.equal(typeof seen.log, 'function')
  assert.ok(seen.signal)
})

console.log('')
console.log('real adapters')

await test('registry loads without throwing', async () => {
  assert.ok(Array.isArray(realAdapters))
  const ids = realAdapters.map((a) => a.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate adapter ids: ' + ids.join(','))
})

await test('every real adapter satisfies the contract', async () => {
  const problems = []
  for (const adapter of realAdapters) {
    if (!adapter.id) problems.push('missing id')
    if (!adapter.name) problems.push(adapter.id + ': missing name')
    if (!adapter.category) problems.push(adapter.id + ': missing category')
    if (!adapter.region) problems.push(adapter.id + ': missing region')
    if (typeof adapter.fetch !== 'function') problems.push(adapter.id + ': missing fetch')
    if (!adapter.rateLimit || !adapter.rateLimit.perMinute) problems.push(adapter.id + ': missing rateLimit')
  }
  assert.deepEqual(problems, [])
})

await test('service exposes the official-source surface', async () => {
  const service = createService({ dataDir: 'F:/dsh插件创造/.tmp/mi-test-sources', warmSources: false }, () => {})
  const sources = service.sources()
  assert.ok(Array.isArray(sources.sources))
  assert.ok(sources.categories && sources.categories.filing)
  assert.ok(Array.isArray(service.sourceStats().sources))
  assert.ok(Array.isArray(service.sourceHealthRows()))
  const brief = await service.brief({ limit: 20 })
  assert.equal(brief.ok, true)
  assert.equal(typeof brief.total, 'number')
  assert.equal(brief.firstRun, true)
  assert.ok(brief.groups && brief.groups.filing)
})

// ---------------------------------------------------------------- cadence tiers

await test('every real source carries a measured cadence tier', async () => {
  const layer = createSourceLayer({ adapters: realAdapters })
  const rows = layer.stats().sources
  assert.equal(rows.length, realAdapters.length)
  const missing = rows.filter((r) => !r.cadence).map((r) => r.id)
  assert.deepEqual(missing, [], 'sources without cadence: ' + missing.join(', '))
  const valid = ['T0', 'T1', 'T2', 'T3']
  for (const row of rows) assert.ok(valid.includes(row.cadence), row.id + ' bad cadence ' + row.cadence)
})

await test('cadence drives the cache TTL, not the adapter or category', async () => {
  const layer = createSourceLayer({ adapters: realAdapters })
  const list = layer.list()
  const ttl = {}
  for (const entry of list) ttl[entry.id] = entry.ttlMs
  assert.equal(ttl['fut-cn'], 30 * 1000, 'real-time futures refresh every 30s')
  assert.equal(ttl['cninfo'], 10 * 60 * 1000, 'disclosures refresh every 10min')
  assert.equal(ttl['bdi'], 3 * 60 * 60 * 1000, 'shipping index refreshes every 3h')
  assert.equal(ttl['ofac'], 12 * 60 * 60 * 1000, 'sanctions list refreshes twice a day')
})

await test('tier filter limits collection to the requested cadence', async () => {
  let calls = []
  const fake = ['T0', 'T1', 'T2', 'T3'].map((tier, index) => ({
    id: 'src-' + tier,
    name: 'Source ' + tier,
    category: 'macro',
    region: 'GLOBAL',
    cadence: tier,
    rateLimit: { perMinute: 60 },
    async fetch() {
      calls.push(tier)
      return { items: [item(index, { id: 'x-' + tier })], meta: {} }
    },
  }))
  const layer = createSourceLayer({ adapters: fake })
  const hot = await layer.collect({ tiers: ['T0', 'T1'], limit: 10 })
  assert.deepEqual(calls.sort(), ['T0', 'T1'])
  assert.equal(hot.sources.length, 2)
  assert.deepEqual(hot.sources.map((s) => s.id).sort(), ['src-T0', 'src-T1'])
})

await test('hot sources are scheduled before cold ones under a budget', async () => {  const started = []
  const fake = [
    ['cold', 'T2'],
    ['warm', 'T1'],
    ['hot', 'T0'],
  ].map(([id, tier], index) => ({
    id: id,
    name: id,
    category: 'macro',
    region: 'GLOBAL',
    cadence: tier,
    rateLimit: { perMinute: 60 },
    async fetch() {
      started.push(id)
      return { items: [item(index, { id: 'x-' + id })], meta: {} }
    },
  }))
  const layer = createSourceLayer({ adapters: fake })
  await layer.collect({ limit: 10 })
  // Only the order of the hot source relative to the cold ones is guaranteed.
  assert.ok(started.indexOf('hot') < started.indexOf('cold'), 'hot first: ' + started.join(','))
})

await test('slow tier is deferred on a cold start and served once cached', async () => {
  let coldFetches = 0
  const fake = [
    {
      id: 'hot-src',
      name: 'hot',
      category: 'macro',
      region: 'GLOBAL',
      cadence: 'T0',
      rateLimit: { perMinute: 600 },
      async fetch() {
        return { items: [item(1, { id: 'h1' })], meta: {} }
      },
    },
    {
      id: 'cold-src',
      name: 'cold',
      category: 'macro',
      region: 'GLOBAL',
      cadence: 'T3',
      rateLimit: { perMinute: 600 },
      async fetch() {
        coldFetches += 1
        return { items: [item(2, { id: 'c1' })], meta: {} }
      },
    },
  ]
  const layer = createSourceLayer({ adapters: fake })
  const first = await layer.collect({ limit: 10 })
  assert.equal(first.deferred, 1, 'one cold source deferred')
  assert.deepEqual(first.sources.map((s) => s.id), ['hot-src'])
  // The background phase fires it without blocking; give it a moment to land.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (layer.stats().sources.find((s) => s.id === 'cold-src').attempts > 0) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const second = await layer.collect({ limit: 10 })
  assert.equal(second.deferred, 0, 'cached cold source is no longer deferred')
  assert.ok(second.sources.some((s) => s.id === 'cold-src'), 'cold source included once cached')
  assert.equal(coldFetches, 1, 'deferred fetch happened exactly once')
})

await test('asking for the cold tier explicitly bypasses the deferral', async () => {
  const fake = [
    {
      id: 'cold-only',
      name: 'cold',
      category: 'macro',
      region: 'GLOBAL',
      cadence: 'T3',
      rateLimit: { perMinute: 600 },
      async fetch() {
        return { items: [item(1, { id: 'c1' })], meta: {} }
      },
    },
  ]
  const layer = createSourceLayer({ adapters: fake })
  const result = await layer.collect({ tiers: ['T3'], limit: 10 })
  assert.equal(result.deferred, 0)
  assert.equal(result.sources.length, 1)
  assert.equal(result.items.length, 1)
})

await test('latency history is exposed as a series with windowed quantiles', async () => {
  let counter = 0
  const fake = [
    {
      id: 'timed',
      name: 'timed',
      category: 'macro',
      region: 'GLOBAL',
      cadence: 'T0',
      rateLimit: { perMinute: 600 },
      async fetch() {
        counter += 1
        return { items: [item(counter, { id: 't' + counter })], meta: {} }
      },
    },
  ]
  const layer = createSourceLayer({ adapters: fake })
  await layer.collect({ limit: 10 })
  await layer.collect({ limit: 10, refresh: true })
  const row = layer.stats().sources[0]
  assert.ok(row.samples >= 2, 'samples recorded: ' + row.samples)
  assert.ok(Array.isArray(row.series) && row.series.length >= 2, 'series present')
  assert.ok(row.series.every((v) => typeof v === 'number' && v >= 0))
  assert.ok(row.p50 !== null && row.p95 !== null, 'quantiles computed from the series')
})

console.log('')
await test('every source belongs to a domain and every category maps to one', async () => {
  const layer = createSourceLayer({ adapters: realAdapters })
  const list = layer.list()
  const domains = layer.domains
  assert.ok(domains && Object.keys(domains).length >= 6, 'domain table present')
  const orphans = list.filter((s) => !s.domain || !domains[s.domain]).map((s) => s.id)
  assert.deepEqual(orphans, [], 'sources without a domain: ' + orphans.join(', '))
  const byCategory = {}
  for (const source of list) byCategory[source.category] = source.domain
  assert.deepEqual(Object.keys(byCategory).sort(), Object.keys(layer.categories).sort())
})

await test('domain filter narrows collection to that domain only', async () => {
  const made = ['pricing-a', 'funding-a'].map((id, index) => ({
    id: id,
    name: id,
    category: index === 0 ? 'futures' : 'flow',
    region: 'CN',
    cadence: 'T0',
    rateLimit: { perMinute: 600 },
    async fetch() {
      return { items: [item(index, { id: 'x-' + id })], meta: {} }
    },
  }))
  const layer = createSourceLayer({ adapters: made })
  const result = await layer.collect({ domains: ['pricing'], limit: 10 })
  assert.deepEqual(result.sources.map((s) => s.id), ['pricing-a'])
  assert.equal(result.items.length, 1)
})

await test('items carry the domain they came from', async () => {
  const made = [{
    id: 'dom-src', name: 'dom', category: 'fx', region: 'GLOBAL', cadence: 'T0',
    rateLimit: { perMinute: 600 },
    async fetch() { return { items: [item(1, { id: 'd1' })], meta: {} } },
  }]
  const layer = createSourceLayer({ adapters: made })
  const result = await layer.collect({ limit: 10 })
  assert.equal(result.items[0].domain, 'pricing')
})
await test('cache keys include the company code (regression: company view served market data)', async () => {
  let calls = 0
  const made = [{
    id: 'code-src', name: 'code', category: 'corporate', region: 'CN', cadence: 'T2',
    rateLimit: { perMinute: 600 },
    async fetch(ctx, params) {
      calls += 1
      return { items: [item(calls, { id: 'i-' + (params && params.code ? params.code : 'all') })], meta: {} }
    },
  }]
  const layer = createSourceLayer({ adapters: made })
  await layer.fetchOne('code-src', {}, {})
  const company = await layer.fetchOne('code-src', { code: '002518' }, {})
  const cachedCompany = await layer.fetchOne('code-src', { code: '002518' }, {})
  assert.equal(calls, 2, 'market and company shapes must not share a cache entry')
  assert.equal(company.items[0].id, 'i-002518')
  assert.equal(cachedCompany.items[0].id, 'i-002518', 'same shape is still cached')
})
await test('brief reports a domain roll-up next to the category groups', async () => {
  const service = createService({ dataDir: 'F:/dsh插件创造/.tmp/mi-test-brief', warmSources: false }, () => {})
  const brief = await service.brief({ limit: 120 })
  const domains = brief.domains || {}
  const labels = Object.keys(domains)
  assert.ok(labels.length >= 6, 'domain groups present: ' + labels.length)
  for (const key of labels) {
    assert.ok(domains[key].label, 'domain ' + key + ' has a label')
    assert.equal(typeof domains[key].count, 'number')
    assert.ok(Array.isArray(domains[key].top))
  }
})
console.log(passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  for (const row of failures) console.log(' - ' + row.name + ': ' + (row.error && row.error.stack ? row.error.stack.split('\n')[0] : row.error))
  process.exit(1)
}
