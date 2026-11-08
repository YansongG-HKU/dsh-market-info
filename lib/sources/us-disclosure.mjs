/** US disclosure adapters: sec-fulltext / sec-xbrl. */

const SEC_UA = 'dsh-market-info/0.9 (contact@example.com)'
const SEC_HEADERS = { 'user-agent': SEC_UA, accept: 'application/json' }

function clampLimit(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(60, Math.max(1, Math.floor(n)))
}

function dayString(date) {
  return date.toISOString().slice(0, 10)
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000)
}

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : ''
}

function toMs(value) {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : null
}

function secArchiveUrl(cik, accession, filename) {
  const numeric = Number(cik)
  const entity = Number.isFinite(numeric) && numeric > 0 ? String(numeric) : String(cik || '').replace(/^0+/, '')
  const noDashes = String(accession || '').replace(/-/g, '')
  if (!entity || !noDashes) return 'https://www.sec.gov/edgar/search/'
  const base = 'https://www.sec.gov/Archives/edgar/data/' + entity + '/' + noDashes + '/'
  return filename ? base + filename : base
}

function cleanDisplayName(value) {
  return String(value || '')
    .replace(/\s*\(CIK\s+\d+\)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function compactUsd(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  const abs = Math.abs(n)
  if (abs >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T'
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K'
  return '$' + n.toFixed(2)
}

/** Last completed quarters, newest first: 2026-11 -> CY2026Q3, CY2026Q2 ... */
function recentQuarters(now, count) {
  let year = now.getUTCFullYear()
  let quarter = Math.floor(now.getUTCMonth() / 3) + 1
  quarter -= 1
  if (quarter < 1) {
    quarter = 4
    year -= 1
  }
  const out = []
  for (let index = 0; index < count; index += 1) {
    out.push('CY' + year + 'Q' + quarter)
    quarter -= 1
    if (quarter < 1) {
      quarter = 4
      year -= 1
    }
  }
  return out
}

const secFulltext = {
  id: 'sec-fulltext',
  name: 'SEC 全文检索',
  category: 'filing',
  region: 'US',
  tier: 'A',
  capability: ['search', 'list'],
  homepage: 'https://efts.sec.gov/LATEST/search-index',
  note: 'EDGAR 全文检索（默认近 30 天 8-K）；需带联系邮箱的自定义 UA，限速 10 次/秒。',
  needsKey: false,
  rateLimit: { perMinute: 30 },
  ttlMs: 20 * 60 * 1000,
  timeoutMs: 10000,
  async fetch(ctx, params) {
    try {
      const p = params || {}
      const limit = clampLimit(p.limit, 20)
      const query = String(p.q || '').trim()
      const to = isoDate(p.to) || dayString(new Date())
      const from = isoDate(p.from) || dayString(addDays(new Date(to + 'T00:00:00Z'), -30))
      const search = [
        'q=' + encodeURIComponent(query),
        'forms=' + encodeURIComponent('8-K'),
      ]
      if (p.from || p.to) search.push('dateRange=custom', 'startdt=' + from, 'enddt=' + to)
      const url = 'https://efts.sec.gov/LATEST/search-index?' + search.join('&')
      const res = await ctx.getJson(url, { headers: SEC_HEADERS, timeoutMs: 8000 })
      if (!res.ok || !res.json) return { items: [], meta: { error: (res && res.error) || ('http ' + (res && res.status)), url } }
      const json = res.json
      if (json.error) return { items: [], meta: { error: String(json.error), url } }
      const hits = json.hits || {}
      const rows = Array.isArray(hits.hits) ? hits.hits : []
      const items = []
      for (const row of rows) {
        const source = row._source || {}
        const id = String(row._id || '')
        const split = id.split(':')
        const accession = String(source.adsh || split[0] || '')
        const filename = split.length > 1 ? split.slice(1).join(':') : ''
        const ciks = Array.isArray(source.ciks) ? source.ciks : []
        const forms = Array.isArray(source.root_forms) ? source.root_forms : []
        const form = String(source.form || forms[0] || '')
        const fileItems = Array.isArray(source.items) ? source.items : []
        const tags = []
        for (const tag of [form].concat(fileItems.slice(0, 4))) {
          if (tag && !tags.includes(String(tag))) tags.push(String(tag))
        }
        const parts = [source.file_description, fileItems.length ? 'Items ' + fileItems.join(', ') : '']
        const fileType = String(source.file_type || '')
        const titleParts = [cleanDisplayName((source.display_names || [])[0]) || 'SEC filing', form]
        if (fileType && fileType !== form && fileType !== form + '/A') titleParts.push(fileType)
        items.push({
          id: id || secArchiveUrl(ciks[0], accession, filename),
          title: titleParts.filter(Boolean).join(' · '),
          url: secArchiveUrl(ciks[0], accession, filename),
          publishedAt: toMs(source.file_date),
          summary: parts.filter(Boolean).join(' · '),
          tags: tags,
          payload: {
            cik: ciks[0] || '',
            accession: accession,
            form: form,
            fileType: source.file_type || '',
            fileDescription: source.file_description || '',
            items: fileItems,
            periodEnding: source.period_ending || '',
            fileNum: Array.isArray(source.file_num) ? source.file_num[0] || '' : '',
          },
        })
      }
      items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
      return {
        items: items.slice(0, limit),
        meta: { total: (hits.total && hits.total.value) || rows.length, query: query, form: '8-K' },
      }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

const secXbrl = {
  id: 'sec-xbrl',
  name: 'SEC XBRL 财报',
  category: 'filing',
  region: 'US',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://data.sec.gov/api/xbrl/frames/us-gaap/',
  note: 'SEC XBRL frames：某科目某季度营收前 N 家公司；params.symbol 可换 concept（默认 Revenues）。',
  needsKey: false,
  rateLimit: { perMinute: 30 },
  ttlMs: 30 * 60 * 1000,
  timeoutMs: 10000,
  async fetch(ctx, params) {
    try {
      const p = params || {}
      const concept = /^[A-Za-z][A-Za-z0-9]{1,40}$/.test(String(p.symbol || '')) ? String(p.symbol) : 'Revenues'
      const explicit = String(p.period || '').trim().toUpperCase()
      const periods = /^CY\d{4}(Q[1-4])?$/.test(explicit) ? [explicit] : recentQuarters(new Date(), 4)
      const limit = Math.min(clampLimit(p.limit, 20), 30)
      let lastError = ''
      for (const period of periods) {
        const url = 'https://data.sec.gov/api/xbrl/frames/us-gaap/' + concept + '/USD/' + period + '.json'
        const res = await ctx.getJson(url, { headers: SEC_HEADERS, timeoutMs: 7500 })
        const json = res && res.json
        if (!res || !res.ok || !json || !Array.isArray(json.data) || json.data.length === 0) {
          lastError = (res && res.error) || ('http ' + (res && res.status)) || 'empty frame'
          continue
        }
        const rows = json.data.slice().sort((a, b) => Number(b.val) - Number(a.val))
        const items = rows.slice(0, limit).map((row) => {
          const cik = Number(row.cik) || row.cik
          const accn = String(row.accn || '')
          const value = Number(row.val)
          const money = compactUsd(value)
          const range = [row.start, row.end].filter(Boolean).join(' ~ ')
          return {
            id: concept + ':' + period + ':' + row.cik + ':' + accn,
            title: (row.entityName || 'CIK ' + cik) + ' · ' + period + ' ' + concept + '：' + money,
            url: secArchiveUrl(cik, accn, ''),
            publishedAt: toMs(row.end),
            summary: ['CIK ' + cik, range, row.loc || '', '值 ' + money].filter(Boolean).join(' · '),
            tags: [concept, period, 'XBRL'],
            payload: {
              cik: cik,
              entityName: row.entityName || '',
              concept: concept,
              period: period,
              value: Number.isFinite(value) ? value : null,
              uom: json.uom || 'USD',
              start: row.start || '',
              end: row.end || '',
              accn: accn,
              location: row.loc || '',
            },
          }
        })
        return {
          items: items,
          meta: { concept: concept, period: period, total: rows.length, label: json.label || '' },
        }
      }
      return { items: [], meta: { error: lastError || 'no frame data', concept: concept } }
    } catch (error) {
      return { items: [], meta: { error: String(error && error.message ? error.message : error) } }
    }
  },
}

export const adapters = [secFulltext, secXbrl]
