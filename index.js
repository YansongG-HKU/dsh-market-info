/**
 * dsh-market-info — Host plugin entry.
 *
 * Decorates live Agents with four small tools (ml_feed / ml_search / ml_read / ml_quotes) plus one
 * short system-prompt section, and registers the panel HTTP surface through the
 * optional webServer service (so headless profiles still work). Nothing here
 * throws: a broken config or missing webServer degrades to fewer registrations.
 */
import { createService } from './lib/service.mjs'
import { createHandler, ROUTE_PREFIX } from './lib/routes.mjs'
import { createTools } from './lib/tools.mjs'

/** Harness service decorated by this plugin. */
export const inject = ['agents']
/** Package name (also the loader row id and panel key). */
export const name = 'dsh-market-info'

const PROMPT_TEXT =
  '市场资讯面板（dsh-market-info）已启用：ml_feed 拉取 19 个新闻源头条（Reuters / Bloomberg / CNBC / WSJ / FT / BBC / 华尔街见闻 / 东方财富 / 36氪 / Google News 等，' +
  '可按关键词、分类、来源过滤），ml_search 搜索转载候选，' +
  '设置页有源健康度/延迟统计、数据源 JSON 导入导出、Google News 与 RSSHub 支持、反爬/反封锁设置（UA 轮换、重试、代理池、源兜底、抓取诊断），' +
  'ml_read 把任意新闻/彭博文章 URL 转成可读全文（走授权转载副本，纯文本、带严格缓存上限），' +
  'ml_quotes 取行情（TradingView 批量主源 + 腾讯/Yahoo/CoinGecko 兜底，5 秒级刷新、失败自动降频）；点开任一标的看分时/日线走势（Eastmoney/OKX/Yahoo 历史）。' +
  '侧边栏「市场资讯」面板提供资讯流/行情/阅读/搜索/收藏/设置，行情条常驻顶部。'

export function apply(ctx, config) {
  const log = {
    info: (message) => write(ctx, 'info', message),
    warn: (message) => write(ctx, 'warn', message),
  }
  let service
  try {
    service = createService(config, (message) => log.info(message))
  } catch (error) {
    log.warn('could not build the service; plugin inactive: ' + messageOf(error))
    return () => {}
  }

  const bindings = new Map()
  const decorate = (agent) => {
    try {
      if (!agent || !agent.id || bindings.has(agent.id)) return
      if (!agent.ctx || !agent.ctx.tools || typeof agent.ctx.tools.register !== 'function') return
      const disposers = []
      try {
        for (const definition of createTools({ service: service, log: log })) {
          disposers.push(agent.ctx.tools.register(definition))
        }
        if (agent.ctx.systemPrompt && typeof agent.ctx.systemPrompt.section === 'function') {
          const dispose = agent.ctx.systemPrompt.section({
            name: 'dsh-market-info',
            order: 9200,
            interpolate: false,
            text: () => PROMPT_TEXT,
          })
          if (typeof dispose === 'function') disposers.push(dispose)
        }
      } catch (error) {
        for (const dispose of disposers.splice(0)) safeDispose(dispose)
        log.warn('could not decorate ' + agent.id + ': ' + messageOf(error))
        return
      }
      bindings.set(agent.id, {
        dispose() {
          for (const dispose of disposers.splice(0)) safeDispose(dispose)
        },
      })
    } catch (error) {
      log.warn('decoration failed: ' + messageOf(error))
    }
  }

  try {
    ctx.on('agent/created', (payload) => decorate(payload && payload.agent))
    ctx.on('agent/disposed', (payload) => {
      const agent = payload && payload.agent
      const binding = bindings.get(agent && agent.id)
      if (!binding) return
      binding.dispose()
      bindings.delete(agent.id)
    })
  } catch (error) {
    log.warn('could not subscribe to agent lifecycle: ' + messageOf(error))
  }
  try {
    for (const agent of ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []) decorate(agent)
  } catch (error) {
    log.warn('could not enumerate live agents: ' + messageOf(error))
  }

  let panel = null
  try {
    panel = registerPanel(ctx, service)
  } catch (error) {
    log.warn('could not register panel routes: ' + messageOf(error))
  }

  log.info('active: panel at ' + ROUTE_PREFIX + ', 4 tools + prompt section per agent')

  return () => {
    for (const binding of bindings.values()) binding.dispose()
    bindings.clear()
    if (typeof panel === 'function') safeDispose(panel)
  }
}

function registerPanel(ctx, service) {
  if (!ctx || typeof ctx.inject !== 'function') return null
  return ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx && webCtx.webServer
    if (!webServer || typeof webServer.register !== 'function') return null
    return webCtx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createHandler(service),
      }),
    )
  })
}

function write(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level]('[dsh-market-info] ' + message)
  } catch {}
}

function safeDispose(dispose) {
  try {
    if (typeof dispose === 'function') dispose()
  } catch {}
}

function messageOf(error) {
  return String(error && error.message ? error.message : error)
}
