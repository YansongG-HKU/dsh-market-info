import http from 'node:http'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { URL } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'

/** Browser personas used for header rotation (UA + client hints stay consistent). */
export const PERSONAS = [
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    chua: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"Windows"',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    chua: '"Microsoft Edge";v="129", "Chromium";v="129", "Not_A Brand";v="24"',
    platform: '"Windows"',
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    chua: '',
    platform: '"macOS"',
  },
  {
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    chua: '',
    platform: '"Linux"',
  },
  {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    chua: '',
    platform: '"iOS"',
  },
]
const DEFAULT_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.7',
  'accept-encoding': 'gzip, deflate, br',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'upgrade-insecure-requests': '1',
}
const MAX_REDIRECTS = 5
const COOKIE_JAR = new Map()
const HOST_GATE = new Map()
let personaCursor = 0

/** Read the Windows system proxy from the registry; empty string when absent. */
export function detectSystemProxy() {
  if (process.platform !== 'win32') return ''
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8' })
    const out = (r && r.stdout) || ''
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/.test(out)
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/)
    return enabled && m ? 'http://' + m[1] : ''
  } catch {
    return ''
  }
}

/** Pick one persona; rotate means round-robin across attempts/requests. */
export function pickPersona(options) {
  const opts = options || {}
  if (opts.personaIndex >= 0 && opts.personaIndex < PERSONAS.length) return PERSONAS[opts.personaIndex]
  if (opts.rotateUA) {
    personaCursor = (personaCursor + 1) % PERSONAS.length
    return PERSONAS[personaCursor]
  }
  return PERSONAS[0]
}

/** Build browser-like headers for a persona plus explicit overrides. */
export function buildHeaders(options) {
  const opts = options || {}
  const persona = pickPersona(opts)
  const headers = Object.assign({}, DEFAULT_HEADERS, { 'user-agent': persona.ua }, opts.headers || {})
  if (persona.chua) {
    headers['sec-ch-ua'] = persona.chua
    headers['sec-ch-ua-mobile'] = '?0'
    headers['sec-ch-ua-platform'] = persona.platform
  }
  if (!headers['sec-fetch-dest']) headers['sec-fetch-dest'] = 'document'
  if (!headers['sec-fetch-mode']) headers['sec-fetch-mode'] = 'navigate'
  if (!headers['sec-fetch-site']) headers['sec-fetch-site'] = 'none'
  return headers
}

/** Heuristic block/challenge detection over status + body text. */
export function detectBlock(status, text) {
  const s = String(text || '')
  const low = s.toLowerCase()
  if (status === 429) return { blocked: true, kind: 'rate-limit' }
  if (status === 403 && /just a moment|cf-chl|checking your browser|attention required|cloudflare/i.test(s)) {
    return { blocked: true, kind: 'cloudflare' }
  }
  if (/just a moment|cf-chl|checking your browser|turnstile/i.test(s)) return { blocked: true, kind: 'cloudflare' }
  if (/captcha|hcaptcha|recaptcha|are you a robot|unusual activity|access denied|enable javascript and cookies/i.test(low)) {
    return { blocked: true, kind: 'challenge' }
  }
  if (status === 403) return { blocked: true, kind: 'forbidden' }
  if (status === 401) return { blocked: true, kind: 'auth' }
  return { blocked: false, kind: '' }
}

/** Decode a proxy response body by its content-encoding header. */
export function decompressBody(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase().trim()
  try {
    if (!enc || enc === 'identity') return buffer.toString('utf8')
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer).toString('utf8')
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer).toString('utf8')
    if (enc.includes('deflate')) return zlib.inflateSync(buffer).toString('utf8')
    return buffer.toString('utf8')
  } catch {
    return buffer.toString('utf8')
  }
}

function cookieHeader(host) {
  const jar = COOKIE_JAR.get(host)
  if (!jar || jar.size === 0) return ''
  return Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; ')
}
function storeCookies(host, setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : [])
  if (!list.length) return
  const jar = COOKIE_JAR.get(host) || new Map()
  for (const raw of list) {
    const first = String(raw).split(';')[0]
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!name) continue
    jar.set(name, value)
    if (jar.size > 60) {
      const oldest = jar.keys().next().value
      jar.delete(oldest)
    }
  }
  COOKIE_JAR.set(host, jar)
}
export function clearCookieJar() {
  COOKIE_JAR.clear()
}

function budget(options) {
  const timeout = AbortSignal.timeout(Math.max(1, Number(options.timeoutMs) || 25000))
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
}
function cancellableDelay(ms, signal) { return wait(ms, undefined, { signal }) }
async function abortable(promise, signal) {
  signal?.throwIfAborted()
  let abort
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal?.addEventListener('abort', abort, { once: true })
    })])
  } finally { if (abort) signal?.removeEventListener('abort', abort) }
}

/** Shared host politeness gate: at most one request per host per minIntervalMs. */
async function waitHost(host, minIntervalMs, signal) {
  if (!minIntervalMs || minIntervalMs <= 0) return
  const prev = HOST_GATE.get(host) || Promise.resolve()
  const next = prev.then(async () => {
    signal?.throwIfAborted()
    const last = HOST_GATE.get(host + ':at') || 0
    const wait = last + minIntervalMs - Date.now()
    if (wait > 0) await cancellableDelay(wait, signal)
    HOST_GATE.set(host + ':at', Date.now())
  })
  HOST_GATE.set(host, next.catch(() => {}))
  return abortable(next, signal)
}

export function chooseProxy(options, attempt) {
  const opts = options || {}
  const pool = Array.isArray(opts.proxies) ? opts.proxies.filter((p) => typeof p === 'string' && p) : []
  if (pool.length) return pool[(attempt || 0) % pool.length]
  return opts.proxy || ''
}

function backoffDelay(attempt, retryAfterMs) {
  const base = Math.min(4000, 350 * Math.pow(2, attempt || 0))
  const jitter = Math.floor(Math.random() * 200)
  return Math.min(6000, Math.max(retryAfterMs || 0, base + jitter))
}

function openTunnel(proxyUrl, host, port, signal) {
  return new Promise((resolve, reject) => {
    let p
    try {
      p = new URL(proxyUrl)
    } catch {
      reject(new Error('invalid proxy url: ' + proxyUrl))
      return
    }
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      signal,
      path: host + ':' + port,
      headers: { host: host + ':' + port },
    })
    req.setTimeout(20000, () => req.destroy(new Error('proxy CONNECT timeout')))
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error('proxy CONNECT rejected: HTTP ' + res.statusCode))
        return
      }
      const secure = tls.connect({ socket: socket, servername: host, signal })
      secure.setTimeout(20000, () => secure.destroy(new Error('TLS handshake timeout')))
      secure.on('secureConnect', () => resolve(secure))
      secure.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

function readBodyBuffer(res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    res.on('end', () => resolve(Buffer.concat(chunks)))
    res.on('error', reject)
  })
}

async function requestOverProxy(target, proxyUrl, options, attempt) {
  const headers = Object.assign({}, options.headers || {}, { 'accept-encoding': 'gzip, deflate, br' })
  const timeoutMs = options.timeoutMs || 25000
  let method = String(options.method || 'GET').toUpperCase()
  let body = typeof options.body === 'string' ? options.body : null
  if (body !== null) {
    headers['content-length'] = String(Buffer.byteLength(body))
    if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
  }
  let current = target
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const u = new URL(current)
    const socket = await openTunnel(proxyUrl, u.hostname, Number(u.port) || 443, options.signal)
    try {
      const agent = new http.Agent({ keepAlive: false })
      agent.createConnection = () => socket
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: u.hostname,
            port: Number(u.port) || 443,
            path: u.pathname + u.search,
            method: method,
            signal: options.signal,
            headers: Object.assign({}, headers, { host: u.host, cookie: cookieHeader(u.hostname) }),
            agent: agent,
          },
          resolve,
        )
        req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout: ' + current)))
        req.on('error', reject)
        req.end(body === null ? undefined : body)
      })
      storeCookies(u.hostname, res.headers['set-cookie'])
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers && res.headers.location) {
        res.resume()
        current = new URL(res.headers.location, u).toString()
        if (method !== 'GET') {
          method = 'GET'
          body = null
          delete headers['content-length']
        }
        continue
      }
      const buffer = await readBodyBuffer(res)
      const text = decompressBody(buffer, res.headers['content-encoding'])
      const block = detectBlock(res.statusCode, text)
      return {
        status: res.statusCode,
        text: text,
        finalUrl: current,
        viaProxy: true,
        attempts: (attempt || 0) + 1,
        blocked: block.blocked,
        blockKind: block.kind,
        retryAfter: Number(res.headers['retry-after']) || 0,
      }
    } finally {
      try {
        socket.destroy()
      } catch {}
    }
  }
  throw new Error('too many redirects: ' + target)
}

async function requestDirect(target, options, attempt) {
  const headers = Object.assign({}, options.headers || {})
  const res = await fetch(target, {
    headers: headers,
    redirect: 'follow',
    signal: options.signal,
  })
  const text = await res.text()
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  storeCookies(new URL(target).hostname, setCookie)
  const block = detectBlock(res.status, text)
  return {
    status: res.status,
    text: text,
    finalUrl: res.url,
    viaProxy: false,
    attempts: (attempt || 0) + 1,
    blocked: block.blocked,
    blockKind: block.kind,
    retryAfter: Number(res.headers.get('retry-after')) || 0,
  }
}

async function oneRequest(target, options, attempt) {
  const opts = options || {}
  const proxy = chooseProxy(opts, attempt)
  const headers = Object.assign({}, opts.headers || {})
  const cookie = cookieHeader(new URL(target).hostname)
  if (cookie && !headers.cookie) headers.cookie = cookie
  const merged = Object.assign({}, opts, { headers: headers })
  if (proxy && /^https:/i.test(target)) {
    try {
      return await requestOverProxy(target, proxy, merged, attempt)
    } catch (error) {
      opts.signal?.throwIfAborted()
      if (!opts.fallbackDirect) throw error
      return requestDirect(target, merged, attempt)
    }
  }
  return requestDirect(target, merged, attempt)
}

/**
 * Fetch a URL as text with browser-persona headers, retries/backoff, cookie jar,
 * proxy rotation, per-host politeness and challenge detection.
 */
export async function fetchText(url, options) {
  const opts = Object.assign({ retries: 0, rotateUA: false, jar: true }, options || {})
  opts.signal = budget(opts)
  opts.signal.throwIfAborted()
  const retries = Math.max(0, Math.min(5, Number(opts.retries) || 0))
  opts.headers = buildHeaders(opts)
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await waitHost(new URL(url).hostname, Number(opts.minIntervalMs) || 0, opts.signal)
      // Each attempt rotates the persona (and therefore UA + client hints).
      if (attempt > 0) opts.headers = buildHeaders(opts)
      const res = await oneRequest(url, opts, attempt)
      const retryable = res.status === 429 || res.status >= 500 || (res.blocked && attempt < retries)
      if (retryable && attempt < retries) {
        await cancellableDelay(backoffDelay(attempt, res.retryAfter * 1000), opts.signal)
        continue
      }
      return res
    } catch (error) {
      opts.signal.throwIfAborted()
      lastError = error
      if (attempt < retries) {
        await cancellableDelay(backoffDelay(attempt, 0), opts.signal)
        continue
      }
    }
  }
  throw lastError || new Error('fetch failed: ' + url)
}

/** POST a urlencoded body and return response text (proxy-aware). */
export async function postText(url, body, options) {
  const opts = Object.assign({ retries: 0, rotateUA: true }, options || {})
  opts.signal = budget(opts)
  opts.signal.throwIfAborted()
  const headers = buildHeaders(Object.assign({}, opts, {
    headers: Object.assign({}, opts.headers || {}, { 'content-type': opts.contentType || 'application/x-www-form-urlencoded;charset=UTF-8' }),
  }))
  const proxy = chooseProxy(opts, 0)
  if (proxy && /^https:/i.test(url)) {
    return requestOverProxy(url, proxy, Object.assign({}, opts, { headers: headers, method: 'POST', body: String(body) }), 0)
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: String(body),
    signal: opts.signal,
  })
  const text = await res.text()
  const block = detectBlock(res.status, text)
  return { status: res.status, text: text, finalUrl: res.url, viaProxy: false, attempts: 1, blocked: block.blocked, blockKind: block.kind }
}
