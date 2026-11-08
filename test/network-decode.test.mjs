import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import { request, closePool } from '../lib/net-fast.mjs'
import { fetchText, postText, decompressBody } from '../lib/net.mjs'

async function local(encoding, body, run) {
  const server = http.createServer((req, res) => { if (encoding) res.setHeader('content-encoding', encoding); res.end(body) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run('http://127.0.0.1:' + server.address().port) }
  finally { closePool(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
const text = '官方数据 UTF-8 ' + 'payload '.repeat(10000)
for (const [encoding, encode] of [['gzip', zlib.gzipSync], ['br', zlib.brotliCompressSync], ['deflate', zlib.deflateSync], ['', Buffer.from]]) {
  test('pooled response preserves ' + (encoding || 'plain') + ' payload bytes', async () => {
    await local(encoding, encode(text), async url => {
      const result = await request(url)
      assert.equal(result.ok, true)
      assert.equal(result.text, text)
      assert.equal((await fetchText(url, { minIntervalMs: 0, retries: 0 })).text, text)
      assert.equal((await postText(url, 'x', { timeoutMs: 1000 })).text, text)
    })
  })
}
test('corrupt compression reports a decode error without rejecting', async () => {
  await local('gzip', Buffer.from('bad gzip'), async url => {
    const result = await request(url)
    assert.equal(result.ok, false)
    assert.match(result.error, /decode failed/)
  })
})
for (const mode of ['abort', 'deadline']) test(mode + ' during asynchronous decode returns promptly and skips subsequent string conversion', async () => {
  const original = zlib.gunzip
  let decoding
  const started = new Promise(resolve => { decoding = resolve })
  let complete
  zlib.gunzip = (buffer, options, callback) => { complete = callback; decoding() }
  const isolated = await import('../lib/net-fast.mjs?decode-cancel-test=' + mode)
  const controller = new AbortController()
  let converted = false
  const output = Buffer.from('decoded')
  output.toString = () => { converted = true; return 'decoded' }
  try {
    await local('gzip', zlib.gzipSync('decoded'), async url => {
      const pending = isolated.request(url, { signal: controller.signal, timeoutMs: 500 })
      await started
      if (mode === 'abort') controller.abort()
      const result = await pending
      assert.equal(result.ok, false)
      assert.match(result.error, /aborted/)
      complete(null, output)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(converted, false)
    })
  } finally { zlib.gunzip = original; isolated.closePool() }
})

test('legacy synchronous decode helper remains compatible including corrupt fallback', () => {
  assert.equal(decompressBody(zlib.gzipSync(text), 'gzip'), text)
  assert.equal(decompressBody(Buffer.from('bad gzip'), 'gzip'), 'bad gzip')
})
