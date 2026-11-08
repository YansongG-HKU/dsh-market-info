/**
 * FX: dollar index, offshore/onshore RMB and the majors, from Eastmoney's
 * public quote endpoints (push2). Prices are integers scaled by 10^scale.
 */

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json, text/javascript, */*',
}

const INSTRUMENTS = [
  { secid: '100.UDI', name: '美元指数', scale: 100, digits: 2, pair: 'DXY' },
  { secid: '133.USDCNH', name: '美元兑离岸人民币', scale: 10000, digits: 4, pair: 'USDCNH' },
  { secid: '119.EURUSD', name: '欧元兑美元', scale: 10000, digits: 4, pair: 'EURUSD' },
  { secid: '119.USDJPY', name: '美元兑日元', scale: 10000, digits: 4, pair: 'USDJPY' },
  { secid: '119.GBPUSD', name: '英镑兑美元', scale: 10000, digits: 4, pair: 'GBPUSD' },
  { secid: '119.AUDUSD', name: '澳元兑美元', scale: 10000, digits: 4, pair: 'AUDUSD' },
  { secid: '119.USDCHF', name: '美元兑瑞郎', scale: 10000, digits: 4, pair: 'USDCHF' },
]

function price(value, instrument) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return n / instrument.scale
}

export const adapters = [
  {
    id: 'fx-major',
    name: '主要汇率',
    category: 'fx',
    region: 'GLOBAL',
    tier: 'A',
    capability: ['list'],
    homepage: 'https://quote.eastmoney.com/center/gridlist.html#foreign_exchange',
    note: '美元指数、离岸人民币与六个主要货币对（东财快照，延迟报价）',
    needsKey: false,
    rateLimit: { perMinute: 60 },
    timeoutMs: 12000,
    async fetch(ctx) {
      const url =
        'https://push2.eastmoney.com/api/qt/stock/get?secid=0&fields=f43,f57,f58,f60,f169,f170'
      // One request per instrument: push2 has no multi-secids GET form for this shape,
      // and seven small requests finish well inside the budget.
      const rows = await Promise.all(
        INSTRUMENTS.map(async (instrument) => {
          const u = url.replace('secid=0', 'secid=' + encodeURIComponent(instrument.secid))
          const res = await ctx.getJson(u, { headers: BROWSER, timeoutMs: 9000 })
          if (!res.ok || !res.json || !res.json.data) return null
          return { instrument, data: res.json.data }
        }),
      )
      const items = []
      for (const row of rows) {
        if (!row) continue
        const { instrument, data } = row
        const last = price(data.f43, instrument)
        if (last === null) continue
        const prev = price(data.f60, instrument)
        const change = Number(data.f169) / instrument.scale
        const pct = Number(data.f170) / 100
        const up = Number.isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%' : ''
        items.push({
          id: 'fx:' + instrument.pair,
          title: instrument.name + ' ' + last.toFixed(instrument.digits) + (up ? '  ' + up : ''),
          url: 'https://quote.eastmoney.com/center/gridlist.html#foreign_exchange',
          publishedAt: Date.now(),
          summary:
            instrument.pair + ' · 最新 ' + last.toFixed(instrument.digits) +
            (prev === null ? '' : ' · 前收 ' + prev.toFixed(instrument.digits)) +
            (Number.isFinite(change) ? ' · 涨跌 ' + change.toFixed(instrument.digits) : '') +
            ' · 东财延迟报价',
          tags: ['外汇', instrument.pair],
          payload: { pair: instrument.pair, last: last, prev: prev, change: change, pct: Number.isFinite(pct) ? pct : null },
        })
      }
      if (!items.length) return { items: [], meta: { error: 'no fx quotes' } }
      return { items, meta: { total: items.length, endpoint: 'eastmoney/push2-fx' } }
    },
  },
]
