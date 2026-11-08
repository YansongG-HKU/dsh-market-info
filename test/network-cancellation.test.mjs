import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { request, closePool } from '../lib/net-fast.mjs'

async function local(handler, run) {
  const server = http.createServer(handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { closePool(); server.closeAllConnections(); await new Promise(r => server.close(r)) }
}
test('already cancelled request never reaches server', async () => {
  let hits = 0
  await local((req,res) => { hits++;res.end('ok') }, async url => {
    const c = new AbortController(); c.abort()
    assert.equal((await request(url, { signal:c.signal })).ok, false)
    assert.equal(hits, 0)
  })
})
test('inflight cancellation ends promptly', async () => {
  await local(() => {}, async url => {
    const c = new AbortController();setTimeout(() => c.abort(), 25)
    const result = await request(url, {signal:c.signal,timeoutMs:2000})
    assert.equal(result.ok,false);assert.ok(result.ms < 1000)
  })
})
test('queued cancellation removes waiter without a fifth request or losing a slot', async () => {
  let hits = 0
  await local((req,res) => {hits++;if(hits>4)res.end('ok')}, async url => {
    const blockers = new AbortController()
    const requests = Array.from({length:4},()=>request(url,{signal:blockers.signal,timeoutMs:2000}))
    while(hits<4)await new Promise(r=>setTimeout(r,5))
    const c=new AbortController();setTimeout(()=>c.abort(),20)
    const cancelled=await request(url,{signal:c.signal})
    assert.equal(cancelled.ok,false);assert.equal(hits,4)
    blockers.abort();await Promise.all(requests)
    assert.equal((await request(url)).ok,true)
  })
})
test('deadline covers all redirects together', async () => {
  await local((req,res) => setTimeout(()=>{res.writeHead(302,{location:'/again'});res.end()},150), async url => {
    const result=await request(url,{timeoutMs:500,redirects:10})
    assert.equal(result.ok,false);assert.ok(result.ms<1100)
  })
})

test('deadline also expires while queued behind active requests', async () => {
  let hits=0
  await local(()=>{hits++},async url=>{
    const c=new AbortController(),busy=Array.from({length:4},()=>request(url,{signal:c.signal,timeoutMs:2000}))
    while(hits<4)await new Promise(r=>setTimeout(r,5))
    try{const result=await request(url,{timeoutMs:500});assert.equal(result.ok,false);assert.ok(result.ms<1000);assert.equal(hits,4)}finally{c.abort();await Promise.all(busy)}
  })
})
