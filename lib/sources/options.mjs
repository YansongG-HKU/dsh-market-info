/**
 * Options: ETF option board plus a put/call ratio computed from traded turnover.
 * Eastmoney push2 clist (market m:10 = 期权).
 */

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json, text/javascript, */*',
}

const LIST =
  'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f6&fs=m:10' +
  '&fields=f2,f3,f6,f12,f14'

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function yi(value) {
  const n = num(value)
  if (n === null) return '—'
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + ' 万'
  return n.toFixed(0)
}

/** "500ETF沽11月6750" -> put; "500ETF购11月6750" -> call. */
function sideOf(name) {
  if (name.indexOf('沽') >= 0) return 'put'
  if (name.indexOf('购') >= 0) return 'call'
  return 'other'
}

export const adapters = [
  {
    id: 'option-board',
    name: '期权成交榜',
    category: 'options',
    region: 'CN',
    tier: 'A',
    capability: ['list'],
    homepage: 'https://quote.eastmoney.com/center/gridlist.html#options',
    note: 'ETF 期权按成交额排序，并计算认沽/认购成交额比（PCR）',
    needsKey: false,
    rateLimit: { perMinute: 60 },
    timeoutMs: 14000,
    async fetch(ctx, params) {
      const limit = Math.min(Number(params && params.limit) || 20, 40)
      const res = await ctx.getJson(LIST, { headers: BROWSER, timeoutMs: 12000 })
      if (!res.ok || !res.json || !res.json.data || !Array.isArray(res.json.data.diff)) {
        return { items: [], meta: { error: 'http ' + (res.status || 'no data') } }
      }
      const rows = res.json.data.diff
      let putAmount = 0
      let callAmount = 0
      for (const row of rows) {
        const amount = num(row.f6) || 0
        const side = sideOf(String(row.f14 || ''))
        if (side === 'put') putAmount += amount
        if (side === 'call') callAmount += amount
      }
      const items = []
      const pcr = callAmount > 0 ? putAmount / callAmount : null
      if (pcr !== null) {
        items.push({
          id: 'options:pcr',
          title: '期权 PCR（认沽/认购成交额） ' + pcr.toFixed(3),
          url: 'https://quote.eastmoney.com/center/gridlist.html#options',
          publishedAt: Date.now(),
          summary:
            '认沽成交额 ' + yi(putAmount) + ' / 认购成交额 ' + yi(callAmount) +
            ' · 样本 ' + rows.length + ' 个合约 · PCR 走高通常意味着避险需求升温',
          tags: ['期权', 'PCR', '情绪'],
          payload: { pcr: pcr, putAmount: putAmount, callAmount: callAmount, sample: rows.length },
        })
      }
      for (const row of rows.slice(0, limit)) {
        const name = String(row.f14 || '')
        const code = String(row.f12 || '')
        const last = num(row.f2)
        const pct = num(row.f3)
        const amount = num(row.f6)
        if (last === null) continue
        items.push({
          id: 'option:' + code,
          title: name + ' ' + last.toFixed(4) + (pct === null ? '' : '  ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'),
          url: 'https://quote.eastmoney.com/center/gridlist.html#options',
          publishedAt: Date.now(),
          summary:
            '成交额 ' + yi(amount) + ' · ' + (sideOf(name) === 'put' ? '认沽' : sideOf(name) === 'call' ? '认购' : '期权') +
            ' · 合约 ' + code + ' · 东财延迟报价',
          tags: ['期权', sideOf(name) === 'put' ? '认沽' : '认购', name.slice(0, 6)],
          payload: { code: code, last: last, pct: pct, amount: amount },
        })
      }
      return { items, meta: { total: items.length, endpoint: 'push2/options', putAmount: putAmount, callAmount: callAmount } }
    },
  },
]
