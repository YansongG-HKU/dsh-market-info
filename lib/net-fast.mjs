/**
 * Lean HTTP path for official / public endpoints.
 *
 * The anti-block pipeline in net.mjs is optimised for hostile sites: UA rotation,
 * cookie jar, retries with backoff, proxy pools. Official APIs need none of that
 * and pay a price for it (extra header building, retry sleeps). This module is the
 * fast lane:
 *
 *   - per-protocol keep-alive agents with a large socket pool (no TLS handshake
 *     and no TCP setup on the second request to the same host);
 *   - asynchronous gzip / brotli / deflate decode on the shared libuv pool;
 *   - hard per-request deadline via AbortController;
 *   - bounded redirect following that preserves method on 307/308;
 *   - one shared JSON parse path, so adapters stay tiny.
 *
 * Nothing here throws for an HTTP error status; callers inspect `status`.
 */
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import { decodeBuffer } from './decode.mjs'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** A generous pool: the panel fans out to ~20 hosts at once on a cold start. */
function makeAgent(lib) {
  return new lib.Agent({
    keepAlive: true,
    keepAliveMsecs: 4000,
    maxSockets: 64,
    maxFreeSockets: 24,
    scheduling: 'lifo',
    timeout: 30000,
  })
}

const AGENTS = {
  'http:': makeAgent(http),
  'https:': makeAgent(https),
}

/**
 * Per-host concurrency ceiling.
 *
 * A cold collection fires 33 adapters at once, and a dozen of them hit Eastmoney /
 * Sina simultaneously. Those hosts start resetting or stalling the excess, which
 * looked like "source empty" across unrelated adapters. Four sockets per host keeps
 * the fan-out wide across hosts without hammering any single one.
 */
const HOST_LIMIT = 4
const hostActive = new Map()
const hostQueue = new Map()

async function acquireHost(host, signal) {
  signal?.throwIfAborted()
  const active = hostActive.get(host) || 0
  if (active < HOST_LIMIT) {
    hostActive.set(host, active + 1)
    return
  }
  await new Promise((resolve, reject) => {
    const queue = hostQueue.get(host) || []
    const grant = () => { signal?.removeEventListener('abort', abort); resolve() }
    const abort = () => {
      const index = queue.indexOf(grant)
      if (index >= 0) queue.splice(index, 1)
      signal?.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('aborted'))
    }
    queue.push(grant)
    hostQueue.set(host, queue)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
  // The slot is handed over by releaseHost; the count stays as it was.
}

function releaseHost(host) {
  const queue = hostQueue.get(host)
  if (queue && queue.length > 0) {
    queue.shift()()
    return
  }
  hostActive.set(host, Math.max(0, (hostActive.get(host) || 1) - 1))
}

/** Sockets currently alive per agent, for the latency panel. */
export function poolStats() {
  const rows = []
  for (const [protocol, agent] of Object.entries(AGENTS)) {
    let sockets = 0
    let free = 0
    for (const list of Object.values(agent.sockets || {})) sockets += list.length
    for (const list of Object.values(agent.freeSockets || {})) free += list.length
    rows.push({ protocol: protocol, sockets: sockets, free: free, requests: agent.requests || {} })
  }
  return rows
}

/** Close every pooled socket (tests, shutdown). */
export function closePool() {
  for (const agent of Object.values(AGENTS)) {
    try {
      agent.destroy()
    } catch {}
  }
}


function once(lib, options, body, deadlineMs, label) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let onAbort = null
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (onAbort) options.signal?.removeEventListener('abort', onAbort)
      resolve(Object.assign({ ms: Date.now() - started }, value))
    }
    const url = new URL(options.href)
    const agent = AGENTS[url.protocol]
    const request = (url.protocol === 'https:' ? https : http).request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || 'GET',
        agent: agent,
        headers: options.headers,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('error', (error) => finish({ error: String(error && error.message ? error.message : error) }))
        response.on('end', async () => {
          if (settled) return
          let text = ''
          try {
            const buffer = await decodeBuffer(Buffer.concat(chunks), response.headers['content-encoding'])
            // Cancellation/deadline may settle while libuv is decoding. Skip the
            // remaining main-thread string work and never resurrect that request.
            if (settled) return
            // A few CN sites still serve GBK; decoding the bytes with the declared
            // charset beats transferring a lossy UTF-8 string and trying to repair it.
            text = options.charset && String(options.charset).toLowerCase() !== 'utf-8'
              ? new TextDecoder(String(options.charset)).decode(buffer)
              : buffer.toString('utf8')
          } catch (error) {
            finish({ error: 'decode failed: ' + String(error && error.message ? error.message : error) })
            return
          }
          finish({
            status: response.statusCode || 0,
            headers: response.headers,
            location: response.headers.location || '',
            text: text,
          })
        })
      },
    )
    const timer = setTimeout(() => {
      try {
        request.destroy()
      } catch {}
      finish({ error: 'timeout after ' + deadlineMs + 'ms', timeout: true })
    }, deadlineMs)
    request.on('error', (error) => finish({ error: String(error && error.message ? error.message : error) }))
    request.on('timeout', () => {
      try {
        request.destroy()
      } catch {}
      finish({ error: 'socket timeout', timeout: true })
    })
    if (options.signal) {
      if (options.signal.aborted) {
        try {
          request.destroy()
        } catch {}
        finish({ error: 'aborted' })
        return
      }
      onAbort = () => {
        try {
          request.destroy()
        } catch {}
        finish({ error: 'aborted' })
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    if (body && body.length) request.write(body)
    request.end()
  })
}

/**
 * One HTTP request over the pooled fast path.
 *
 * @param {string} href absolute http(s) URL
 * @param {{method?:string, headers?:object, body?:string|Buffer, timeoutMs?:number,
 *          redirects?:number, signal?:AbortSignal, ua?:string, referer?:string}} options
 * @returns {Promise<{ok:boolean,status:number,headers:object,text:string,json?:any,
 *                    ms:number,url:string,error?:string,redirects?:number}>}
 */
export async function request(href, options) {
  const opts = options || {}
  const method = String(opts.method || 'GET').toUpperCase()
  const body = opts.body === undefined || opts.body === null
    ? null
    : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body)))
  const headers = Object.assign(
    {
      'user-agent': opts.ua || DEFAULT_UA,
      accept: 'application/json, text/plain, */*',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      connection: 'keep-alive',
    },
    opts.referer ? { referer: opts.referer } : null,
    body ? { 'content-length': String(body.length) } : null,
    body && !(opts.headers || {})['content-type'] ? { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } : null,
    opts.headers || null,
  )
  const maxRedirects = Number.isFinite(opts.redirects) ? Number(opts.redirects) : 3
  const deadlineMs = Math.max(500, Number(opts.timeoutMs) || 8000)
  let current = href
  let currentMethod = method
  let currentBody = body
  let redirects = 0
  const started = Date.now()
  const controller = new AbortController()
  const abort = () => controller.abort(opts.signal.reason)
  opts.signal?.addEventListener('abort', abort, { once: true })
  if (opts.signal?.aborted) abort()
  const deadline = started + deadlineMs
  const timer = setTimeout(() => controller.abort(new Error('request deadline exceeded')), deadlineMs)

  try {
  for (;;) {
    let result
    let host = ''
    try {
      host = new URL(current).hostname
    } catch {
      return { ok: false, status: 0, headers: {}, text: '', ms: Date.now() - started, url: current, error: 'bad url' }
    }
    try {
      await acquireHost(host, controller.signal)
    } catch (error) {
      return { ok: false, status: 0, headers: {}, text: '', ms: Date.now() - started, url: current, error: String(error?.message || error) }
    }
    try {
      result = await once(https, { href: current, method: currentMethod, headers: headers, charset: opts.charset, signal: controller.signal }, currentBody, Math.max(1, deadline - Date.now()), current)
    } catch (error) {
      // new URL() / http.request() can throw synchronously; this module never throws.
      return { ok: false, status: 0, headers: {}, text: '', ms: Date.now() - started, url: current, error: String(error && error.message ? error.message : error) }
    } finally {
      releaseHost(host)
    }
    if (result.error) {
      return { ok: false, status: 0, headers: {}, text: '', ms: Date.now() - started, url: current, error: result.error }
    }
    const status = result.status
    if (status >= 300 && status < 400 && result.location && redirects < maxRedirects) {
      let next
      try {
        next = new URL(result.location, current).href
      } catch {
        return { ok: false, status: status, headers: result.headers, text: result.text, ms: Date.now() - started, url: current, error: 'bad redirect' }
      }
      // 303 always becomes GET; 301/302 turn POST into GET in practice; 307/308 keep everything.
      if (status === 303 || ((status === 301 || status === 302) && currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
        currentMethod = 'GET'
        currentBody = null
        delete headers['content-length']
        delete headers['content-type']
      }
      redirects += 1
      current = next
      continue
    }
    return {
      ok: status >= 200 && status < 300,
      status: status,
      headers: result.headers,
      text: result.text,
      ms: Date.now() - started,
      url: current,
      redirects: redirects,
    }
  }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', abort)
  }
}

function parseJson(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return { json: null, jsonError: 'empty body' }
  // Some CN endpoints answer with JSONP-ish wrappers.
  const stripped = trimmed.replace(/^[\w$.]+\s*\(/, '').replace(/\)\s*;?\s*$/, '')
  try {
    return { json: JSON.parse(stripped), jsonError: '' }
  } catch (error) {
    return { json: null, jsonError: String(error && error.message ? error.message : error) }
  }
}

/** GET a URL and parse it as JSON. Never throws. */
export async function getJson(href, options) {
  const result = await request(href, options)
  if (!result.ok) return Object.assign(result, { json: null, jsonError: result.error || ('http ' + result.status) })
  const parsed = parseJson(result.text)
  return Object.assign(result, { json: parsed.json, jsonError: parsed.jsonError })
}

/** POST (form or raw) and parse the answer as JSON. Never throws. */
export async function postJson(href, body, options) {
  const opts = Object.assign({}, options || {}, { method: 'POST', body: body })
  const result = await request(href, opts)
  if (!result.ok) return Object.assign(result, { json: null, jsonError: result.error || ('http ' + result.status) })
  const parsed = parseJson(result.text)
  return Object.assign(result, { json: parsed.json, jsonError: parsed.jsonError })
}

/** Resolve after at most `ms`; the pending promise keeps running. */
export function withTimeout(promise, ms, label) {
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true, label: label || 'timeout' }), Math.max(1, ms))
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/** Run tasks with a fixed concurrency ceiling, preserving input order. */
export async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : []
  const out = new Array(list.length)
  let cursor = 0
  const size = Math.max(1, Math.min(Number(limit) || 8, list.length || 1))
  const runners = new Array(size).fill(0).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      try {
        out[index] = await worker(list[index], index)
      } catch (error) {
        out[index] = { ok: false, error: String(error && error.message ? error.message : error) }
      }
    }
  })
  await Promise.all(runners)
  return out
}

export { DEFAULT_UA }
