import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { closePool } from '../lib/net-fast.mjs'
import { createService } from '../lib/service.mjs'

function rss(title, id) {
  return `<rss><channel><item><title>${title}</title><link>https://example.test/${id}</link></item></channel></rss>`
}

async function localFeed(handler, run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'market-info-feed-'))
  const server = http.createServer(handler)
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}`
    const service = createService({ dataDir, proxy: 'off', feeds: [{ id: 'local', name: 'Local', url }] })
    service.updateSettings({ antiBlock: { enabled: false } })
    await run(service)
  } finally {
    closePool()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
}

test('concurrent feed misses share a fetch and filter independently', async () => {
  let hits = 0
  await localFeed((_req, res) => {
    hits += 1
    res.end(rss('Alpha news', 'alpha'))
  }, async (service) => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      service.feed(index % 2 === 0, { keywords: [index % 2 === 0 ? 'alpha' : 'beta'] })))
    assert.equal(hits, 1)
    assert.deepEqual(results.map(({ items }) => items.length), [1, 0, 1, 0, 1, 0, 1, 0])
    assert.ok(results.every(({ cached }) => cached === false))
    assert.equal((await service.feed(false)).cached, true)
    assert.equal((await service.feed(true)).cached, false)
    assert.equal(hits, 2)
  })
})

test('a feed refresh from before settings invalidation cannot overwrite the new cache', async () => {
  const first = Promise.withResolvers()
  let hits = 0
  await localFeed((_req, res) => {
    hits += 1
    if (hits === 1) first.resolve(res)
    else res.end(rss('New data', 'new'))
  }, async (service) => {
    const old = service.feed(true)
    const oldResponse = await first.promise
    try {
      // Invalidate without changing the feed list or keyword signature.
      service.updateSettings({ antiBlock: { enabled: false } })
      const fresh = await service.feed(false)
      assert.equal(fresh.items[0]?.title, 'New data')
    } finally {
      oldResponse.end(rss('Old data', 'old'))
      await old
    }
    const cached = await service.feed(false)
    assert.equal(cached.cached, true)
    assert.equal(cached.items[0]?.title, 'New data')
    assert.equal(hits, 2)
  })
})
