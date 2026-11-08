/**
 * Money-market rates: the exchange repo (逆回购) curve.
 *
 * SHIBOR is published behind a container-config-only endpoint (no numbers), but
 * the repo rates are the price money actually trades at — and they are quoted by
 * Eastmoney like any other security, so this is both more useful and more reliable.
 *
 * f43 is in units of 1/1000 % (1185 -> 1.185%), f170 is the change in 1/100 %.
 */

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json, text/javascript, */*',
}

const INSTRUMENTS = [
  { secid: '0.131810', code: 'R-001', name: '深市 1 天逆回购', tenor: '1天' },
  { secid: '1.204001', code: 'GC001', name: '沪市 1 天逆回购', tenor: '1天' },
  { secid: '1.204002', code: 'GC002', name: '沪市 2 天逆回购', tenor: '2天' },
  { secid: '1.204007', code: 'GC007', name: '沪市 7 天逆回购', tenor: '7天' },
  { secid: '1.204028', code: 'GC028', name: '沪市 28 天逆回购', tenor: '28天' },
  { secid: '0.131811', code: 'R-002', name: '深市 2 天逆回购', tenor: '2天' },
]

function rate(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n / 1000 : null
}

export const adapters = [
  {
    id: 'repo-rates',
    name: '交易所回购利率',
    category: 'money',
    region: 'CN',
    tier: 'A',
    capability: ['list'],
    homepage: 'https://quote.eastmoney.com/center/gridlist.html#bond_cn',
    note: '沪市 GC001/002/007/028 与深市 R-001/002 逆回购年化利率；资金面松紧的直接价格',
    needsKey: false,
    rateLimit: { perMinute: 60 },
    timeoutMs: 12000,
    async fetch(ctx) {
      const template = 'https://push2.eastmoney.com/api/qt/stock/get?secid=0&fields=f43,f57,f58,f60,f169,f170,f86'
      const rows = await Promise.all(
        INSTRUMENTS.map(async (instrument) => {
          const url = template.replace('secid=0', 'secid=' + encodeURIComponent(instrument.secid))
          const res = await ctx.getJson(url, { headers: BROWSER, timeoutMs: 9000 })
          if (!res.ok || !res.json || !res.json.data) return null
          return { instrument, data: res.json.data }
        }),
      )
      const items = []
      for (const row of rows) {
        if (!row) continue
        const { instrument, data } = row
        const last = rate(data.f43)
        if (last === null) continue
        const prev = rate(data.f60)
        const change = Number(data.f169) / 1000
        const pct = Number(data.f170) / 100
        const up = Number.isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%' : ''
        const stamp = Number(data.f86) ? Number(data.f86) * 1000 : Date.now()
        items.push({
          id: 'money:' + instrument.code,
          title: instrument.name + ' ' + last.toFixed(3) + '%' + (up ? '  ' + up : ''),
          url: 'https://quote.eastmoney.com/center/gridlist.html#bond_cn',
          publishedAt: stamp,
          summary:
            instrument.code + ' · 年化 ' + last.toFixed(3) + '%' +
            (prev === null ? '' : ' · 前收 ' + prev.toFixed(3) + '%') +
            (Number.isFinite(change) ? ' · 涨跌 ' + change.toFixed(3) + 'pct' : '') +
            ' · 期限 ' + instrument.tenor + ' · 东财延迟报价',
          tags: ['资金利率', '逆回购', instrument.code, instrument.tenor],
          payload: { code: instrument.code, tenor: instrument.tenor, rate: last, prev: prev, pct: Number.isFinite(pct) ? pct : null },
        })
      }
      if (!items.length) return { items: [], meta: { error: 'no repo quotes' } }
      return { items, meta: { total: items.length, endpoint: 'eastmoney/push2-repo' } }
    },
  },
]
