/**
 * Futures: domestic exchanges and overseas contracts, all through Eastmoney's
 * public quote list (the same endpoint the quote pages call).
 *
 * Market ids (discovered, stable for years):
 *   113 上期所 SHFE   114 大商所 DCE   115 郑商所 CZCE
 *     8 中金所 CFFEX  225 广期所 GFEX
 *   102 NYMEX  103 CBOT  108 ICE  110 BMD  111 TOCOM  112 其他外盘
 *
 * Ranking is by turnover so the list surfaces liquid contracts (mostly 主连 /
 * 主力) instead of illiquid far months.
 */

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json, text/javascript, */*',
}
const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'
const QUOTE_REF = { referer: 'https://quote.eastmoney.com/' }

const FIELDS = 'f12,f13,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18'

function limitOf(params, fallback) {
  const n = Number(params && params.limit)
  return Math.min(Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback, 60)
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 1.23e8 -> "1.23亿" */
function humanMoney(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (abs >= 1e4) return (n / 1e4).toFixed(2) + '万'
  return n.toFixed(0)
}

/** One exchange's board. Never throws. */
async function board(ctx, marketId, label, size) {
  const url =
    CLIST + '?pn=1&pz=' + size + '&po=1&np=1&fltt=2&invt=2&fid=f6&fs=m:' + marketId + '&fields=' + FIELDS
  const res = await ctx.getJson(url, { headers: BROWSER, ...QUOTE_REF, timeoutMs: 8000 })
  const rows = res.ok && res.json && res.json.data && res.json.data.diff
  if (!Array.isArray(rows)) return []
  return rows.map((row) => ({ row: row, label: label }))
}

function toItem(entry) {
  const row = entry.row
  const code = String(row.f12 || '')
  const name = String(row.f14 || '').replace(/\s+/g, '')
  const price = num(row.f2)
  const changePct = num(row.f3)
  const change = num(row.f4)
  const turnover = num(row.f6)
  const high = num(row.f15)
  const low = num(row.f16)
  const open = num(row.f17)
  const prevClose = num(row.f18)
  const sign = changePct === null ? '' : (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%'
  return {
    id: 'fut:' + entry.label + ':' + code,
    title: name + ' ' + (price === null ? '—' : price) + ' ' + sign,
    url: 'https://quote.eastmoney.com/qihuo/' + code + '.html',
    publishedAt: Date.now(),
    summary:
      entry.label + ' · 成交额 ' + humanMoney(turnover) +
      (open === null ? '' : ' · 开 ' + open) +
      (high === null || low === null ? '' : ' · 高 ' + high + ' / 低 ' + low) +
      (prevClose === null ? '' : ' · 昨结 ' + prevClose),
    tags: ['期货', entry.label],
    payload: {
      code: code,
      name: name,
      exchange: entry.label,
      price: price,
      change: change,
      changePct: changePct,
      turnover: turnover,
      open: open,
      high: high,
      low: low,
      prevClose: prevClose,
    },
  }
}

/**
 * One row per underlying, not one per contract form.
 *
 * The board lists the same product three ways (IM2612 / IM主力合约 / IM下月连续).
 * Key by the product: the leading letters for codes like `IM2612`, otherwise the
 * name with contract words and digits stripped (沪锡2707 -> 沪锡).
 */
function productKey(item) {
  const code = String(item.payload.code || '')
  const letters = /^[A-Za-z]+/.exec(code)
  if (letters) return 'L:' + letters[0].toUpperCase()
  const name = String(item.payload.name || '')
    .replace(/主连|主力合约|主力|次主连|下月连续|隔季连续|当月连续|连续/g, '')
    .replace(/\d+/g, '')
    .replace(/\s+/g, '')
  return 'C:' + name
}

/** Prefer the continuous / main contract when collapsing the same product. */
function mainness(item) {
  return /主连|主力|连续/.test(String(item.payload.name || '')) ? 1 : 0
}

const CN_MARKETS = [
  ['113', '上期所'],
  ['114', '大商所'],
  ['115', '郑商所'],
  ['8', '中金所'],
  ['225', '广期所'],
]

const GLOBAL_MARKETS = [
  ['102', 'NYMEX'],
  ['103', 'CBOT'],
  ['108', 'ICE'],
  ['110', 'BMD'],
  ['111', 'TOCOM'],
  ['112', '外盘'],
]

/** Shared builder for both boards. */
function makeAdapter(id, name, region, markets, note, homepage) {
  return {
    id: id,
    name: name,
    category: 'futures',
    region: region,
    tier: 'A',
    capability: ['list'],
    homepage: homepage,
    note: note,
    needsKey: false,
    rateLimit: { perMinute: 20 },
    timeoutMs: 12000,
    async fetch(ctx, params) {
      const limit = limitOf(params, 40)
      // One request per exchange, in parallel: the list endpoint takes a single `fs`.
      const boards = await Promise.all(markets.map(([marketId, label]) => board(ctx, marketId, label, limit)))
      const entries = []
      for (const rows of boards) for (const entry of rows) entries.push(entry)
      if (entries.length === 0) return { items: [], meta: { error: 'no rows from any exchange' } }
      const byProduct = new Map()
      for (const entry of entries) {
        const item = toItem(entry)
        if (!item.title) continue
        const key = productKey(item)
        const previous = byProduct.get(key)
        if (!previous) {
          byProduct.set(key, item)
          continue
        }
        // Same underlying: keep the continuous contract, or the more liquid month.
        const better =
          mainness(item) > mainness(previous) ||
          (mainness(item) === mainness(previous) && (item.payload.turnover || 0) > (previous.payload.turnover || 0))
        if (better) byProduct.set(key, item)
      }
      const items = Array.from(byProduct.values())
        .sort((a, b) => (b.payload.turnover || 0) - (a.payload.turnover || 0))
      // Non-trading months answer with "-" for every price; drop them while enough
      // live contracts remain, otherwise keep whatever we got.
      const priced = items.filter((item) => item.payload.price !== null)
      const pool = priced.length >= 10 ? priced : items
      return { items: pool.slice(0, limit), meta: { total: pool.length, exchanges: markets.map((m) => m[1]) } }
    },
  }
}

const futCn = makeAdapter(
  'fut-cn',
  '国内期货',
  'CN',
  CN_MARKETS,
  '上期所 / 大商所 / 郑商所 / 中金所 / 广期所，按成交额排序的主连与主力合约',
  'https://quote.eastmoney.com/center/gridlist.html#futures_cn',
)

const futGlobal = makeAdapter(
  'fut-global',
  '外盘期货',
  'GLOBAL',
  GLOBAL_MARKETS,
  'NYMEX / CBOT / ICE / BMD / TOCOM 等外盘合约，按成交额排序',
  'https://quote.eastmoney.com/center/gridlist.html#futures_global',
)

export const adapters = [futCn, futGlobal]
