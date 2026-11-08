/**
 * CN macro adapters: nbs / pbc / customs / safe.
 *
 * The four sources publish monthly macro data as HTML release lists. Their
 * query APIs (data.stats.gov.cn, stats.customs.gov.cn) sit behind a WAF and
 * answer 403/412 to plain HTTP, so the adapters read the public list pages and
 * surface a title/link/date stream. When the WAF wins we return an empty
 * payload with `meta.needsBrowser: true` instead of retrying.
 */

const HTML = { accept: 'text/html,application/xhtml+xml' }

/** Strip tags and the entities that show up in CN government titles. */
function clean(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function abs(href, base) {
  try {
    return new URL(href, base).href
  } catch {
    return ''
  }
}

function limitOf(params, fallback) {
  const n = Number(params && params.limit)
  return Math.max(1, Math.min(60, Number.isFinite(n) ? n : fallback))
}

function at(dateText) {
  const ms = Date.parse(String(dateText || ''))
  return Number.isFinite(ms) ? ms : null
}

/**
 * net-fast decodes every body as UTF-8. A GBK page would arrive as U+FFFD and
 * cannot be recovered from the decoded string, so flag it instead of parsing
 * mojibake. All four list pages are UTF-8 at the time of writing.
 */
function garbled(text) {
  return (String(text || '').match(/\uFFFD/g) || []).length > 20
}

/** NBS: one <li> holds three responsive copies of the same link plus a date. */
function parseNbs(text, limit) {
  const out = []
  for (const chunk of String(text || '').split(/<li[ >]/).slice(1)) {
    const link = /<a[^>]*\shref="([^"]+)"[^>]*\stitle=['"]([^'"]+)['"]/.exec(chunk)
    const date = /<span>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/.exec(chunk)
    if (!link || !date) continue
    const url = abs(link[1], 'https://www.stats.gov.cn/sj/zxfb/')
    const title = clean(link[2])
    if (!url || !title) continue
    out.push({ id: 'nbs:' + url, title, url, publishedAt: at(date[1]), tags: ['统计局', '数据发布'] })
    if (out.length >= limit) break
  }
  return out
}

/** PBC: table rows with <a title=...> and a <span class="hui12"> date. */
function parsePbc(text, limit) {
  const out = []
  for (const chunk of String(text || '').split('<tr').slice(1)) {
    const link = /<a[^>]*\shref="([^"]+)"[^>]*\stitle="([^"]+)"/.exec(chunk)
    const date = /<span class="hui12">\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/.exec(chunk)
    if (!link || !date) continue
    const url = abs(link[1], 'http://www.pbc.gov.cn/')
    const title = clean(link[2])
    if (!url || !title) continue
    out.push({ id: 'pbc:' + url, title, url, publishedAt: at(date[1]), tags: ['央行', '沟通交流'] })
    if (out.length >= limit) break
  }
  return out
}

/** SAFE: <li><dt><a title=...></dt><dd>date</dd></li>. */
function parseSafe(text, limit) {
  const out = []
  for (const chunk of String(text || '').split('<li>').slice(1)) {
    const link = /<a[^>]*\shref="([^"]+)"[^>]*\stitle="([^"]+)"/.exec(chunk)
    const date = /<dd>\s*(\d{4}-\d{2}-\d{2})\s*<\/dd>/.exec(chunk)
    if (!link || !date) continue
    const url = abs(link[1], 'https://www.safe.gov.cn/')
    const title = clean(link[2])
    if (!url || !title) continue
    out.push({ id: 'safe:' + url, title, url, publishedAt: at(date[1]), tags: ['外汇局', '储备'] })
    if (out.length >= limit) break
  }
  return out
}

/** Last-resort list parser: anchor text followed by a date within ~160 chars. */
function parseGeneric(text, base, limit, tag) {
  const out = []
  const re = /<a[^>]*\shref="([^"]+)"[^>]*>([^<]{6,120})<\/a>[\s\S]{0,160}?(\d{4}-\d{2}-\d{2})/g
  let match
  while ((match = re.exec(String(text || ''))) && out.length < limit) {
    const url = abs(match[1], base)
    const title = clean(match[2])
    if (!url || !title || /^(更多|首页|上一页|下一页|尾页|网站地图)/.test(title)) continue
    out.push({ id: tag + ':' + url, title, url, publishedAt: at(match[3]), tags: [tag] })
  }
  return out
}

const nbs = {
  id: 'nbs',
  name: '国家统计局',
  category: 'macro',
  region: 'CN',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://www.stats.gov.cn',
  note: '数据发布列表页可用；统计查询 API（data.stats.gov.cn）直连 403，需浏览器兜底',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 9000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 40)
    try {
      const res = await ctx.getJson('https://www.stats.gov.cn/sj/zxfb/', { headers: HTML, timeoutMs: 8000 })
      if (!res.ok) {
        return { items: [], meta: { error: 'list http ' + (res.status || res.error), needsBrowser: res.status === 403 || res.status === 412, probed: ['sj/zxfb'] } }
      }
      if (garbled(res.text)) return { items: [], meta: { error: 'non-utf8 body', needsBrowser: true } }
      const items = parseNbs(res.text, limit)
      if (!items.length) return { items: [], meta: { error: 'parsed 0 rows', needsBrowser: true } }
      return { items, meta: { total: items.length, endpoint: 'sj/zxfb', api: 'easyquery 403' } }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

const pbc = {
  id: 'pbc',
  name: '中国人民银行',
  category: 'policy',
  region: 'CN',
  tier: 'B',
  capability: ['list'],
  homepage: 'http://www.pbc.gov.cn',
  note: '沟通交流/新闻发布列表页；RSS 入口已 404',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 9000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 40)
    try {
      const res = await ctx.getJson('http://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html', { headers: HTML, timeoutMs: 8000 })
      if (!res.ok) return { items: [], meta: { error: 'list http ' + (res.status || res.error), needsBrowser: res.status === 403 || res.status === 412 } }
      if (garbled(res.text)) return { items: [], meta: { error: 'non-utf8 body', needsBrowser: true } }
      const items = parsePbc(res.text, limit)
      if (!items.length) return { items: [], meta: { error: 'parsed 0 rows' } }
      return { items, meta: { total: items.length, endpoint: 'goutongjiaoliu/113469', rss: '404' } }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

const customs = {
  id: 'customs',
  name: '海关总署',
  category: 'macro',
  region: 'CN',
  tier: 'B',
  capability: ['list'],
  homepage: 'http://www.customs.gov.cn',
  note: '统计子站风控，走新闻列表页；列表页同为 412，需浏览器上下文',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 12000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 40)
    const probes = [
      'http://www.customs.gov.cn/customs/302249/302266/index.html',
      'http://www.customs.gov.cn/customs/302249/index.html',
    ]
    const statuses = []
    for (const href of probes) {
      try {
        const res = await ctx.getJson(href, { headers: HTML, timeoutMs: 5000 })
        statuses.push(res.status || 0)
        if (!res.ok) continue
        if (garbled(res.text)) continue
        const items = parseGeneric(res.text, 'http://www.customs.gov.cn/', limit, 'customs')
        if (items.length) return { items, meta: { total: items.length, endpoint: href, probed: statuses } }
      } catch (error) {
        statuses.push(String(error && error.message ? error.message : error))
      }
    }
    return { items: [], meta: { error: 'WAF ' + statuses.join('/') + '; needs browser', needsBrowser: true, probed: probes.length } }
  },
}

const safe = {
  id: 'safe',
  name: '国家外汇管理局',
  category: 'macro',
  region: 'CN',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://www.safe.gov.cn',
  note: '外汇储备（whcb）列表页；国际收支与结售汇见站内统计栏目',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 9000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 40)
    try {
      const res = await ctx.getJson('https://www.safe.gov.cn/safe/whcb/index.html', { headers: HTML, timeoutMs: 8000 })
      if (!res.ok) return { items: [], meta: { error: 'list http ' + (res.status || res.error), needsBrowser: res.status === 403 || res.status === 412 } }
      if (garbled(res.text)) return { items: [], meta: { error: 'non-utf8 body', needsBrowser: true } }
      const items = parseSafe(res.text, limit)
      if (!items.length) return { items: [], meta: { error: 'parsed 0 rows' } }
      return { items, meta: { total: items.length, endpoint: 'safe/whcb' } }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

export const adapters = [nbs, pbc, customs, safe]
