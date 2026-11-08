import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fetchText, postText } from '../lib/net.mjs'
import { createSourceLayer } from '../lib/sources/index.mjs'
import { closePool } from '../lib/net-fast.mjs'
async function local(handler, testBody){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));try{await testBody(`http://127.0.0.1:${s.address().port}`)}finally{closePool();s.closeAllConnections();await new Promise(r=>s.close(r))}}
test('published GET and POST entry points reject pre-cancelled requests without network',async()=>{let hits=0;await local((q,r)=>{hits++;r.end('{}')},async url=>{const c=new AbortController();c.abort();await assert.rejects(fetchText(url,{signal:c.signal}));await assert.rejects(postText(url,'x',{signal:c.signal}));assert.equal(hits,0)})})
test('published GET deadline covers retry backoff and host pacing',async()=>{await local((q,r)=>{r.writeHead(503);r.end('retry')},async url=>{const start=Date.now();await assert.rejects(fetchText(url,{timeoutMs:100,retries:5,minIntervalMs:1000}));assert.ok(Date.now()-start<800)})})
test('published proxy CONNECT cancels instead of falling back to a direct request',async()=>{const s=http.createServer();s.on('connect',()=>{});await new Promise(r=>s.listen(0,'127.0.0.1',r));const c=new AbortController();setTimeout(()=>c.abort(),40);try{await assert.rejects(fetchText('https://example.invalid/',{proxy:`http://127.0.0.1:${s.address().port}`,fallbackDirect:true,signal:c.signal}));}finally{s.closeAllConnections();s.close()}})
for(const name of ['getJson','postJson','fetchJson','request'])test(`adapter ${name} is bound to its parent cancellation signal`,async()=>{await local(()=>{},async url=>{const layer=createSourceLayer({adapters:[{id:'test',name:'test',category:'macro',region:'CN',timeoutMs:60,fetch:async ctx=>{const r=name==='postJson'?await ctx[name](url,'x',{signal:undefined}):await ctx[name](url,{signal:undefined});assert.equal(r.ok,false);return {items:[],meta:{error:r.error}}}}]});const start=Date.now();await layer.fetchOne('test',{},{});assert.ok(Date.now()-start<800)})})
