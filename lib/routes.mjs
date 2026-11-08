import fs from 'node:fs'
import { buildFlowBoard } from './flow-board.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROUTE_PREFIX = '/market-info'
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const GATE_HEADER = 'x-market-info'
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > (limit || 65536)) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
function serveFile(res, file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  res.end(text)
}
function parseKeywords(url) {
  if (!url.searchParams.has('kw')) return undefined
  return String(url.searchParams.get('kw') || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean)
}

/**
 * The plugin HTTP surface. Serves the panel UI under /market-info/ui and a small
 * same-origin JSON API under /market-info/api. API calls must carry the
 * x-market-info: 1 header (the panel sets it on every fetch).
 */
export function createHandler(service) {
  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()
    if (pathname === ROUTE_PREFIX || pathname === ROUTE_PREFIX + '/') {
      res.writeHead(302, { location: ROUTE_PREFIX + '/ui' })
      res.end()
      return
    }
    if (pathname === ROUTE_PREFIX + '/ui' || pathname.startsWith(ROUTE_PREFIX + '/ui/')) {
      const rel = pathname.slice((ROUTE_PREFIX + '/ui').length).replace(/^\/+/, '') || 'index.html'
      const file = path.join(UI_DIR, rel)
      if (!file.startsWith(UI_DIR)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      serveFile(res, file)
      return
    }
    if (!pathname.startsWith(ROUTE_PREFIX + '/api/')) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    if ((req.headers || {})[GATE_HEADER] !== '1') {
      sendJson(res, 403, { ok: false, error: 'same-origin request required' })
      return
    }
    const action = pathname.slice((ROUTE_PREFIX + '/api/').length)
    try {
      if (action === 'status' && method === 'GET') {
        sendJson(res, 200, { ok: true, version: service.version, settings: service.settings(), cache: service.cache() })
        return
      }
      if (action === 'history' && method === 'GET') {
        const id = url.searchParams.get('id') || ''
        const range = url.searchParams.get('range') || '1d'
        const refresh = url.searchParams.get('refresh') === '1'
        sendJson(res, 200, Object.assign({ ok: true }, await service.history(id, range, refresh)))
        return
      }
      if (action === 'quotes' && method === 'GET') {
        const refresh = url.searchParams.get('refresh') === '1'
        sendJson(res, 200, Object.assign({ ok: true }, await service.quotes(refresh)))
        return
      }
      if (action === 'net/test' && method === 'GET') {
        sendJson(res, 200, Object.assign({ ok: true }, await service.netTest(url.searchParams.get('u') || '')))
        return
      }
      if (action === 'health' && method === 'GET') {
        sendJson(res, 200, { ok: true, sources: service.health() })
        return
      }
      // ---- official-source plane: disclosures, macro, policy, flows, sanctions ----
      if (action === 'sources' && method === 'GET') {
        sendJson(res, 200, Object.assign({ ok: true }, service.sources()))
        return
      }
      if (action === 'flow-board' && method === 'GET') {
        const payload = await service.series()
        sendJson(res, 200, Object.assign({ ok: true }, buildFlowBoard(payload.tracked, { days: Number(url.searchParams.get('days')) || 60 })))
        return
      }
      if (action === 'series' && method === 'GET') {
        const rebuild = url.searchParams.get('rebuild') === '1'
        sendJson(res, 200, Object.assign({ ok: true }, await service.series({ rebuild: rebuild })))
        return
      }
      if (action === 'source-stats' && method === 'GET') {
        sendJson(res, 200, Object.assign({ ok: true }, service.sourceStats()))
        return
      }
      if (action === 'source' && method === 'GET') {
        const id = url.searchParams.get('id') || ''
        const params = {
          q: url.searchParams.get('q') || '',
          limit: Number(url.searchParams.get('limit')) || 30,
        }
        const refresh = url.searchParams.get('refresh') === '1'
        sendJson(res, 200, Object.assign({ ok: true }, await service.fetchSource(id, params, refresh)))
        return
      }
      if (action === 'collect' && method === 'GET') {
        const cats = String(url.searchParams.get('cat') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const regions = String(url.searchParams.get('region') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const tiers = String(url.searchParams.get('tier') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const domains = String(url.searchParams.get('domain') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const result = await service.collect({
          categories: cats,
          regions: regions,
          tiers: tiers,
          domains: domains,
          limit: Number(url.searchParams.get('limit')) || 200,
          params: { q: url.searchParams.get('q') || '' },
          refresh: url.searchParams.get('refresh') === '1',
        })
        sendJson(res, 200, Object.assign({ ok: true }, result))
        return
      }
      if (action === 'brief' && method === 'GET') {
        sendJson(
          res,
          200,
          await service.brief({
            limit: Number(url.searchParams.get('limit')) || 120,
            refresh: url.searchParams.get('refresh') === '1',
          }),
        )
        return
      }
      // ---- company dossier: entity, quote, financials, filings, reports ----
      if (action === 'company' && method === 'GET') {
        const q = url.searchParams.get('q') || ''
        sendJson(
          res,
          200,
          await service.company(q, {
            limit: Number(url.searchParams.get('limit')) || 20,
            from: url.searchParams.get('from') || '',
            to: url.searchParams.get('to') || '',
            refresh: url.searchParams.get('refresh') === '1',
          }),
        )
        return
      }
      if (action === 'companies' && method === 'GET') {
        sendJson(res, 200, await service.companies(url.searchParams.get('q') || ''))
        return
      }
      if (action === 'feed' && method === 'GET') {
        const refresh = url.searchParams.get('refresh') === '1'
        const filters = {
          keywords: parseKeywords(url),
          category: url.searchParams.get('cat') || '',
          source: url.searchParams.get('src') || '',
        }
        sendJson(res, 200, Object.assign({ ok: true }, await service.feed(refresh, filters)))
        return
      }
      if (action === 'presets' && method === 'GET') {
        sendJson(res, 200, { ok: true, presets: service.presets() })
        return
      }
      if (action === 'read' && method === 'GET') {
        const target = url.searchParams.get('u') || ''
        if (!/^https?:\/\//i.test(target)) {
          sendJson(res, 400, { ok: false, error: 'u must be an http(s) url' })
          return
        }
        const refresh = url.searchParams.get('refresh') === '1'
        const title = url.searchParams.get('t') || ''
        sendJson(res, 200, Object.assign({ ok: true }, await service.read(target, { refresh: refresh, title: title })))
        return
      }
      if (action === 'search' && method === 'GET') {
        sendJson(res, 200, Object.assign({ ok: true }, await service.search(url.searchParams.get('q') || '')))
        return
      }
      if (action === 'export' && method === 'GET') {
        const target = url.searchParams.get('u') || ''
        const result = await service.exportMarkdown(target)
        if (!result.ok) {
          sendJson(res, 200, result)
          return
        }
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': 'attachment; filename="' + result.filename.replace(/"/g, '') + '"',
          'cache-control': 'no-store',
        })
        res.end(result.markdown)
        return
      }
      if (action === 'feeds' && method === 'GET') {
        sendJson(res, 200, { ok: true, feeds: service.settings().feeds })
        return
      }
      if (action === 'feeds' && method === 'POST') {
        const raw = await readBody(req)
        const body = raw ? JSON.parse(raw) : {}
        const settings = service.updateSettings({ feeds: Array.isArray(body.feeds) ? body.feeds : [] })
        sendJson(res, 200, { ok: true, feeds: settings.feeds })
        return
      }
      if (action === 'feeds/export' && method === 'GET') {
        const payload = service.exportFeeds()
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="market-info-feeds.json"',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(payload, null, 2))
        return
      }
      if (action === 'feeds/import' && method === 'POST') {
        const raw = await readBody(req, 512 * 1024)
        let payload = null
        try {
          payload = raw ? JSON.parse(raw) : null
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON' })
          return
        }
        const result = service.importFeeds(payload)
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (action === 'cache' && method === 'GET') {
        sendJson(res, 200, { ok: true, cache: service.cache() })
        return
      }
      if (action === 'cache' && method === 'POST') {
        sendJson(res, 200, { ok: true, cache: service.clearCache() })
        return
      }
      if (action === 'favorites' && method === 'GET') {
        sendJson(res, 200, { ok: true, items: service.favorites() })
        return
      }
      if (action === 'favorites' && method === 'POST') {
        const raw = await readBody(req)
        const body = raw ? JSON.parse(raw) : {}
        if (body && body.remove === true && body.url) {
          sendJson(res, 200, { ok: true, items: service.removeFavorite(String(body.url)) })
          return
        }
        const article = body && body.article ? body.article : { original: body.url, title: body.title, sourceHost: body.sourceHost }
        const result = service.toggleFavorite(article)
        sendJson(res, 200, { ok: true, added: result.added, items: service.favorites() })
        return
      }
      if (action === 'settings' && method === 'GET') {
        sendJson(res, 200, { ok: true, settings: service.settings() })
        return
      }
      if (action === 'settings' && method === 'POST') {
        const raw = await readBody(req)
        const patch = raw ? JSON.parse(raw) : {}
        sendJson(res, 200, { ok: true, settings: service.updateSettings(patch) })
        return
      }
      sendJson(res, 404, { ok: false, error: 'unknown action: ' + action })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }
}
