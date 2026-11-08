/**
 * Corporate actions: dividends, lock-up expiries, block trades, shareholder
 * changes and earnings pre-announcements — the disclosures that actually move
 * individual names. All from Eastmoney's public datacenter reports.
 */

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json, text/javascript, */*',
}

function report(name, sort, size) {
  return (
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=' + name +
    '&columns=ALL&pageSize=' + (size || 20) + '&source=WEB&client=WEB' +
    (sort ? '&sortColumns=' + sort + '&sortTypes=-1' : '')
  )
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function day(value) {
  const text = String(value || '').slice(0, 10)
  const t = Date.parse(text + 'T00:00:00Z')
  return Number.isFinite(t) ? t : null
}

function wan(n) {
  if (n === null) return '—'
  if (Math.abs(n) >= 10000) return (n / 10000).toFixed(2) + ' 亿'
  return n.toFixed(2) + ' 万'
}

function yuan(n) {
  if (n === null) return '—'
  if (Math.abs(n) >= 100000000) return (n / 100000000).toFixed(2) + ' 亿'
  if (Math.abs(n) >= 10000) return (n / 10000).toFixed(2) + ' 万'
  return n.toFixed(0)
}

/** Security code the caller is asking about, if any. */
function codeOf(params) {
  return params && params.code ? String(params.code).trim() : ''
}
/** Append a security-code filter when the caller is asking about one company. */
function reportFor(name, sort, size, code) {
  const base = report(name, sort, size)
  if (!code) return base
  return base + '&filter=' + encodeURIComponent('(SECURITY_CODE="' + code + '")')
}
async function rows(ctx, url, timeoutMs) {
  const res = await ctx.getJson(url, { headers: BROWSER, timeoutMs: timeoutMs || 12000 })
  if (!res.ok || !res.json) return { rows: [], error: 'http ' + (res.status || res.error) }
  const data = res.json && res.json.result && res.json.result.data
  if (!Array.isArray(data) || !data.length) return { rows: [], error: 'empty report' }
  return { rows: data, error: '' }
}

const dividend = {
  id: 'dividend',
  name: '分红送配',
  category: 'corporate',
  region: 'CN',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://data.eastmoney.com/yjfp/',
  note: 'A 股分红方案与实施进度（东财数据中心）',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 14000,
  async fetch(ctx, params) {
    const limit = Math.min(Number(params && params.limit) || 20, 20)
    const r = await rows(ctx, reportFor('RPT_SHAREBONUS_DET', 'NOTICE_DATE', limit, codeOf(params)))
    if (!r.rows.length) return { items: [], meta: { error: r.error } }
    const items = []
    for (const row of r.rows.slice(0, limit)) {
      const name = String(row.SECURITY_NAME_ABBR || '')
      const code = String(row.SECURITY_CODE || '')
      const plan = String(row.IMPL_PLAN_PROFILE || ('10派' + (num(row.PRETAX_BONUS_RMB) || 0) + '元'))
      const perShare = num(row.PRETAX_BONUS_RMB)
      items.push({
        id: 'dividend:' + code + ':' + String(row.REPORT_DATE || '').slice(0, 10),
        title: name + '(' + code + ') ' + plan,
        url: 'https://data.eastmoney.com/yjfp/detail/' + code + '.html',
        publishedAt: day(row.NOTICE_DATE),
        summary:
          '分红进度：' + String(row.ASSIGN_PROGRESS || '—') +
          ' · 股息率 ' + (num(row.DIVIDENT_RATIO) === null ? '—' : (num(row.DIVIDENT_RATIO) * 100).toFixed(2) + '%') +
          ' · 报告期 ' + String(row.REPORT_DATE || '').slice(0, 10) +
          (perShare === null ? '' : ' · 每股派 ' + perShare.toFixed(2) + ' 元(含税)/10股'),
        tags: ['公司行动', '分红', name],
        payload: { code: code, plan: plan, progress: row.ASSIGN_PROGRESS || '' },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'RPT_SHAREBONUS_DET' } }
  },
}

const lift = {
  id: 'lift',
  name: '限售解禁',
  category: 'corporate',
  region: 'CN',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://data.eastmoney.com/dxf/',
  note: '解禁日期、解禁规模与市值（东财数据中心）',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 14000,
  async fetch(ctx, params) {
    const limit = Math.min(Number(params && params.limit) || 20, 20)
    // Ascending from today: readers care about the next unlocks, not ones in 2035.
    // The filter is required — an unfiltered ascending sort starts in 1998.
    const code = codeOf(params)
    // Market view: the next unlocks from today. Company view: everything for that
    // company, newest first — a past unlock still explains the float.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
    const url = code
      ? reportFor('RPT_LIFT_STAGE', 'FREE_DATE', 20, code)
      : 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LIFT_STAGE' +
        '&columns=ALL&pageSize=40&sortColumns=FREE_DATE&sortTypes=1&source=WEB&client=WEB' +
        '&filter=' + encodeURIComponent("(FREE_DATE>='" + since + "')")
    const r = await rows(ctx, url)
    if (!r.rows.length) return { items: [], meta: { error: r.error } }
    const floor = Date.now() - 24 * 3600 * 1000
    const upcoming = code
      ? r.rows
      : r.rows.filter((row) => {
          const at = day(row.FREE_DATE)
          return at !== null && at >= floor
        })
    const items = []
    for (const row of upcoming.slice(0, limit)) {
      const name = String(row.SECURITY_NAME_ABBR || '')
      const code = String(row.SECURITY_CODE || '')
      const shares = num(row.CURRENT_FREE_SHARES)
      const cap = num(row.LIFT_MARKET_CAP)
      items.push({
        id: 'lift:' + code + ':' + String(row.FREE_DATE || '').slice(0, 10),
        title: name + '(' + code + ') 解禁 ' + (shares === null ? '—' : (shares / 10000).toFixed(2)) + ' 亿股 · ' + String(row.FREE_SHARES_TYPE || ''),
        url: 'https://data.eastmoney.com/dxf/detail/' + code + '.html',
        publishedAt: day(row.FREE_DATE),
        summary:
          '解禁市值 ' + wan(cap) + '元 · 占总股本 ' +
          (num(row.TOTAL_RATIO) === null ? '—' : (num(row.TOTAL_RATIO) * 100).toFixed(2) + '%') +
          ' · 类型 ' + String(row.FREE_SHARES_TYPE || '—') +
          ' · 解禁日 ' + String(row.FREE_DATE || '').slice(0, 10),
        tags: ['公司行动', '解禁', name],
        payload: { code: code, freeSharesWan: shares, capWan: cap, type: row.FREE_SHARES_TYPE || '' },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'RPT_LIFT_STAGE' } }
  },
}

const blocktrade = {
  id: 'blocktrade',
  name: '大宗交易',
  category: 'corporate',
  region: 'CN',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://data.eastmoney.com/dzjy/',
  note: '沪深大宗交易成交明细：价格、溢价率、买卖营业部（东财数据中心）',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 14000,
  async fetch(ctx, params) {
    const limit = Math.min(Number(params && params.limit) || 20, 20)
    const r = await rows(ctx, reportFor('RPT_DATA_BLOCKTRADE', 'TRADE_DATE', limit, codeOf(params)))
    if (!r.rows.length) return { items: [], meta: { error: r.error } }
    const items = []
    for (const row of r.rows.slice(0, limit)) {
      const name = String(row.SECURITY_NAME_ABBR || '')
      const code = String(row.SECURITY_CODE || '')
      const deal = num(row.DEAL_PRICE)
      const volume = num(row.DEAL_VOLUME)
      const amount = num(row.DEAL_AMT)
      const premium = num(row.PREMIUM_RATIO)
      items.push({
        id: 'blocktrade:' + code + ':' + String(row.TRADE_DATE || '').slice(0, 10) + ':' + (deal || '') + ':' + (volume || ''),
        title: name + '(' + code + ') 大宗 ' + (deal === null ? '—' : deal.toFixed(2)) + ' 元 × ' +
          (volume === null ? '—' : (volume / 10000).toFixed(2)) + ' 万股',
        url: 'https://data.eastmoney.com/dzjy/detail/' + code + '.html',
        publishedAt: day(row.TRADE_DATE),
        summary:
          '成交额 ' + yuan(amount) + '元 · 溢价率 ' +
          (premium === null ? '—' : (premium >= 0 ? '+' : '') + premium.toFixed(2) + '%') +
          ' · 买方 ' + String(row.BUYER_NAME || '—') + ' · 卖方 ' + String(row.SELLER_NAME || '—'),
        tags: ['公司行动', '大宗交易', name],
        payload: { code: code, price: deal, volume: volume, amount: amount, premium: premium },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'RPT_DATA_BLOCKTRADE' } }
  },
}

const holder = {
  id: 'holder-change',
  name: '股东增减持',
  category: 'corporate',
  region: 'CN',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://data.eastmoney.com/executive/',
  note: '重要股东二级市场增减持（东财数据中心）',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 14000,
  async fetch(ctx, params) {
    const limit = Math.min(Number(params && params.limit) || 20, 20)
    const r = await rows(ctx, reportFor('RPT_SHARE_HOLDER_INCREASE', 'NOTICE_DATE', limit, codeOf(params)))
    if (!r.rows.length) return { items: [], meta: { error: r.error } }
    const items = []
    for (const row of r.rows.slice(0, limit)) {
      const name = String(row.SECURITY_NAME_ABBR || '')
      const code = String(row.SECURITY_CODE || '')
      const direction = String(row.DIRECTION || '变动')
      const change = num(row.CHANGE_NUM)
      const holderName = String(row.HOLDER_NAME || '')
      items.push({
        id: 'holder:' + code + ':' + String(row.NOTICE_DATE || '').slice(0, 10) + ':' + holderName.slice(0, 12),
        title: name + '(' + code + ') 股东' + direction + ' ' + wan(change) + '股',
        url: 'https://data.eastmoney.com/executive/list.html',
        publishedAt: day(row.NOTICE_DATE),
        summary:
          holderName + ' · 变动 ' + wan(change) + '股 · 变动后持股比例 ' +
          (num(row.AFTER_CHANGE_RATE) === null ? '—' : (num(row.AFTER_CHANGE_RATE) * 100).toFixed(2) + '%') +
          ' · 变动期间 ' + String(row.START_DATE || '').slice(0, 10) + '~' + String(row.END_DATE || '').slice(0, 10),
        tags: ['公司行动', direction, name],
        payload: { code: code, holder: holderName, direction: direction, changeWan: change },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'RPT_SHARE_HOLDER_INCREASE' } }
  },
}

const forecast = {
  id: 'forecast',
  name: '业绩预告',
  category: 'corporate',
  region: 'CN',
  tier: 'B',
  capability: ['list'],
  homepage: 'https://data.eastmoney.com/bbsj/',
  note: '业绩预告与预增预减幅度（东财数据中心）',
  needsKey: false,
  rateLimit: { perMinute: 20 },
  timeoutMs: 14000,
  async fetch(ctx, params) {
    const limit = Math.min(Number(params && params.limit) || 20, 20)
    const r = await rows(ctx, reportFor('RPT_PUBLIC_OP_NEWPREDICT', 'NOTICE_DATE', limit, codeOf(params)))
    if (!r.rows.length) return { items: [], meta: { error: r.error } }
    const items = []
    for (const row of r.rows.slice(0, limit)) {
      const name = String(row.SECURITY_NAME_ABBR || '')
      const code = String(row.SECURITY_CODE || '')
      const content = String(row.PREDICT_CONTENT || '')
      const low = num(row.ADD_AMP_LOWER)
      const high = num(row.ADD_AMP_UPPER)
      items.push({
        id: 'forecast:' + code + ':' + String(row.REPORT_DATE || '').slice(0, 10),
        title: name + '(' + code + ') ' + String(row.PREDICT_TYPE || '业绩预告') + ' · ' + String(row.PREDICT_FINANCE || ''),
        url: 'https://data.eastmoney.com/bbsj/yjyg/' + code + '.html',
        publishedAt: day(row.NOTICE_DATE),
        summary:
          content.slice(0, 120) +
          (low === null && high === null ? '' : ' · 同比 ' + (low === null ? '—' : low.toFixed(2) + '%') + '~' + (high === null ? '—' : high.toFixed(2) + '%')) +
          ' · 报告期 ' + String(row.REPORT_DATE || '').slice(0, 10),
        tags: ['公司行动', '业绩预告', name],
        payload: { code: code, type: row.PREDICT_TYPE || '', metric: row.PREDICT_FINANCE || '', low: low, high: high },
      })
    }
    return { items, meta: { total: items.length, endpoint: 'RPT_PUBLIC_OP_NEWPREDICT' } }
  },
}

export const adapters = [dividend, lift, blocktrade, holder, forecast]
