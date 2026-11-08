/**
 * Market structure: cross-border flows (沪深港通), margin financing (融资融券),
 * the daily billboard (龙虎榜) and sector rotation (行业/概念板块).
 *
 * All four read Eastmoney's public web endpoints — the same anonymous endpoints the
 * quote pages call. No login, no entitlement replay.
 *
 * Two of them need a date: the exchange publishes 两融 and 龙虎榜 per trading day, so
 * the adapter walks back over recent weekdays and stops at the first day with rows.
 */

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json, text/javascript, */*',
}
const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'
const DATA_REF = { referer: 'https://data.eastmoney.com/' }
const QUOTE_REF = { referer: 'https://quote.eastmoney.com/' }

function limitOf(params, fallback) {
  const n = Number(params && params.limit)
  return Math.min(Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback, 60)
}

/** CN-local "today" as a Date whose UTC fields carry the CN calendar date. */
function cnNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000)
}

function ymd(date) {
  return date.toISOString().slice(0, 10)
}

/** The last `count` weekdays (CN calendar), newest first. */
function recentWeekdays(count) {
  const out = []
  let cursor = cnNow()
  while (out.length < count) {
    const dow = cursor.getUTCDay()
    if (dow !== 0 && dow !== 6) out.push(ymd(cursor))
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000)
  }
  return out
}

function cnTime(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(raw || ''))
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0) - 8, Number(m[5] || 0), Number(m[6] || 0))
}

/** Shanghai is 1.code, Shenzhen/Beijing 0.code in Eastmoney's secid scheme. */
function secid(code) {
  const c = String(code || '')
  if (/^(6|9)/.test(c)) return '1.' + c
  return '0.' + c
}

/** 1.23e8 -> "1.23亿"; small values -> "1234万". */
function humanMoney(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (abs >= 1e4) return (n / 1e4).toFixed(2) + '万'
  return n.toFixed(0)
}

function signed(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return (n >= 0 ? '+' : '') + humanMoney(n)
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------- 沪深港通

const HSGT_LABEL = {
  '001': '沪股通',
  '002': '港股通(沪)',
  '003': '深股通',
  '004': '港股通(深)',
}

const hsgt = {
  id: 'hsgt',
  name: '沪深港通十大成交',
  category: 'flow',
  region: 'CN',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://data.eastmoney.com/hsgt/top10.html',
  note: '北向/南向每日十大成交股，含净买入与成交额（东财公开数据接口）',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 12000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 40)
    const url =
      DC + '?reportName=RPT_MUTUAL_TOP10DEAL&columns=ALL&sortColumns=TRADE_DATE,NET_BUY_AMT' +
      '&sortTypes=-1,-1&pageNumber=1&pageSize=' + limit + '&source=WEB&client=WEB'
    const res = await ctx.getJson(url, { headers: BROWSER, ...DATA_REF, timeoutMs: 9000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const rows = res.json && res.json.result && res.json.result.data
    if (!Array.isArray(rows)) return { items: [], meta: { error: 'unexpected payload shape' } }
    const items = []
    const seen = new Set()
    for (const row of rows) {
      const type = String(row.MUTUAL_TYPE || '')
      const label = HSGT_LABEL[type] || type
      const key = type + ':' + row.SECURITY_CODE + ':' + String(row.TRADE_DATE || '').slice(0, 10)
      if (seen.has(key)) continue
      seen.add(key)
      const net = num(row.NET_BUY_AMT)
      items.push({
        id: 'hsgt:' + key,
        title: '【' + label + '】' + String(row.SECURITY_NAME || '').replace(/\s+/g, '') + ' 净买入 ' + signed(net),
        url: 'https://data.eastmoney.com/hsgt/top10.html',
        publishedAt: cnTime(row.TRADE_DATE),
        summary:
          '成交 ' + humanMoney(row.DEAL_AMT) + ' · 买入 ' + humanMoney(row.BUY_AMT) + ' / 卖出 ' + humanMoney(row.SELL_AMT) +
          (num(row.CHANGE_RATE) === null ? '' : ' · 涨跌 ' + Number(row.CHANGE_RATE).toFixed(2) + '%'),
        tags: ['沪深港通', label, String(row.SECURITY_CODE || '')],
        payload: {
          type: type,
          label: label,
          code: String(row.SECURITY_CODE || ''),
          name: String(row.SECURITY_NAME || '').replace(/\s+/g, ''),
          netBuy: net,
          buyAmt: num(row.BUY_AMT),
          sellAmt: num(row.SELL_AMT),
          dealAmt: num(row.DEAL_AMT),
          changePct: num(row.CHANGE_RATE),
          rank: num(row.RANK),
        },
      })
      if (items.length >= limit) break
    }
    return { items, meta: { total: items.length, endpoint: 'RPT_MUTUAL_TOP10DEAL' } }
  },
}

// ---------------------------------------------------------------- 融资融券

const margin = {
  id: 'margin',
  name: '融资融券余额榜',
  category: 'flow',
  region: 'CN',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://data.eastmoney.com/rzrq/',
  note: '按融资余额排序的两融明细；日期自动回溯最近交易日',
  needsKey: false,
  rateLimit: { perMinute: 15 },
  timeoutMs: 15000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 30)
    const days = recentWeekdays(4)
    let lastError = ''
    for (const day of days) {
      const url =
        DC + '?reportName=RPTA_WEB_RZRQ_GGMX&columns=ALL&sortColumns=RZYE&sortTypes=-1&pageNumber=1' +
        '&pageSize=' + limit + '&source=WEB&client=WEB&filter=' + encodeURIComponent("(DATE='" + day + "')")
      const res = await ctx.getJson(url, { headers: BROWSER, ...DATA_REF, timeoutMs: 9000 })
      if (!res.ok || !res.json) {
        lastError = 'http ' + (res.status || res.error)
        continue
      }
      const rows = res.json && res.json.result && res.json.result.data
      if (!Array.isArray(rows) || rows.length === 0) continue
      const items = []
      for (const row of rows.slice(0, limit)) {
        const code = String(row.SCODE || '')
        const name = String(row.SECNAME || '').replace(/\s+/g, '')
        const rzye = num(row.RZYE)
        const jme = num(row.RZJME)
        items.push({
          id: 'margin:' + day + ':' + code,
          title: name + '（' + code + '）融资余额 ' + humanMoney(rzye),
          url: 'https://data.eastmoney.com/rzrq/',
          publishedAt: cnTime(row.DATE),
          summary:
            '融资净买 ' + signed(jme) + ' · 买入 ' + humanMoney(row.RZMRE) + ' / 偿还 ' + humanMoney(row.RZCHE) +
            (num(row.RZYEZB) === null ? '' : ' · 占流通市值 ' + Number(row.RZYEZB).toFixed(2) + '%'),
          tags: ['两融', String(row.MARKET || ''), code],
          payload: {
            code: code,
            name: name,
            date: day,
            market: String(row.MARKET || ''),
            financingBalance: rzye,
            financingNetBuy: jme,
            financingBuy: num(row.RZMRE),
            financingRepay: num(row.RZCHE),
            shortBalance: num(row.RQYE),
            balancePct: num(row.RZYEZB),
          },
        })
      }
      return { items, meta: { total: items.length, date: day, endpoint: 'RPTA_WEB_RZRQ_GGMX' } }
    }
    return { items: [], meta: { error: lastError || 'no recent trading day with data', tried: days.join(',') } }
  },
}

// ---------------------------------------------------------------- 龙虎榜

const lhb = {
  id: 'lhb',
  name: '龙虎榜',
  category: 'flow',
  region: 'CN',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://data.eastmoney.com/stock/lhb.html',
  note: '每日龙虎榜明细：上榜原因、买卖总额与净额',
  needsKey: false,
  rateLimit: { perMinute: 15 },
  timeoutMs: 15000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 30)
    const url =
      DC + '?reportName=RPT_BILLBOARD_DAILYDETAILS&columns=ALL&sortColumns=TRADE_DATE,TOTAL_NET' +
      '&sortTypes=-1,-1&pageNumber=1&pageSize=' + limit + '&source=WEB&client=WEB'
    const res = await ctx.getJson(url, { headers: BROWSER, ...DATA_REF, timeoutMs: 9000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const rows = res.json && res.json.result && res.json.result.data
    if (!Array.isArray(rows)) return { items: [], meta: { error: 'unexpected payload shape' } }
    const items = []
    for (const row of rows.slice(0, limit)) {
      const code = String(row.SECURITY_CODE || '')
      const name = String(row.SECURITY_NAME_ABBR || '').replace(/\s+/g, '')
      const net = num(row.TOTAL_NET)
      items.push({
        id: 'lhb:' + String(row.TRADE_ID || '') + ':' + code + ':' + String(row.TRADE_DATE || '').slice(0, 10),
        title: name + '（' + code + '）龙虎榜 净额 ' + signed(net),
        url: 'https://data.eastmoney.com/stock/lhb.html',
        publishedAt: cnTime(row.TRADE_DATE),
        summary:
          String(row.EXPLANATION || '').slice(0, 120) +
          (num(row.CHANGE_RATE) === null ? '' : ' · 涨跌 ' + Number(row.CHANGE_RATE).toFixed(2) + '%'),
        tags: ['龙虎榜', code],
        payload: {
          code: code,
          name: name,
          net: net,
          buy: num(row.TOTAL_BUY),
          sell: num(row.TOTAL_SELL),
          amount: num(row.ACCUM_AMOUNT),
          changePct: num(row.CHANGE_RATE),
          explanation: String(row.EXPLANATION || ''),
        },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'RPT_BILLBOARD_DAILYDETAILS' } }
  },
}

// ---------------------------------------------------------------- 板块轮动

const sector = {
  id: 'sector',
  name: '行业板块轮动',
  category: 'industry',
  region: 'CN',
  tier: 'A',
  capability: ['list'],
  homepage: 'https://data.eastmoney.com/bkzj/hy.html',
  note: '行业/概念板块涨跌幅与主力净流入；params.type=concept 切概念板块',
  needsKey: false,
  rateLimit: { perMinute: 30 },
  timeoutMs: 10000,
  async fetch(ctx, params) {
    const limit = limitOf(params, 30)
    const type = String((params && params.type) || 'industry') === 'concept' ? '3' : '2'
    const url =
      CLIST + '?pn=1&pz=' + limit + '&po=1&np=1&fltt=2&invt=2&fid=f3' +
      '&fs=m:90+t:' + type + '&fields=f12,f14,f3,f62,f104,f105,f184'
    const res = await ctx.getJson(url, { headers: BROWSER, ...QUOTE_REF, timeoutMs: 8000 })
    if (!res.ok || !res.json) return { items: [], meta: { error: 'http ' + (res.status || res.error) } }
    const rows = res.json && res.json.data && res.json.data.diff
    if (!Array.isArray(rows)) return { items: [], meta: { error: 'unexpected payload shape' } }
    const label = type === '3' ? '概念板块' : '行业板块'
    const items = []
    for (const row of rows.slice(0, limit)) {
      const change = num(row.f3)
      const net = num(row.f62)
      items.push({
        id: 'sector:' + String(row.f12 || ''),
        title: String(row.f14 || '') + ' ' + (change === null ? '—' : (change >= 0 ? '+' : '') + change.toFixed(2) + '%') +
          ' 主力净流入 ' + signed(net),
        url: type === '3' ? 'https://data.eastmoney.com/bkzj/gn.html' : 'https://data.eastmoney.com/bkzj/hy.html',
        publishedAt: Date.now(),
        summary:
          '涨 ' + (row.f104 === undefined ? '—' : String(row.f104)) + ' / 跌 ' + (row.f105 === undefined ? '—' : String(row.f105)) +
          (num(row.f184) === null ? '' : ' · 净占比 ' + Number(row.f184).toFixed(2) + '%'),
        tags: ['板块', label, String(row.f12 || '')],
        payload: {
          boardCode: String(row.f12 || ''),
          name: String(row.f14 || ''),
          changePct: change,
          mainNetInflow: net,
          upCount: num(row.f104),
          downCount: num(row.f105),
          netRatio: num(row.f184),
          kind: type === '3' ? 'concept' : 'industry',
        },
      })
    }
    return { items, meta: { total: items.length, kind: label, endpoint: 'clist m:90' } }
  },
}

export const adapters = [hsgt, margin, lhb, sector]
export { secid, humanMoney, signed, recentWeekdays, CLIST, BROWSER, QUOTE_REF }

