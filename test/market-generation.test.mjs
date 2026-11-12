import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import * as modules from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createService } from '../lib/service.mjs'

async function fixture(t, makeService = createService) {
  const dataDir = await mkdtemp(join(tmpdir(), 'market-generation-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  return makeService({ dataDir, proxy: 'off' })
}

function provider(price, wait = async () => {}) {
  return { name: 'fixture', supports: () => true, async fetch(items) {
    await wait()
    return new Map(items.map(({ id }) => [id, { id, price }]))
  } }
}

test('settings changes isolate quote requests and late results', async (t) => {
  const service = await fixture(t)
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const old = service.quotes(true, { providers: [provider(10, () => {
    started.resolve()
    return release.promise
  })] })
  await started.promise
  service.updateSettings({ quoteRefreshSec: 10 })
  try {
    const fresh = await Promise.race([
      service.quotes(true, { providers: [provider(20)] }),
      new Promise((resolve) => setImmediate(() => resolve(null))),
    ])
    assert.equal(fresh?.quotes[0]?.price, 20)
  } finally {
    release.resolve()
    assert.equal((await old).quotes[0]?.price, 10)
  }
  assert.equal((await service.quotes(false)).quotes[0]?.price, 20)
})

test('settings changes reset a breaker opened by the old configuration', async (t) => {
  const service = await fixture(t)
  const broken = { name: 'broken', supports: () => true, async fetch() { return new Map() } }
  const options = { providers: [broken] }
  await service.quotes(true, options)
  await service.quotes(true, options)
  assert.equal((await service.quotes(true, { providers: [provider(20)] })).quotes.length, 0)
  service.updateSettings({ quoteRefreshSec: 10 })
  assert.equal((await service.quotes(true, { providers: [provider(20)] })).quotes[0]?.price, 20)
})

test('history shares a window request and discards old cache writes after settings changes', {
  skip: !modules.registerHooks && 'requires Node module hooks',
}, async (t) => {
  const serviceURL = new URL('../lib/service.mjs?history-fixture', import.meta.url).href
  const quotesURL = new URL('../lib/quotes.mjs', import.meta.url).href
  const key = Symbol.for('market-history-test-fixture')
  const mock = `export * from ${JSON.stringify(quotesURL)};
    export const fetchHistory = (...args) => globalThis[Symbol.for('market-history-test-fixture')](...args);`
  const hooks = modules.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './quotes.mjs' && context.parentURL === serviceURL) {
        return { url: 'data:text/javascript,' + encodeURIComponent(mock), shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
  let makeService
  try {
    ;({ createService: makeService } = await import(serviceURL))
  } finally {
    hooks.deregister()
  }
  const requests = []
  globalThis[key] = (_item, range) => {
    const pending = Promise.withResolvers()
    requests.push({ ...pending, range })
    return pending.promise
  }
  t.after(() => { delete globalThis[key] })
  const service = await fixture(t, makeService)
  const data = (price) => ({ price, points: [], high: price, low: price, source: 'fixture' })
  const old = service.history('spx', '1d', true)
  const joined = service.history('spx', '1d', false)
  assert.equal(requests.length, 1)
  service.updateSettings({ quoteRefreshSec: 10 })
  const next = service.history('spx', '1d', true)
  const other = service.history('spx', '5d', true)
  assert.deepEqual(requests.map(({ range }) => range), ['1d', '1d', '5d'])
  requests[1].resolve(data(20))
  requests[2].resolve(data(30))
  assert.equal((await next).price, 20)
  assert.equal((await other).price, 30)
  requests[0].resolve(data(10))
  assert.equal((await old).price, 10)
  assert.equal((await joined).price, 10)
  assert.equal((await service.history('spx', '1d')).price, 20)
})
