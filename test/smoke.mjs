/**
 * dsh-market-info smoke test: unit checks for the pure modules plus a real HTTP harness
 * that mounts the panel routes and exercises them end-to-end (live network,
 * system proxy auto-detected). Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseRss, parseBingNews, parseGoogleNews, parseWallstcn, parseEastmoney, decodeBingNewsLink, rsshubUrl } from '../lib/feed.mjs'
import { createStore } from '../lib/store.mjs'
import { createService } from '../lib/service.mjs'
import { createHandler } from '../lib/routes.mjs'
import { extractArticle, bodyLooksReal, phraseOf, resolveGoogleNewsUrl, decodeGoogleNewsPage, parseGartUrlResponse, rankHits } from '../lib/unwall.mjs'
import zlib from 'node:zlib'
import { fetchText, detectSystemProxy, buildHeaders, detectBlock, decompressBody, PERSONAS, clearCookieJar } from '../lib/net.mjs'
import { DEFAULT_WATCHLIST, fetchQuotes, parseTradingViewScanner, parseTencentQuotes, parseYahooChart, parseCoingecko, parseYahooSpark, parseYahooChartSeries, parseTencentMinute, parseEastmoneyKlines, parseOkxCandles } from '../lib/quotes.mjs'
import { stripTags } from '../lib/text.mjs'

const PARTNER_ARTICLE = 'https://www.businesstimes.com.sg/companies-markets/anthropic-targets-mega-ipo-thanksgiving-holiday'
const BNN_RSS = 'https://www.bnnbloomberg.ca/arc/outboundfeeds/rss/'
const GATE = { 'x-market-info': '1' }
const results = []
let passed = 0
let failed = 0

async function test(name, fn) {
  const started = Date.now()
  try {
    await fn()
    passed += 1
    results.push('PASS  ' + name + '  (' + (Date.now() - started) + 'ms)')
  } catch (error) {
    failed += 1
    results.push('FAIL  ' + name + '  :: ' + String(error && error.stack ? error.stack.split('\n')[0] : error))
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-market-info-test-'))

// ---------- unit: RSS parser ----------
await test('feed.parseRss parses CDATA + fields', () => {
  const xml = '<rss><channel>' +
    '<item><title><![CDATA[Hello <b>World</b>]]></title><link>https://example.com/a</link>' +
    '<description><![CDATA[Sum <b>mary</b>]]></description><dc:creator>Bloomberg News</dc:creator>' +
    '<pubDate>Wed, 04 Nov 2026 20:21:09 -0400</pubDate></item>' +
    '<item><title>Second</title><link>https://example.com/b</link><pubDate>bad-date</pubDate></item>' +
    '<item><title>No link</title></item>' +
    '</channel></rss>'
  const items = parseRss(xml, { id: 'x', name: 'X' })
  assert.equal(items.length, 2)
  assert.equal(items[0].title, 'Hello World')
  assert.equal(items[0].creator, 'Bloomberg News')
  assert.equal(items[0].source, 'X')
  assert.ok(items[0].date)
  assert.equal(items[1].date, null)
})

// ---------- unit: text cache caps ----------
await test('store enforces item cap, stats and clear', () => {
  const dir = path.join(tmpRoot, 'store')
  const store = createStore({ dataDir: dir, settings: { maxItems: 2, maxBytes: 30 * 1024 * 1024, ttlHours: 72 } })
  const make = (i) => ({
    title: 'article ' + i,
    body: 'Body text number ' + i + '. '.repeat(60),
    sourceUrl: 'https://example.com/' + i,
    sourceHost: 'example.com',
    original: 'https://www.bloomberg.com/news/articles/2026-11-0' + i + '/story-' + i,
  })
  store.put(make(1))
  store.put(make(2))
  store.put(make(3))
  assert.equal(store.stats().items, 2, 'oldest evicted')
  const hit = store.get(make(3).original)
  assert.ok(hit && hit.title === 'article 3')
  assert.ok(store.stats().bytes > 0)
  store.clear()
  assert.equal(store.stats().items, 0)
  assert.equal(store.stats().bytes, 0)
})

// ---------- unit: text helpers ----------
await test('text.stripTags decodes named + numeric entities', () => {
  const out = stripTags('<p>OTTAWA &mdash; Beijing &amp; Ottawa &ldquo;quoted&rdquo; &#8212; &#37;</p>')
  assert.equal(out, 'OTTAWA — Beijing & Ottawa “quoted” — %')
})

await test('extractArticle prefers longer paragraph body over truncated JSON-LD', () => {
  const longPara = ('This long paragraph carries the real story text. ').repeat(6)
  const parasHtml = '<article><p>' + longPara + '</p><p>' + longPara + '</p><p>' + longPara + '</p></article>'
  const html = '<html><head><script type="application/ld+json">' +
    JSON.stringify({ '@type': 'NewsArticle', articleBody: 'short json-ld stub. '.repeat(10) }) +
    '</script></head><body>' + parasHtml + '</body></html>'
  const out = extractArticle(html)
  assert.ok(out.length > 800, 'picked the longer paragraphs: ' + out.length)
  assert.ok(out.includes('real story text'))
})

// ---------- unit: new feed providers ----------
await test('unwall CJC-aware scoring keeps Chinese headlines', () => {
  const phrase = 'OpenAI总裁：预计2027年做好上市准备'
  const hits = [
    { title: 'OpenAI总裁：预计2027年做好上市准备', url: 'https://www.zaobao.com.sg/finance/world/story20261105-9950050' },
    { title: '心斎橋焙煎所', url: 'https://tabelog.com/osaka/A2701/27083267/' },
  ]
  const ranked = rankHits(hits, phrase)
  assert.ok(ranked.length >= 1, 'Chinese hits survive ranking')
  assert.ok(ranked[0].url.includes('zaobao'))
  assert.ok(bodyLooksReal('据路透社报道，布罗克曼星期三在美国加利福尼亚州纳帕表示，OpenAI将会做好准备。' + '他说公司一直在加大面向企业的销售力度，包括推广旗下AI代理Codex，以与竞争对手Anthropic展开竞争。'.repeat(10), phrase))
  assert.equal(bodyLooksReal('GitHub · Where software is built. '.repeat(20), phrase), false)
})

await test('unwall.extractArticle reads Chinese paragraphs', () => {
  const html = '<html><body><article><p>据路透社报道，布罗克曼星期三（11月4日）在美国加利福尼亚州纳帕举行的科技大会上表示，OpenAI预计会在2027年做好上市准备。</p><p>他说，OpenAI一直在加大面向企业的销售力度，包括推广旗下AI代理Codex，以与竞争对手Anthropic展开竞争。</p></article></body></html>'
  const body = extractArticle(html)
  assert.ok(body.length > 80, 'chinese body ' + body.length)
  assert.ok(body.includes('布罗克曼'))
})

await test('unwall.extractArticle prefers clean JSON-LD over nav chrome', () => {
  const article = 'Canadian officials say their focus has not changed after stunning losses in the midterms. In a sweeping upset, the Democrats have retaken control of the American legislative branch. Two years deep into a trade war, Canadians wait to see the impacts of the shift.'
  const html = '<script type="application/ld+json">' + JSON.stringify({ '@type': 'NewsArticle', articleBody: article }) + '</script>' +
    '<article><p>Sections TSX S&P 500 DOW Investing Company News Watch Market Call Shows Search Sign In Search Sign In Download Our App</p>' +
    '<p>Canadian officials say their focus has not changed after stunning losses in the midterms.</p></article>'
  const body = extractArticle(html)
  assert.ok(body.startsWith('Canadian officials'), 'clean body first')
  assert.ok(!/Sections|Sign In|Download Our App/.test(body), 'nav chrome filtered')
})

await test('unwall.parseGartUrlResponse reads batchexecute replies', () => {
  const fixture = ")]}'\n\n" + JSON.stringify([['wrb.fr', 'Fbv4je', '["garturlres","https://www.zaobao.com.sg/finance/world/story20261105-9950050",1]', null, null, null, 'generic'], ['di', 18]])
  assert.equal(parseGartUrlResponse(fixture), 'https://www.zaobao.com.sg/finance/world/story20261105-9950050')
  assert.equal(parseGartUrlResponse('nope'), '')
})

await test('unwall.decodeGoogleNewsPage ignores image CDN links', () => {
  const html = '<a href="https://lh3.googleusercontent.com/abc=w16">img</a>'
  assert.equal(decodeGoogleNewsPage(html), '')
  const good = '<a data-n-au="https://www.reuters.com/world/foo">x</a>'
  assert.equal(decodeGoogleNewsPage(good), 'https://www.reuters.com/world/foo')
})

await test('unwall.decodeGoogleNewsPage extracts the publisher URL', () => {
  const html = '<c-wiz><a data-n-au="https://www.reuters.com/world/foo?x=1&amp;y=2" href="#">read</a></c-wiz>'
  assert.equal(decodeGoogleNewsPage(html), 'https://www.reuters.com/world/foo?x=1&y=2')
  const g = decodeGoogleNewsPage('<div data-n-au="https://news.google.com/x">google</div>')
  assert.equal(g, '')
  assert.equal(decodeGoogleNewsPage('<html>nothing</html>'), '')
})

await test('feed.decodeBingNewsLink unwraps apiclick redirects', () => {
  const target = 'https://www.reuters.com/world/us/example-2026-11-04/'
  const link = 'http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&url=' + encodeURIComponent(target) + '&c=1'
  assert.equal(decodeBingNewsLink(link), target)
  assert.equal(decodeBingNewsLink('https://example.com/a'), 'https://example.com/a')
  assert.equal(decodeBingNewsLink('https://www.bing.com/news/x'), '')
})

await test('feed.parseBingNews keeps outlet + direct publisher URL', () => {
  const target = 'https://www.reuters.com/business/energy/sample-story-2026-11-04/'
  const xml = '<rss><channel><item>' +
    '<title>Sample Reuters story</title>' +
    '<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=' + encodeURIComponent(target) + '&amp;c=1</link>' +
    '<description>Summary text here.</description>' +
    '<pubDate>Wed, 04 Nov 2026 12:00:00 GMT</pubDate>' +
    '<News:Source>Reuters</News:Source>' +
    '</item><item><title>Other outlet</title><link>http://www.bing.com/news/apiclick.aspx?url=' + encodeURIComponent('https://example.com/b') + '</link><News:Source>Other</News:Source></item>' +
    '</channel></rss>'
  const feed = { id: 'reuters', name: 'Reuters', filterSources: ['Reuters'] }
  const items = parseBingNews(xml, feed)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, target)
  assert.equal(items[0].outlet, 'Reuters')
  assert.equal(items[0].sourceId, 'reuters')
})

await test('feed.parseWallstcn maps the 7x24 JSON payload', () => {
  const payload = JSON.stringify({ code: 20000, data: { items: [
    { id: 1, uri: 'https://wallstreetcn.com/livenews/1', title: '', content: '<p>花旗：将黄金目标价设定为每盎司4500美元。</p>', content_text: '花旗：将黄金目标价设定为每盎司4500美元。', display_time: 1793837614, author: { display_name: '石惠' }, global_channel_name: '7x24快讯' },
    { id: 2, uri: 'https://wallstreetcn.com/livenews/2', title: '第二条', content: '<p>第二条快讯内容。</p>', display_time: 1793837000 },
  ] } })
  const items = parseWallstcn(payload, { id: 'wallstcn', name: '华尔街见闻', category: '中文' })
  assert.equal(items.length, 2)
  assert.ok(items[0].title.includes('花旗'))
  assert.equal(items[0].url, 'https://wallstreetcn.com/livenews/1')
  assert.equal(items[0].creator, '石惠')
  assert.equal(items[0].category, '7x24快讯')
  assert.ok(items[0].date)
})

await test('feed.parseEastmoney maps the JSONP payload', () => {
  const body = 'var ajaxResult={"rc":1,"LivesList":[{"id":"1","url_w":"http://finance.eastmoney.com/a/202611043922179851.html","title":"快讯标题","digest":"快讯摘要","showtime":"2026-11-05 08:10:47"}]};'
  const items = parseEastmoney(body, { id: 'eastmoney', name: '东方财富快讯', category: '中文' })
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '快讯标题')
  assert.equal(items[0].url, 'http://finance.eastmoney.com/a/202611043922179851.html')
  assert.equal(items[0].category, '中文')
  assert.equal(items[0].date, '2026-11-05T00:10:47.000Z')
})

await test('feed.parseGoogleNews cleans titles and sets readHint', () => {
  const xml = '<rss><channel><item>' +
    '<title>Asian Stocks to Rise as Oil Slides - Bloomberg.com</title>' +
    '<link>https://news.google.com/rss/articles/CBMiABC?oc=5</link>' +
    '<description><![CDATA[<a href="#">Asian Stocks to Rise as Oil Slides</a>]]></description>' +
    '<pubDate>Wed, 04 Nov 2026 23:11:55 GMT</pubDate>' +
    '<source url="https://www.bloomberg.com">Bloomberg.com</source>' +
    '</item></channel></rss>'
  const items = parseGoogleNews(xml, { id: 'gnews', name: 'Google News · Bloomberg', category: '通讯社' })
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Asian Stocks to Rise as Oil Slides')
  assert.equal(items[0].readHint, 'Asian Stocks to Rise as Oil Slides')
  assert.equal(items[0].via, 'google-news')
  assert.ok(items[0].url.startsWith('https://news.google.com/rss/articles/'))
})

await test('feed.rsshubUrl resolves routes against the instance base', () => {
  assert.equal(rsshubUrl({ route: '/36kr/newsflashes' }, 'https://hub.example.com/'), 'https://hub.example.com/36kr/newsflashes')
  assert.equal(rsshubUrl({ route: 'caixin/latest' }, 'https://hub.example.com'), 'https://hub.example.com/caixin/latest')
  assert.equal(rsshubUrl({ url: 'https://x.example.com/feed' }, 'https://hub.example.com'), 'https://x.example.com/feed')
})

// ---------- unit: anti-block network layer ----------
await test('net.buildHeaders rotates personas and browser headers', () => {
  const uas = new Set()
  let sawChUa = false
  for (let i = 0; i < 4; i += 1) {
    const h = buildHeaders({ rotateUA: true })
    uas.add(h['user-agent'])
    if (h['sec-ch-ua']) sawChUa = true
    assert.ok(h['accept-language'])
    assert.equal(h['accept-encoding'], 'gzip, deflate, br')
    assert.ok(h['sec-fetch-mode'] === 'navigate')
  }
  assert.ok(uas.size >= 2, 'personas rotate, got ' + uas.size)
  assert.ok(sawChUa, 'chromium client hints present')
  assert.ok(PERSONAS.length >= 4)
})

await test('net.detectBlock classifies challenge pages', () => {
  assert.equal(detectBlock(200, 'Just a moment... cf-chl').kind, 'cloudflare')
  assert.equal(detectBlock(200, '<title>Are you a robot?</title>').kind, 'challenge')
  assert.equal(detectBlock(429, 'slow down').kind, 'rate-limit')
  assert.equal(detectBlock(403, 'nope').kind, 'forbidden')
  assert.equal(detectBlock(200, '<html><body>hello world</body></html>').blocked, false)
})

await test('net.decompressBody decodes gzip payloads', () => {
  const raw = Buffer.from('compressed text ✓')
  const gz = zlib.gzipSync(raw)
  assert.equal(decompressBody(gz, 'gzip'), 'compressed text ✓')
  assert.equal(decompressBody(Buffer.from('plain'), 'identity'), 'plain')
})

await test('net.fetchText retries 429 and keeps cookies', async () => {
  clearCookieJar()
  let retryHits = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/retry') {
      retryHits += 1
      if (retryHits < 3) {
        res.writeHead(429, { 'retry-after': '0' })
        res.end('rate limited')
        return
      }
      res.writeHead(200)
      res.end('retry ok')
      return
    }
    if (req.url === '/cookie') {
      if (!req.headers.cookie) {
        res.writeHead(200, { 'set-cookie': 'consent=yes; Path=/' })
        res.end('no cookie')
        return
      }
      res.writeHead(200)
      res.end('cookie=' + req.headers.cookie)
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  try {
    const retried = await fetchText(baseUrl + '/retry', { retries: 2, timeoutMs: 8000 })
    assert.equal(retried.status, 200)
    assert.equal(retried.attempts, 3)
    assert.equal(retried.text, 'retry ok')
    await fetchText(baseUrl + '/cookie', { timeoutMs: 8000 })
    const second = await fetchText(baseUrl + '/cookie', { timeoutMs: 8000 })
    assert.equal(second.text, 'cookie=consent=yes')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

await test('feed auto-fallback replaces a broken RSS with Bing News site search', async () => {
  const fallbackService = createService({
    dataDir: path.join(tmpRoot, 'fallback-service'),
    feeds: [{ id: 'ftbroken', name: 'FT Broken', type: 'rss', url: 'https://www.ft.com/rss/this-feed-does-not-exist-xyz', category: '国际' }],
  }, () => {})
  const feed = await fallbackService.feed(true)
  assert.ok(feed.items.length > 0, 'fallback items ' + feed.items.length)
  assert.equal(feed.sources[0].fallback, true)
  assert.ok(/ft\.com/i.test(feed.items[0].url), 'fallback url ' + feed.items[0].url)
})

// ---------- unit: market data parsers + provider fallback ----------
await test('quotes.parseTradingViewScanner maps batched rows', () => {
  const fixture = JSON.stringify({
    totalCount: 2,
    data: [
      { s: 'SP:SPX', d: [7688.62, 1.5814673691887327, 119.7, 4562882370, 'SPX', 'S&P 500'] },
      { s: 'NASDAQ:AAPL', d: [349.51, 5.305815004519438, 17.61, 89637511, 'AAPL', 'Apple'] },
    ],
  })
  const items = [
    { id: 'spx', label: '标普500', tv: 'SP:SPX', currency: 'USD' },
    { id: 'aapl', label: 'AAPL', tv: 'NASDAQ:AAPL', currency: 'USD' },
  ]
  const out = parseTradingViewScanner(fixture, items)
  assert.equal(out.size, 2)
  const spx = out.get('spx')
  assert.equal(spx.price, 7688.62)
  assert.equal(spx.changePct, 1.58)
  assert.equal(spx.source, 'tradingview')
  assert.equal(out.get('aapl').price, 349.51)
})

await test('quotes.parseTencentQuotes reads the batch payload', () => {
  const parts = new Array(34).fill('0')
  parts[1] = '上证指数'
  parts[3] = '3670.40'
  parts[4] = '3686.17'
  parts[6] = '99129573'
  parts[31] = '-15.77'
  parts[32] = '-0.43'
  const text = 'v_sh000001="' + parts.join('~') + '";'
  const out = parseTencentQuotes(text, [{ id: 'sse', label: '上证指数', tencent: 'sh000001', currency: 'CNY' }])
  const row = out.get('sse')
  assert.ok(row, 'parsed row')
  assert.equal(row.price, 3670.4)
  assert.equal(row.changeAbs, -15.77)
  assert.equal(row.changePct, -0.43)
  assert.equal(row.source, 'tencent')
})

await test('quotes.parseYahooChart + parseCoingecko normalize change', () => {
  const yahoo = parseYahooChart(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 7688.62, chartPreviousClose: 7568.92, regularMarketVolume: 123 } }] } }), { id: 'spx', label: '标普500' })
  assert.ok(yahoo)
  assert.equal(yahoo.price, 7688.62)
  assert.ok(Math.abs(yahoo.changePct - 1.58) < 0.05)
  const cg = parseCoingecko(JSON.stringify({ bitcoin: { usd: 80000, usd_24h_change: 2.5 } }), [{ id: 'btc', label: 'BTC', coingecko: 'bitcoin' }])
  assert.equal(cg.get('btc').price, 80000)
  assert.equal(cg.get('btc').changePct, 2.5)
})

await test('quotes.fetchQuotes falls through providers in order', async () => {
  const items = [{ id: 'x', label: 'X', tv: 'A:X' }]
  const providers = [
    { name: 'broken', supports: () => true, async fetch() { throw new Error('down') } },
    { name: 'fake', supports: () => true, async fetch(targets) {
      const m = new Map()
      for (const item of targets) m.set(item.id, { id: item.id, label: item.label, symbol: 'A:X', price: 1.5, changePct: 0, changeAbs: 0, volume: null, currency: '', source: 'fake', ts: Date.now() })
      return m
    } },
  ]
  const data = await fetchQuotes(items, { providers: providers })
  assert.equal(data.quotes.length, 1)
  assert.equal(data.quotes[0].source, 'fake')
  assert.equal(data.sources[0].name, 'broken')
  assert.equal(data.sources[0].ok, false)
  assert.equal(data.sources[1].name, 'fake')
  assert.equal(data.missing.length, 0)
})

await test('quotes.parseYahooSpark extracts intraday series', () => {
  const now = Date.now() - 600000
  const fixture = JSON.stringify({ spark: { result: [
    { symbol: '^GSPC', response: [{ meta: {}, timestamp: [Math.round(now / 1000), Math.round(now / 1000) + 300, Math.round(now / 1000) + 600], indicators: { quote: [{ close: [7650.1, 7680.2, 7688.62] }] } }] },
  ] } })
  const out = parseYahooSpark(fixture, [{ id: 'spx', label: '标普500', yahoo: '^GSPC' }])
  assert.equal(out.size, 1)
  const points = out.get('spx')
  assert.equal(points.length, 3)
  assert.equal(points[0].price, 7650.1)
  assert.ok(points[0].t > 0)
})

await test('quotes.parseYahooChartSeries + parseTencentMinute map points', () => {
  const chart = parseYahooChartSeries(JSON.stringify({ chart: { result: [{ meta: { chartPreviousClose: 100, regularMarketPrice: 103 }, timestamp: [1, 2, 3], indicators: { quote: [{ close: [100, 101, 103] }] } }] } }))
  assert.equal(chart.points.length, 3)
  assert.equal(chart.points[0].t, 1000)
  assert.equal(chart.prevClose, 100)
  const tencent = parseTencentMinute(JSON.stringify({ data: { sh000001: { data: { date: '20261105', data: ['0930 3646.57 100', '0931 3650.70 200'] } } } }), 'sh000001')
  assert.equal(tencent.length, 2)
  assert.equal(tencent[1].price, 3650.7)
  const empty = parseTencentMinute(JSON.stringify({ data: {} }), 'nope')
  assert.equal(empty, null)
})

await test('quotes.parseEastmoneyKlines + parseOkxCandles map history', () => {
  const em = parseEastmoneyKlines(JSON.stringify({ data: { klines: [
    '2026-11-04 09:35,3618.46,3635.81,3636.32,3617.90,20044708,27862139648.00,0.51',
    '2026-11-04 09:40,3635.81,3640.12,3641.00,3634.00,1000,100.00,0.12',
  ] } }))
  assert.equal(em.length, 2)
  assert.equal(em[0].price, 3635.81)
  assert.ok(em[0].t > 0)
  const okx = parseOkxCandles(JSON.stringify({ data: [
    ['1762300000000', '80000', '80500', '79500', '80300', '1', '2', '3', '4'],
    ['1762299700000', '79900', '80100', '79800', '80000', '1', '2', '3', '4'],
  ] }))
  assert.equal(okx.length, 2)
  assert.ok(okx[0].t < okx[1].t, 'sorted ascending')
  assert.equal(okx[1].price, 80300)
  assert.equal(parseEastmoneyKlines('nope'), null)
})

await test('quotes.fetchQuotes reports unsupported symbols as missing', async () => {
  const data = await fetchQuotes([{ id: 'weird', label: 'Weird' }], { providers: [{ name: 'none', supports: () => false, fetch: async () => new Map() }] })
  assert.equal(data.quotes.length, 0)
  assert.deepEqual(data.missing, ['weird'])
})

// ---------- unit: settings normalization ----------
await test('store normalizes keywords/feeds and persists them', () => {
  const dir = path.join(tmpRoot, 'settings-store')
  const store = createStore({ dataDir: dir })
  assert.deepEqual(store.settings().keywords, [])
  store.updateSettings({
    keywords: [' AI ', 'AI', 'markets', '', 123],
    feeds: [
      { name: 'BNN', url: BNN_RSS, category: '国际' },
      { name: 'bad', url: 'ftp://x' },
      { name: 'dup', url: BNN_RSS },
      { name: 'Reuters', type: 'bing-news', query: 'Reuters', filterSources: ['Reuters'], category: '通讯社' },
      { name: '华尔街见闻', type: 'wallstcn' },
      { name: 'Google News', type: 'google-news', query: 'when:24h 路透社' },
      { name: 'RSSHub 36氪', type: 'rsshub', route: '/36kr/newsflashes' },
    ],
  })
  const saved = store.settings()
  assert.deepEqual(saved.keywords, ['AI', 'markets', '123'])
  assert.equal(saved.feeds.length, 5)
  assert.equal(saved.feeds[0].name, 'BNN')
  assert.equal(saved.feeds[1].type, 'bing-news')
  assert.equal(saved.feeds[1].query, 'Reuters')
  assert.equal(saved.feeds[2].type, 'wallstcn')
  assert.equal(saved.feeds[3].type, 'google-news')
  assert.equal(saved.feeds[4].type, 'rsshub')
  assert.equal(saved.feeds[4].route, '/36kr/newsflashes')
  const reopened = createStore({ dataDir: dir })
  assert.deepEqual(reopened.settings().keywords, ['AI', 'markets', '123'])
  assert.equal(reopened.settings().feeds[0].url, BNN_RSS)
})

// ---------- unit: article extraction ----------
await test('extractArticle prefers JSON-LD articleBody', () => {
  const body = 'This is the full article body. '.repeat(20)
  const html = '<html><head><script type="application/ld+json">' +
    JSON.stringify({ '@type': 'NewsArticle', articleBody: body }) +
    '</script></head><body><p>nav junk</p></body></html>'
  const out = extractArticle(html)
  assert.ok(out.length > 400)
  assert.ok(out.includes('This is the full article body'))
  const withEntity = '<html><head><script type="application/ld+json">' +
    JSON.stringify({ '@type': 'NewsArticle', articleBody: ('OTTAWA &mdash; Beijing &amp; Ottawa. ').repeat(20) }) +
    '</script></head><body></body></html>'
  const fixed = extractArticle(withEntity)
  assert.ok(fixed.includes('—') && fixed.includes('&'), 'decodes entities from JSON-LD body')
  assert.ok(!fixed.includes('&mdash;'), 'no raw &mdash; left')
  assert.equal(phraseOf('https://www.bloomberg.com/news/articles/2026-10-01/anthropic-said-to-target-mega-ipo-before-thanksgiving-holiday'),
    'anthropic said to target mega ipo before thanksgiving')
})

// ---------- service: live read + cache ----------
const service = createService({ dataDir: path.join(tmpRoot, 'service') }, () => {})
let liveArticle = null
await test('service.read reads a partner article directly (live network)', async () => {
  const result = await service.read(PARTNER_ARTICLE, {})
  assert.ok(result.ok, 'read ok')
  assert.ok(result.article.body.length > 500, 'body length ' + (result.article && result.article.body.length))
  assert.ok(bodyLooksReal(result.article.body, phraseOf(PARTNER_ARTICLE)), 'body looks real')
  liveArticle = result.article
})
await test('service.read returns the cached article on second call', async () => {
  const result = await service.read(PARTNER_ARTICLE, {})
  assert.ok(result.ok)
  assert.equal(result.cached, true)
  assert.equal(result.article.title, liveArticle.title)
})
await test('reader resolves Google News links to publisher URLs (live network)', async () => {
  const proxy = detectSystemProxy()
  let g = null
  for (let attempt = 0; attempt < 3 && !g; attempt += 1) {
    try { g = await fetchText('https://news.google.com/rss/search?q=when:24h+source:Reuters&hl=en-US&gl=US&ceid=US:en', { proxy: proxy, timeoutMs: 15000, retries: 1 }) } catch (e) { await new Promise((r) => setTimeout(r, 1200)) }
  }
  assert.ok(g, 'google news rss reachable')
  const items = parseGoogleNews(g.text, { id: 'g', name: 'G' })
  assert.ok(items.length > 0, 'google news items')
  assert.ok(items[0].readHint === items[0].title, 'readHint mirrors title')
  let resolved = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800))
    resolved = await resolveGoogleNewsUrl(items[0].url, { proxy: proxy })
    if (/^https?:/i.test(resolved)) break
  }
  assert.ok(/^https?:/i.test(resolved), 'resolved url: ' + resolved)
  assert.ok(!/news\.google\.com/i.test(resolved), 'publisher url, not a google redirect')
})

await test('service.feed aggregates the multi-source wire (live network)', async () => {
  const feed = await service.feed(true)
  assert.ok(Array.isArray(feed.items) && feed.items.length > 20, 'items ' + (feed.items && feed.items.length))
  assert.ok(feed.items[0].title && /^https?:/.test(feed.items[0].url))
  assert.ok(Array.isArray(feed.sources) && feed.sources.length >= 10, 'sources ' + (feed.sources && feed.sources.length))
  const ok = feed.sources.filter((s) => s.ok)
  assert.ok(ok.length >= 4, 'healthy sources ' + ok.length + '/' + feed.sources.length)
  assert.ok(ok.some((s) => s.type === 'rss'), 'has rss source')
  assert.ok(feed.sources.some((s) => s.id === 'reuters'), 'reuters source registered')
  assert.ok(feed.sources.some((s) => s.type === 'google-news'), 'google-news source registered')
  assert.ok(feed.sources.some((s) => s.type === 'rsshub'), 'rsshub source registered')
  assert.ok(feed.sources.every((s) => typeof s.ms === 'number' && s.ms >= 0), 'latency recorded per source')
})

await test('service.netTest reports status for a real feed URL', async () => {
  const result = await service.netTest('https://www.bnnbloomberg.ca/arc/outboundfeeds/rss/')
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 200))
  assert.equal(result.status, 200)
  assert.ok(result.chars > 1000)
  assert.ok(typeof result.ms === 'number' && result.ms > 0)
})

await test('service.quotes returns the whole watchlist from one batched source', async () => {
  const first = await service.quotes(true)
  assert.ok(Array.isArray(first.quotes) && first.quotes.length >= 14, 'quotes ' + (first.quotes && first.quotes.length))
  assert.equal(first.cached, false)
  assert.ok(first.sources.some((s) => s.name === 'tradingview' && s.ok), JSON.stringify(first.sources))
  for (const quote of first.quotes) {
    assert.ok(quote.price > 0, 'price for ' + quote.id)
    assert.ok(typeof quote.changePct === 'number', 'pct for ' + quote.id)
  }
  const cached = await service.quotes(false)
  assert.equal(cached.cached, true)
  assert.equal(cached.quotes.length, first.quotes.length)
})

await test('service.quotes single-flights concurrent refreshes', async () => {
  const svc = createService({ dataDir: path.join(tmpRoot, 'singleflight') }, () => {})
  let calls = 0
  const fake = {
    name: 'fake',
    supports: () => true,
    async fetch(targets) {
      calls += 1
      await new Promise((r) => setTimeout(r, 120))
      const out = new Map()
      for (const item of targets) out.set(item.id, { id: item.id, label: item.label, symbol: item.id, price: 10, changePct: 1, changeAbs: 0.1, volume: 1, open: 9.9, high: 10.1, low: 9.8, prevClose: 9.9, currency: '', source: 'fake', ts: Date.now() })
      return out
    },
  }
  const [a, b] = await Promise.all([svc.quotes(true, { providers: [fake] }), svc.quotes(true, { providers: [fake] })])
  assert.equal(calls, 1, 'one provider call for two concurrent refreshes')
  assert.ok(a.quotes.length > 0 && b.quotes.length > 0)
})

await test('service.quotes trips a breaker after repeated failures', async () => {
  const svc = createService({ dataDir: path.join(tmpRoot, 'breaker') }, () => {})
  let calls = 0
  const broken = { name: 'broken', supports: () => true, async fetch() { calls += 1; throw new Error('blocked') } }
  const first = await svc.quotes(true, { providers: [broken] })
  assert.equal(first.degraded, true)
  const second = await svc.quotes(true, { providers: [broken] })
  assert.equal(second.degraded, true)
  assert.equal(calls, 2)
  const third = await svc.quotes(true, { providers: [broken] })
  assert.equal(calls, 2, 'breaker skips live fetch')
  assert.equal(third.degraded, true)
})

await test('service.history returns intraday and daily series', async () => {
  const intraday = await service.history('spx', '1d', true)
  assert.equal(intraday.ok, true)
  assert.ok(Array.isArray(intraday.points) && intraday.points.length > 20, 'points ' + (intraday.points && intraday.points.length))
  assert.ok(intraday.high >= intraday.low)
  assert.ok(['eastmoney', 'okx', 'yahoo'].indexOf(intraday.source) >= 0)
  const cached = await service.history('spx', '1d', false)
  assert.equal(cached.cached, true)
  const month = await service.history('spx', '1mo', true)
  assert.equal(month.ok, true)
  assert.ok(month.points.length > 5, 'month points ' + (month.points && month.points.length))
  const unknown = await service.history('nope', '1d', true)
  assert.equal(unknown.ok, false)
})

await test('store clamps quote refresh to the fast range', async () => {
  const svc = createService({ dataDir: path.join(tmpRoot, 'refresh-clamp') }, () => {})
  svc.updateSettings({ quoteRefreshSec: 2 })
  assert.equal(svc.settings().quoteRefreshSec, 3)
  svc.updateSettings({ quoteRefreshSec: 999 })
  assert.equal(svc.settings().quoteRefreshSec, 300)
  assert.equal(svc.settings().quoteRefreshSec <= 10, false, 'max is higher when user relaxes')
})

await test('feed item reads end-to-end with its title as hint', async () => {
  const data = await service.feed(false)
  const item = (data.items || []).find((x) => /CNBC/.test(x.source)) || (data.items || []).find((x) => /Bloomberg/.test(x.source)) || (data.items || [])[0]
  assert.ok(item, 'has a feed item')
  const result = await service.read(item.url, { title: item.title })
  assert.equal(result.ok, true, 'read failed for ' + item.source + ' ' + item.url)
  assert.ok(result.article.body.length > 350)
  assert.ok(result.article.title)
})

// ---------- HTTP harness ----------
const handler = createHandler(service)
const server = http.createServer(handler)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const origin = 'http://127.0.0.1:' + port

async function jsonApi(pathname, options) {
  const opts = options || {}
  const res = await fetch(origin + pathname, {
    method: opts.method || 'GET',
    headers: Object.assign({}, GATE, opts.body ? { 'content-type': 'application/json' } : {}),
    body: opts.body,
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

await test('HTTP: panel UI is served', async () => {
  const res = await fetch(origin + '/market-info/ui')
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes('资讯流'), 'ui html marker')
  assert.ok(html.includes('搜索转载'), 'search tab marker')
  const js = await fetch(origin + '/market-info/ui/app.js')
  assert.equal(js.status, 200)
  assert.ok((await js.text()).includes('market-info/api'))
})
await test('HTTP: API rejects requests without the gate header', async () => {
  const res = await fetch(origin + '/market-info/api/status')
  assert.equal(res.status, 403)
})
await test('HTTP: /api/status reports cache + settings + keywords + feeds', async () => {
  const { status, body } = await jsonApi('/market-info/api/status')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(body.cache.dataDir)
  assert.ok(Array.isArray(body.settings.feeds) && body.settings.feeds.length >= 1)
  assert.ok(Array.isArray(body.settings.keywords))
  assert.ok(body.settings.antiBlock && body.settings.antiBlock.enabled === true)
  assert.ok(typeof body.settings.antiBlock.retries === 'number')
})
await test('HTTP: /api/feed returns headlines and supports keyword filter', async () => {
  const all = await jsonApi('/market-info/api/feed?refresh=1')
  assert.equal(all.status, 200)
  assert.ok(Array.isArray(all.body.items) && all.body.items.length > 0)
  const word = String(all.body.items[0].title).split(/\s+/).find((w) => w.length > 3)
  assert.ok(word, 'sample keyword: ' + word)
  const filtered = await jsonApi('/market-info/api/feed?refresh=1&kw=' + encodeURIComponent(word))
  assert.equal(filtered.status, 200)
  assert.ok(filtered.body.items.length <= all.body.items.length)
  for (const item of filtered.body.items) {
    const hay = (item.title + ' ' + item.summary).toLowerCase()
    assert.ok(hay.includes(word.toLowerCase()), 'item matches keyword: ' + item.title)
  }
})
await test('HTTP: /api/presets exposes the recommended catalogue', async () => {
  const { status, body } = await jsonApi('/market-info/api/presets')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.presets) && body.presets.length >= 10, 'presets ' + (body.presets && body.presets.length))
  assert.ok(body.presets.some((p) => p.id === 'reuters' && p.type === 'bing-news'), 'reuters preset')
  assert.ok(body.presets.some((p) => p.type === 'wallstcn'), 'chinese preset')
  assert.ok(body.presets.some((p) => p.type === 'google-news'), 'google-news preset')
  assert.ok(body.presets.some((p) => p.type === 'rsshub'), 'rsshub preset')
})

await test('HTTP: /api/feed category and source filters', async () => {
  const byCat = await jsonApi('/market-info/api/feed?cat=' + encodeURIComponent('中文'))
  assert.equal(byCat.status, 200)
  for (const item of byCat.body.items) assert.equal(item.category, '中文')
  const bySrc = await jsonApi('/market-info/api/feed?src=reuters')
  assert.equal(bySrc.status, 200)
  assert.ok(Array.isArray(bySrc.body.sources) && bySrc.body.sources.some((s) => s.id === 'reuters'))
  for (const item of bySrc.body.items) assert.equal(item.sourceId, 'reuters')
})

await test('HTTP: /api/health reports per-source statistics', async () => {
  const { status, body } = await jsonApi('/market-info/api/health')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.sources) && body.sources.length >= 10, 'health rows ' + (body.sources && body.sources.length))
  const counted = body.sources.filter((s) => s.attempts > 0)
  assert.ok(counted.length >= 10, 'counted sources ' + counted.length)
  assert.ok(counted.some((s) => s.avgMs > 0), 'avg latency recorded')
  assert.ok(counted.every((s) => s.successRate >= 0 && s.successRate <= 1))
  assert.ok(['ok', 'warn', 'fail', 'unknown'].includes(counted[0].status))
})

await test('HTTP: source list export + import round-trip', async () => {
  const res = await fetch(origin + '/market-info/api/feeds/export', { headers: GATE })
  assert.equal(res.status, 200)
  assert.ok((res.headers.get('content-type') || '').includes('application/json'))
  assert.ok((res.headers.get('content-disposition') || '').includes('attachment; filename='))
  const payload = await res.json()
  assert.equal(payload.format, 'market-info-feeds')
  assert.equal(payload.version, 1)
  assert.ok(Array.isArray(payload.feeds) && payload.feeds.length >= 10)
  assert.ok(typeof payload.rsshubBase === 'string' && payload.rsshubBase.startsWith('http'))

  const partial = payload.feeds.slice(0, 3)
  const imported = await jsonApi('/market-info/api/feeds/import', { method: 'POST', body: JSON.stringify({ feeds: partial, rsshubBase: payload.rsshubBase }) })
  assert.equal(imported.status, 200)
  assert.equal(imported.body.ok, true)
  assert.equal(imported.body.imported, 3)
  const listed = await jsonApi('/market-info/api/feeds')
  assert.equal(listed.body.feeds.length, 3)

  const bad = await fetch(origin + '/market-info/api/feeds/import', {
    method: 'POST',
    headers: Object.assign({}, GATE, { 'content-type': 'application/json' }),
    body: 'definitely-not-json',
  })
  assert.equal(bad.status, 400)

  const reset = await jsonApi('/market-info/api/feeds', { method: 'POST', body: JSON.stringify({ feeds: [] }) })
  assert.ok(reset.body.feeds.length >= 10, 'defaults restored')
})

await test('HTTP: /api/net/test reports anti-block diagnostics', async () => {
  const target = encodeURIComponent('https://www.bnnbloomberg.ca/arc/outboundfeeds/rss/')
  const { status, body } = await jsonApi('/market-info/api/net/test?u=' + target)
  assert.equal(status, 200)
  assert.equal(body.ok, true, JSON.stringify(body).slice(0, 200))
  assert.equal(body.status, 200)
  assert.equal(body.blocked, false)
  assert.ok(body.chars > 1000)
  const bad = await jsonApi('/market-info/api/net/test?u=not-a-url')
  assert.equal(bad.status, 200)
  assert.equal(bad.body.ok, false)
})

await test('HTTP: antiBlock settings persist', async () => {
  const saved = await jsonApi('/market-info/api/settings', {
    method: 'POST',
    body: JSON.stringify({ antiBlock: { retries: 3, hostIntervalMs: 120, autoFallback: false, proxyPool: ['http://127.0.0.1:8801'], readerProxy: '' } }),
  })
  assert.equal(saved.body.settings.antiBlock.retries, 3)
  assert.equal(saved.body.settings.antiBlock.autoFallback, false)
  assert.equal(saved.body.settings.antiBlock.proxyPool.length, 1)
  const got = await jsonApi('/market-info/api/status')
  assert.equal(got.body.settings.antiBlock.hostIntervalMs, 120)
  await jsonApi('/market-info/api/settings', { method: 'POST', body: JSON.stringify({ antiBlock: { retries: 1, hostIntervalMs: 0, autoFallback: true, proxyPool: [] } }) })
})

await test('HTTP: /api/search returns ranked candidates (live network)', async () => {
  const res = await jsonApi('/market-info/api/search?q=' + encodeURIComponent('Anthropic targets mega-IPO before Thanksgiving'))
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.ok(Array.isArray(res.body.results), 'results array')
  if (res.body.results.length > 0) {
    assert.ok(res.body.results[0].url && res.body.results[0].title)
    assert.ok(res.body.results[0].score > 0)
  }
})
await test('HTTP: /api/read serves the cached article', async () => {
  const { status, body } = await jsonApi('/market-info/api/read?u=' + encodeURIComponent(PARTNER_ARTICLE) + '&t=' + encodeURIComponent('Anthropic targets mega-IPO before Thanksgiving holiday'))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.cached, true)
  assert.ok(body.article.body.length > 500)
})
await test('HTTP: /api/export returns a markdown attachment', async () => {
  const res = await fetch(origin + '/market-info/api/export?u=' + encodeURIComponent(PARTNER_ARTICLE), { headers: GATE })
  assert.equal(res.status, 200)
  assert.ok((res.headers.get('content-type') || '').includes('text/markdown'))
  assert.ok((res.headers.get('content-disposition') || '').includes('attachment; filename='))
  const md = await res.text()
  assert.ok(md.startsWith('# '), 'markdown title header')
  assert.ok(md.includes('转载来源') && md.includes('原始链接'))
  assert.ok(md.length > 600)
})
await test('HTTP: favorites toggle + list + remove', async () => {
  const add = await jsonApi('/market-info/api/favorites', { method: 'POST', body: JSON.stringify({ article: liveArticle }) })
  assert.equal(add.status, 200)
  assert.equal(add.body.added, true)
  const list = await jsonApi('/market-info/api/favorites')
  assert.equal(list.body.items.length, 1)
  assert.equal(list.body.items[0].url, PARTNER_ARTICLE)
  const remove = await jsonApi('/market-info/api/favorites', { method: 'POST', body: JSON.stringify({ remove: true, url: PARTNER_ARTICLE }) })
  assert.equal(remove.body.items.length, 0)
})
await test('HTTP: feeds manager add + list + reset', async () => {
  const added = await jsonApi('/market-info/api/feeds', { method: 'POST', body: JSON.stringify({ feeds: [{ id: 'bnn', name: 'BNN Bloomberg', url: BNN_RSS }] }) })
  assert.equal(added.status, 200)
  assert.equal(added.body.feeds.length, 1)
  assert.equal(added.body.feeds[0].url, BNN_RSS)
  const listed = await jsonApi('/market-info/api/feeds')
  assert.equal(listed.body.feeds.length, 1)
  const reset = await jsonApi('/market-info/api/feeds', { method: 'POST', body: JSON.stringify({ feeds: [] }) })
  assert.ok(reset.body.feeds.length >= 10, 'defaults come back when the custom list is cleared (' + reset.body.feeds.length + ')')
})
await test('HTTP: /api/quotes serves cached market data', async () => {
  const { status, body } = await jsonApi('/market-info/api/quotes?refresh=1')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.quotes) && body.quotes.length >= 14, 'quotes ' + (body.quotes && body.quotes.length))
  assert.ok(body.sources.some((s) => s.name === 'tradingview' && s.ok))
  const cached = await jsonApi('/market-info/api/quotes')
  assert.equal(cached.body.cached, true)
})

await test('HTTP: /api/history serves chart series', async () => {
  const { status, body } = await jsonApi('/market-info/api/history?id=spx&range=1d&refresh=1')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.id, 'spx')
  assert.equal(body.range, '1d')
  assert.ok(Array.isArray(body.points) && body.points.length > 20)
  const cached = await jsonApi('/market-info/api/history?id=spx&range=1d')
  assert.equal(cached.body.cached, true)
})

await test('HTTP: UI ships the chart drawer markup', async () => {
  const res = await fetch(origin + '/market-info/ui')
  const html = await res.text()
  assert.ok(html.includes('quoteDetail'))
  assert.ok(html.includes('detailChart'))
  assert.ok(html.includes('data-range="1y"'))
  const app = await (await fetch(origin + '/market-info/ui/app.js')).text()
  assert.ok(app.includes('item.readHint || item.title'), 'feed clicks pass the headline as read hint')
  assert.ok(app.includes('summaryHint'), 'feed clicks pass the summary as a fallback')
  assert.ok(app.includes('summaryFallback'), 'summary fallback renders when full text cannot be found')
})

await test('HTTP: watchlist + quote refresh settings persist', async () => {
  const before = await jsonApi('/market-info/api/status')
  const original = before.body.settings.watchlist
  assert.ok(Array.isArray(original) && original.length >= 16)
  const next = original.concat([{ id: 'nvda', label: 'NVDA', tv: 'NASDAQ:NVDA', yahoo: 'NVDA' }])
  const saved = await jsonApi('/market-info/api/settings', { method: 'POST', body: JSON.stringify({ watchlist: next, quoteRefreshSec: 120 }) })
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.settings.watchlist.length, original.length + 1)
  assert.equal(saved.body.settings.quoteRefreshSec, 120)
  const clamped = await jsonApi('/market-info/api/settings', { method: 'POST', body: JSON.stringify({ quoteRefreshSec: 2 }) })
  assert.equal(clamped.body.settings.quoteRefreshSec, 3)
  const after = await jsonApi('/market-info/api/status')
  assert.ok(after.body.settings.watchlist.some((x) => x.id === 'nvda'))
  await jsonApi('/market-info/api/settings', { method: 'POST', body: JSON.stringify({ watchlist: original, quoteRefreshSec: 60 }) })
})

await test('HTTP: settings update keywords + caps, cache clear', async () => {
  const saved = await jsonApi('/market-info/api/settings', { method: 'POST', body: JSON.stringify({ maxItems: 1000, keywords: ['AI', 'markets'] }) })
  assert.equal(saved.body.settings.maxItems, 1000)
  assert.deepEqual(saved.body.settings.keywords, ['AI', 'markets'])
  const got = await jsonApi('/market-info/api/status')
  assert.deepEqual(got.body.settings.keywords, ['AI', 'markets'])
  const cleared = await jsonApi('/market-info/api/cache', { method: 'POST' })
  assert.equal(cleared.body.cache.items, 0)
  assert.equal(cleared.body.cache.bytes, 0)
})

server.close()
fs.rmSync(tmpRoot, { recursive: true, force: true })

console.log(results.join('\n'))
console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exit(1)
