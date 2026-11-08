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
  definitions.push({
    name: 'ml_filings',
    description:
      'Official corporate filings and disclosures — the primary-source layer no news site can replace. ' +
      'Covers CN (cninfo/SSE/SZSE), HK (HKEXnews) and US (SEC EDGAR full-text search and XBRL frames). ' +
      'Returns title, url, publishedAt, source and a short summary; open `url` for the original document. ' +
      'Use `query` for full-text search and `source` to pin one registry (ids: cninfo, sse, szse, hkex, sec-fulltext, sec-xbrl).',
    parameters: {
      type: 'object',
      properties: {
        query: string('Full-text query, e.g. a company name, ticker, or phrase like "回购" / "8-K".'),
        source: string('Optional registry id to restrict to one source.'),
        limit: integer('Max rows (1-60, default 20).'),
        refresh: boolean('Bypass the per-source cache.'),
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: wrapped(async (args) => {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 60)
      const data = await service.collect({
        categories: ['filing'],
        ids: typeof args.source === 'string' && args.source ? [args.source] : undefined,
        limit: limit,
        params: { q: typeof args.query === 'string' ? args.query : '' },
        refresh: args.refresh === true,
      })
      return {
        ok: true,
        fetchedAt: data.fetchedAt || null,
        ms: data.ms || 0,
        sources: data.sources || [],
        items: (data.items || []).slice(0, limit).map((item) => ({
          title: item.title,
          url: item.url,
          source: item.source,
          region: item.region,
          date: item.publishedAt ? new Date(item.publishedAt).toISOString() : null,
          summary: item.summary || '',
        })),
      }
    }),
  })
  definitions.push({
    name: 'ml_macro',
    description:
      'Macro releases and policy actions from official publishers (Fed, ECB, BLS, FRED, US Treasury, PBoC, NBS, ' +
      'Customs, SAFE, CFETS), plus flow / structure / derivative / world data: CFTC positioning, Cboe volatility, ' +
      'OFAC sanctions, 沪深港通 top trades, margin financing, the daily billboard (龙虎榜), industry/concept sector ' +
      'rotation, domestic and overseas futures, prediction-market probabilities (Polymarket / Kalshi / Manifold / ' +
      'Metaculus), shipping (BDI dry-bulk index, wave height at Malacca / Suez / Panama / Cape of Good Hope) and ' +
      'world monitor feeds (GDELT conflict & sanctions news, NASA EONET natural hazards, rainfall/temperature for ' +
      'China main agricultural regions). Returns dated headline rows with source and region.',
    parameters: {
      type: 'object',
      properties: {
        region: string('Comma-separated regions: CN, US, EU, JP, HK, GLOBAL.'),
        category: string('Comma-separated categories: macro, policy, flow, sanction, volatility, industry, futures, prediction, shipping, geo, weather. Default macro,policy.'),
        tiers: string('Comma-separated refresh cadences: T0 (real-time), T1 (fast), T2 (hourly), T3 (daily/weekly). Use T0,T1 to ask only what changes within minutes.'),
        domain: string('Comma-separated domains: pricing (what things cost), funding (where money moves), issuer (what companies disclose), macro (the backdrop), risk (what can break), real (physical economy), wire (latest headlines).'),
        limit: integer('Max rows (1-60, default 20).'),
        refresh: boolean('Bypass the per-source cache.'),
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: wrapped(async (args) => {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 60)
      const tiers = typeof args.tiers === 'string' && args.tiers
        ? args.tiers.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
        : []
      // Asking for a cadence tier is a "what moved just now" question, so it spans
      // every category unless the caller narrowed it themselves.
      const categories = typeof args.category === 'string' && args.category
        ? args.category.split(',').map((s) => s.trim()).filter(Boolean)
        : tiers.length
          ? []
          : ['macro', 'policy']
      const regions = typeof args.region === 'string' && args.region
        ? args.region.split(',').map((s) => s.trim()).filter(Boolean)
        : []
      const domains = typeof args.domain === 'string' && args.domain
        ? args.domain.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        : []
      const data = await service.collect({ categories: categories, regions: regions, tiers: tiers, domains: domains, limit: limit })
      return {
        ok: true,
        fetchedAt: data.fetchedAt || null,
        ms: data.ms || 0,
        sources: data.sources || [],
        items: (data.items || []).slice(0, limit).map((item) => ({
          title: item.title,
          url: item.url,
          source: item.source,
          category: item.category,
          region: item.region,
          date: item.publishedAt ? new Date(item.publishedAt).toISOString() : null,
          summary: item.summary || '',
        })),
      }
    }),
  })
  definitions.push({
    name: 'ml_brief',
    description:
      'One call for "what happened": a deterministic digest over the official-source plane grouped by category ' +
      '(filing / macro / policy / flow / sanction / volatility), with a count of rows that are new since the ' +
      'previous brief. No model call inside — it is cheap to poll. Use it before ml_feed when the question is ' +
      'about primary sources rather than news.',
    parameters: {
      type: 'object',
      properties: {
        limit: integer('Rows to consider (20-400, default 120).'),
        refresh: boolean('Bypass the per-source cache.'),
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: wrapped(async (args) => {
      const data = await service.brief({
        limit: Number(args.limit) || 120,
        refresh: args.refresh === true,
      })
      const groups = {}
      for (const [key, rows] of Object.entries(data.groups || {})) {
        groups[key] = (rows || []).slice(0, 6).map((item) => ({
          title: item.title,
          url: item.url,
          source: item.source,
          region: item.region,
          date: item.publishedAt ? new Date(item.publishedAt).toISOString() : null,
        }))
      }
      return {
        ok: true,
        fetchedAt: data.fetchedAt,
        ms: data.ms,
        total: data.total,
        newCount: data.newCount,
        firstRun: data.firstRun,
        groups: groups,
        sources: data.sources || [],
      }
    }),
  })
  definitions.push({
    name: 'ml_company',
    description:
      'Company dossier for one issuer: resolves a name, pinyin or ticker to an entity (A-share / HK / US), then ' +
      'returns the live quote, the last 8 reporting periods of THS financial indicators, the newest official ' +
      'filings (cninfo / SSE / SZSE / SEC) and the newest sell-side report summaries. Use it whenever the question ' +
      'is about a specific company rather than the market; the payload includes `legs` so you can see which source ' +
      'returned nothing and why.',
    parameters: {
      type: 'object',
      properties: {
        query: string('Company name, pinyin, or ticker — e.g. "贵州茅台", "600519", "腾讯", "AAPL".'),
        limit: integer('Max filings (5-40, default 20).'),
        from: string('Optional start date YYYY-MM-DD for filings and reports.'),
        to: string('Optional end date YYYY-MM-DD.'),
        refresh: boolean('Bypass the 15s quote cache and refetch.'),
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: wrapped(async (args) => {
      const result = await service.company(String(args.query || ''), {
        limit: Number(args.limit) || 20,
        from: typeof args.from === 'string' ? args.from : '',
        to: typeof args.to === 'string' ? args.to : '',
        refresh: args.refresh === true,
      })
      if (!result.ok) return result
      return {
        ok: true,
        query: result.query,
        entity: result.entity,
        candidates: result.candidates,
        quote: result.quote,
        finance: result.finance
          ? {
              periods: result.finance.periods,
              rows: result.finance.rows.map((row) => ({
                name: row.name,
                unit: row.unit,
                latest: row.latest,
                prev: row.prev,
              })),
            }
          : null,
        peers: result.peers
          ? {
              industry: result.peers.industry,
              rows: result.peers.rows.map((row) => ({
                code: row.code,
                name: row.name,
                changePct: row.changePct,
                marketCap: row.marketCap,
              })),
            }
          : null,
        filings: result.filings.map((item) => ({
          title: item.title,
          url: item.url,
          date: item.publishedAt ? new Date(item.publishedAt).toISOString() : null,
          source: item.source,
        })),
        reports: result.reports.map((item) => ({
          title: item.title,
          url: item.url,
          date: item.publishedAt ? new Date(item.publishedAt).toISOString() : null,
          summary: item.summary || '',
        })),
        legs: result.legs,
        ms: result.ms,
      }
    }),
  })
  return definitions
}
