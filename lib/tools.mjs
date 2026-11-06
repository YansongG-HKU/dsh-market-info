/** Model-facing tool definitions for the dsh-market-info panel. */
const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const ERROR_REPAIR = {
  action: 'retry',
  label: 'Retry once',
  detail: 'The plugin returned a structured error envelope instead of throwing.',
}

const FEED_DESCRIPTION =
  'List the latest business-news headlines from Bloomberg syndication partners (BNN Bloomberg, Economic Times, ...). ' +
  'Returns title/url/source/date only — no article bodies. Optional keywords filter titles/summaries. ' +
  'Use ml_read on a url to get the full text.'

const READ_DESCRIPTION =
  'Turn a news URL into a readable full-text article. For a Bloomberg URL it searches licensed syndication copies ' +
  '(Yahoo Finance SG, Business Times SG, The Edge, Economic Times, ...) and extracts the body; for partner URLs it ' +
  'reads the page directly. Pass the headline in title so the fallback search can find syndicated copies when the original is paywalled or blocked. Text-only output, cached with strict size limits.'

const SEARCH_DESCRIPTION =
  'Search the web for a headline or phrase and return ranked candidate article URLs from Bloomberg syndication ' +
  'partners (Yahoo Finance SG, Business Times SG, The Edge, Economic Times, ...). Use it to find a readable copy, ' +
  'then ml_read the best url.'

const integer = (description) => ({ type: 'integer', description: description })
const string = (description) => ({ type: 'string', description: description })
const boolean = (description) => ({ type: 'boolean', description: description })

export function createTools(options) {
  const opts = options || {}
  const service = opts.service
  const log = opts.log || {}
  const lossless = (value) => {
    if (value === undefined) return null
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return { ok: false, error: 'not serializable' }
    }
  }
  const wrapped = (execute) => async (args) => {
    try {
      return lossless(await execute(args || {}))
    } catch (error) {
      try {
        log.warn && log.warn('tool failed: ' + String(error && error.message ? error.message : error))
      } catch {}
      return { ok: false, error: String(error && error.message ? error.message : error), repair: ERROR_REPAIR }
    }
  }
  const definitions = []
  definitions.push({
    name: 'ml_feed',
    description: FEED_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        limit: integer('Max headlines to return (1-100, default 20).'),
        keywords: string('Comma-separated keyword filter over title/summary (default: saved keywords).'),
        category: string('Category filter, e.g. 通讯社 / 美股 / 国际 / 深度 / 市场 / 中文.'),
        source: string('Source filter, e.g. reuters / bbg / cnbc / 华尔街见闻 (sourceId or source name).'),
        refresh: boolean('Bypass the 30 min in-memory feed cache.'),
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: wrapped(async (args) => {
      const keywords = typeof args.keywords === 'string'
        ? args.keywords.split(',').map((w) => w.trim()).filter(Boolean)
        : undefined
      const data = await service.feed(args.refresh === true, {
        keywords: keywords,
        category: typeof args.category === 'string' ? args.category : '',
        source: typeof args.source === 'string' ? args.source : '',
      })
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
      return {
        ok: true,
        cached: data.cached === true,
        fetchedAt: data.fetchedAt || null,
        keywords: data.keywords || [],
        category: data.category || '',
        source: data.source || '',
        sources: data.sources || [],
        items: (data.items || []).slice(0, limit).map((item) => ({
          title: item.title,
          url: item.url,
          source: item.source,
          date: item.date,
          creator: item.creator || '',
        })),
      }
    }),
  })
  definitions.push({
    name: 'ml_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: string('Headline, phrase or keyword to search for.'),
        limit: integer('Max candidates to return (1-20, default 10).'),
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: wrapped(async (args) => {
      const result = await service.search(args.query)
      if (!result.ok) return result
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20)
      return { ok: true, query: result.query, results: (result.results || []).slice(0, limit) }
    }),
  })
  definitions.push({
    name: 'ml_read',
    description: READ_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        url: string('Article URL (Bloomberg, partner or Google News headline link).'),
        title: string('Optional headline hint; required for Google News links to resolve the full text.'),
        refresh: boolean('Bypass the local text cache and re-fetch.'),
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: wrapped(async (args) => {
      const url = String(args.url || '')
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url must be http(s)' }
      const result = await service.read(url, { refresh: args.refresh === true, title: typeof args.title === 'string' ? args.title : '' })
      if (!result.ok) {
        return { ok: false, error: 'no readable copy', candidates: (result.candidates || []).slice(0, 10) }
      }
      const article = result.article
      return {
        ok: true,
        cached: result.cached === true,
        title: article.title,
        sourceUrl: article.sourceUrl,
        sourceHost: article.sourceHost,
        original: article.original,
        chars: article.body.length,
        body: article.body,
      }
    }),
  })
  definitions.push({
    name: 'ml_quotes',
    description:
      'Get current market quotes (indices, FX, rates, commodities, crypto, stocks) from public quote endpoints: ' +
      'TradingView scanner (batched primary), Tencent, Yahoo Finance and CoinGecko fallbacks. Refreshes on a fast 5s cadence with a 2s floor cache, automatically backs off on failures; pass refresh=true only when the user explicitly asks for a live refresh.',
    parameters: {
      type: 'object',
      properties: {
        refresh: boolean('Bypass the quote cache and force a live refresh.'),
        symbols: string('Optional comma-separated watch ids to keep, e.g. spx,btc,us10y (default: all watchlist items).'),
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: wrapped(async (args) => {
      const data = await service.quotes(args.refresh === true)
      const wanted = typeof args.symbols === 'string'
        ? args.symbols.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        : []
      let quotes = data.quotes || []
      if (wanted.length) quotes = quotes.filter((q) => wanted.includes(String(q.id).toLowerCase()))
      return {
        ok: true,
        cached: data.cached === true,
        fetchedAt: data.fetchedAt || null,
        missing: data.missing || [],
        sources: data.sources || [],
        quotes: quotes,
      }
    }),
  })
  return definitions
}
