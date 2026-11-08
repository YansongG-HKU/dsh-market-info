/**
 * Rates: China and US sovereign yield curve from Eastmoney's public
 * "中美国债收益率" report (RPTA_WEB_TREASURYYIELD).
 *
 * Column order in that report is fixed and maps to the page legend:
 *   EMM00588704 中国1年   EMM00166462 中国2年   EMM00166466 中国5年   EMM00166469 中国10年
 *   EMG00001306 美国2年   EMG00001308 美国5年   EMG00001310 美国10年  EMG00001312 美国30年
 * Values are returned verbatim in payload.raw so a reader can check them against the page.
 */

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json, text/javascript, */*',
}

const REPORT =
  'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD' +
  '&columns=ALL&pageSize=2&sortColumns=SOLAR_DATE&sortTypes=-1&source=WEB&client=WEB'

const SERIES = [
  { column: 'EMM00588704', side: 'CN', tenor: '1年', label: '中国 1 年期国债' },
  { column: 'EMM00166462', side: 'CN', tenor: '2年', label: '中国 2 年期国债' },
  { column: 'EMM00166466', side: 'CN', tenor: '5年', label: '中国 5 年期国债' },
  { column: 'EMM00166469', side: 'CN', tenor: '10年', label: '中国 10 年期国债' },
  { column: 'EMG00001306', side: 'US', tenor: '2年', label: '美国 2 年期国债' },
  { column: 'EMG00001308', side: 'US', tenor: '5年', label: '美国 5 年期国债' },
  { column: 'EMG00001310', side: 'US', tenor: '10年', label: '美国 10 年期国债' },
  { column: 'EMG00001312', side: 'US', tenor: '30年', label: '美国 30 年期国债' },
]

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function bp(value) {
  const n = num(value)
  if (n === null) return '—'
  return (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + 'bp'
}

export const adapters = [
  {
    id: 'treasury-curve',
    name: '中美国债收益率曲线',
    category: 'rates',
    region: 'GLOBAL',
    tier: 'A',
    capability: ['list'],
    homepage: 'https://data.eastmoney.com/cjsj/globalbondyield.html',
    note: '中国 1/2/5/10 年、美国 2/5/10/30 年国债收益率；列序与东财页面图例一致，原始值见 payload.raw',
    needsKey: false,
    rateLimit: { perMinute: 20 },
    timeoutMs: 14000,
    async fetch(ctx, params) {
      const res = await ctx.getJson(REPORT, { headers: BROWSER, timeoutMs: 12000 })
      if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
      const rows = res.json && res.json.result && Array.isArray(res.json.result.data) ? res.json.result.data : []
      if (!rows.length) return { items: [], meta: { error: 'no curve rows' } }
      const today = rows[0]
      const prev = rows[1] || null
      const dateText = String(today.SOLAR_DATE || '').slice(0, 10)
      const items = []
      for (const series of SERIES) {
        const value = num(today[series.column])
        if (value === null) continue
        const before = prev ? num(prev[series.column]) : null
        const delta = before === null ? null : value - before
        items.push({
          id: 'rates:' + series.side + series.tenor,
          title: series.label + ' ' + value.toFixed(4) + '%' + (delta === null ? '' : '  ' + bp(delta)),
          url: 'https://data.eastmoney.com/cjsj/globalbondyield.html',
          publishedAt: Date.parse(dateText + 'T00:00:00Z'),
          summary:
            (series.side === 'CN' ? '中国' : '美国') + ' ' + series.tenor + ' 期收益率 ' + value.toFixed(4) + '%' +
            (before === null ? '' : ' · 前一交易日 ' + before.toFixed(4) + '%（' + bp(delta) + '）') +
            ' · 数据日 ' + dateText,
          tags: ['利率', series.side === 'CN' ? '中国' : '美国', series.tenor],
          payload: { side: series.side, tenor: series.tenor, value: value, prev: before, raw: today[series.column] },
        })
      }
      // Curve shape is the part traders actually read: 10y-2y and CN-US spread.
      const cn10 = num(today.EMM00166469)
      const cn2 = num(today.EMM00166462)
      const us10 = num(today.EMG00001310)
      const us2 = num(today.EMG00001306)
      if (cn10 !== null && cn2 !== null) {
        items.push({
          id: 'rates:cn-10y2y',
          title: '中国国债 10Y-2Y 期限利差 ' + bp(cn10 - cn2),
          url: 'https://data.eastmoney.com/cjsj/globalbondyield.html',
          publishedAt: Date.parse(dateText + 'T00:00:00Z'),
          summary: '中国 10 年 ' + cn10.toFixed(4) + '% − 2 年 ' + cn2.toFixed(4) + '%；正值陡峭，负值倒挂',
          tags: ['利率', '利差', '中国'],
          payload: { spread: cn10 - cn2 },
        })
      }
      if (us10 !== null && us2 !== null) {
        items.push({
          id: 'rates:us-10y2y',
          title: '美国国债 10Y-2Y 期限利差 ' + bp(us10 - us2),
          url: 'https://data.eastmoney.com/cjsj/globalbondyield.html',
          publishedAt: Date.parse(dateText + 'T00:00:00Z'),
          summary: '美国 10 年 ' + us10.toFixed(4) + '% − 2 年 ' + us2.toFixed(4) + '%；负值即倒挂（衰退信号）',
          tags: ['利率', '利差', '美国'],
          payload: { spread: us10 - us2 },
        })
      }
      if (cn10 !== null && us10 !== null) {
        items.push({
          id: 'rates:cn-us-10y',
          title: '中美 10 年期利差 ' + bp(us10 - cn10),
          url: 'https://data.eastmoney.com/cjsj/globalbondyield.html',
          publishedAt: Date.parse(dateText + 'T00:00:00Z'),
          summary: '美国 10 年 ' + us10.toFixed(4) + '% − 中国 10 年 ' + cn10.toFixed(4) + '%；影响汇率与跨境资金',
          tags: ['利率', '利差', '跨境'],
          payload: { spread: us10 - cn10 },
        })
      }
      return { items, meta: { total: items.length, date: dateText, endpoint: 'RPTA_WEB_TREASURYYIELD' } }
    },
  },
]
