/**
 * Bonds: convertible bond issuance (a real financing channel for A-shares and a
 * distinct asset class for readers). Eastmoney public datacenter report.
 */

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json, text/javascript, */*',
}

const REPORT =
  'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BOND_CB_LIST' +
  '&columns=ALL&pageSize=30&sortColumns=PUBLIC_START_DATE&sortTypes=-1&source=WEB&client=WEB'

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const cb = {
  id: 'cb-issue',
  name: '可转债',
  category: 'bond',
  region: 'CN',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://data.eastmoney.com/kzz/',
  note: '可转债发行：债项评级、发行规模、转股价（东财数据中心）',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 14000,
  async fetch(ctx, params) {
    const limit = Math.min(Number(params && params.limit) || 20, 40)
    const res = await ctx.getJson(REPORT, { headers: BROWSER, timeoutMs: 12000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const data = res.json && res.json.result && res.json.result.data
    if (!Array.isArray(data) || !data.length) return { items: [], meta: { error: 'empty report' } }
    const items = []
    for (const row of data.slice(0, limit)) {
      const name = String(row.SECURITY_NAME_ABBR || '')
      const code = String(row.SECURITY_CODE || '')
      const scale = num(row.ACTUAL_ISSUE_SCALE)
      const start = String(row.PUBLIC_START_DATE || '').slice(0, 10)
      items.push({
        id: 'cb:' + code,
        title: name + '(' + code + ') 发行 ' + (scale === null ? '—' : scale.toFixed(2)) + ' 亿元',
        url: 'https://data.eastmoney.com/kzz/detail/' + code + '.html',
        publishedAt: Number.isFinite(Date.parse(start + 'T00:00:00Z')) ? Date.parse(start + 'T00:00:00Z') : null,
        summary:
          '评级 ' + String(row.RATING || '—') +
          ' · 发行价 ' + (num(row.ISSUE_PRICE) === null ? '—' : num(row.ISSUE_PRICE).toFixed(2)) +
          ' · 期限 ' + (num(row.BOND_EXPIRE) === null ? '—' : num(row.BOND_EXPIRE) + ' 年') +
          ' · 正股 ' + String(row.CONVERT_STOCK_CODE || '—') +
          ' · 起息 ' + String(row.VALUE_DATE || '').slice(0, 10),
        tags: ['债券', '可转债', name],
        payload: { code: code, rating: row.RATING || '', scaleYi: scale },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'RPT_BOND_CB_LIST' } }
  },
}

export const adapters = [cb]
