/**
 * Plugin wiring test: exercise the Cordis Host entry (tools + prompt section +
 * panel route registration + disposer) and the browser Client half (sidebar +
 * main slot registration) with stub contexts, then run live tool calls.
 * Run: node test/plugin-smoke.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const PARTNER_ARTICLE = 'https://www.businesstimes.com.sg/companies-markets/anthropic-targets-mega-ipo-thanksgiving-holiday'
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-market-info-plugin-'))
const results = []
let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    results.push('PASS  ' + name)
  } catch (error) {
    failed += 1
    results.push('FAIL  ' + name + '  :: ' + String(error && error.stack ? error.stack.split('\n')[0] : error))
  }
}

function makeHostHarness() {
  const state = { tools: [], prompt: null, route: null, disposed: [] }
  const agent = {
    id: 'agent-test',
    ctx: {
      tools: {
        register(definition) {
          state.tools.push(definition)
          return () => state.disposed.push('tool:' + definition.name)
        },
      },
      systemPrompt: {
        section(options) {
          state.prompt = options
          return () => state.disposed.push('prompt')
        },
      },
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    on(name, handler) {
      state['event:' + name] = handler
      return () => {}
    },
    agents: { list: () => [agent] },
    inject(services, callback) {
      assert.deepEqual(services, ['webServer'])
      return callback({
        webServer: {
          register(route) {
            state.route = route
            return () => state.disposed.push('route')
          },
        },
        effect(fn) {
          return fn()
        },
      })
    },
  }
  return { ctx: ctx, state: state, agent: agent }
}

const harness = makeHostHarness()
const dispose = apply(harness.ctx, { dataDir: path.join(tmpRoot, 'host') })
const state = harness.state

await test('host registers four tools + prompt section', () => {
  assert.equal(state.tools.length, 4)
  const names = state.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['ml_feed', 'ml_quotes', 'ml_read', 'ml_search'])
  assert.equal(state.prompt && state.prompt.name, 'dsh-market-info')
  assert.ok(state.prompt && typeof state.prompt.text === 'function')
  assert.equal(state.prompt.order, 9200)
})
await test('host registers the panel route', () => {
  assert.ok(state.route, 'route registered')
  assert.equal(state.route.kind, 'prefix')
  assert.equal(state.route.path, '/market-info')
  assert.equal(typeof state.route.handler, 'function')
})
await test('ml_feed tool returns live headlines', async () => {
  const tool = state.tools.find((t) => t.name === 'ml_feed')
  const out = await tool.execute({ limit: 3, refresh: true })
  assert.equal(out.ok, true)
  assert.ok(Array.isArray(out.items) && out.items.length > 0, 'items ' + (out.items && out.items.length))
  assert.ok(out.items[0].title && /^https?:/.test(out.items[0].url))
})
await test('ml_search tool returns ranked candidates', async () => {
  const tool = state.tools.find((t) => t.name === 'ml_search')
  const out = await tool.execute({ query: 'Anthropic targets mega-IPO before Thanksgiving', limit: 5 })
  assert.equal(out.ok, true)
  assert.ok(Array.isArray(out.results), 'results array')
  assert.ok(out.results.length <= 5)
  if (out.results.length) assert.ok(out.results[0].url && out.results[0].score > 0)
})
await test('ml_read tool returns full text (live network)', async () => {
  const tool = state.tools.find((t) => t.name === 'ml_read')
  const out = await tool.execute({ url: PARTNER_ARTICLE })
  assert.equal(out.ok, true)
  assert.ok(out.chars > 500, 'chars ' + out.chars)
  assert.ok(out.body.length > 500)
})
await test('ml_quotes tool returns live market quotes', async () => {
  const tool = state.tools.find((t) => t.name === 'ml_quotes')
  const out = await tool.execute({ refresh: true, symbols: 'spx,btc,us10y' })
  assert.equal(out.ok, true)
  assert.ok(Array.isArray(out.quotes) && out.quotes.length >= 2, 'quotes ' + (out.quotes && out.quotes.length))
  for (const quote of out.quotes) {
    assert.ok(quote.id && quote.price > 0, 'price for ' + quote.id)
    assert.ok(typeof quote.changePct === 'number', 'pct for ' + quote.id)
    assert.ok(quote.source)
  }
})
await test('disposer tears everything down', () => {
  dispose()
  assert.equal(state.disposed.length, 6, '4 tools + prompt + route, got ' + state.disposed.join(','))
})

// ---------- client half ----------
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      loaded = options
    },
  },
}
await import('../client.js')

function fakeReact() {
  return {
    createElement(tag, props) {
      return { tag: tag, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }
    },
  }
}

await test('client registers sidebar + main slot', () => {
  assert.ok(loaded, 'module loader call captured')
  assert.equal(loaded.id, 'dsh-market-info')
  const mod = loaded.factory((name) => {
    assert.equal(name, 'react')
    return fakeReact()
  })
  assert.deepEqual(mod.inject, ['slots'])
  const slots = {}
  mod.apply({
    slots: {
      inject(name, callback) {
        slots[name] = callback()
        return () => {}
      },
      register(meta, component) {
        return { meta: meta, component: component }
      },
    },
  })
  assert.ok(slots['sidebar.panellist'], 'sidebar slot')
  assert.equal(slots['sidebar.panellist'].meta.id, 'dsh-market-info')
  assert.equal(slots['sidebar.panellist'].meta.label(), '市场资讯')
  assert.equal(slots['main'].meta.key, 'dsh-market-info')
  const icon = slots['sidebar.panellist'].component({ size: 20, active: true })
  assert.equal(icon.tag, 'svg')
  const panel = slots['main'].component({})
  assert.equal(panel.tag, 'iframe')
  assert.equal(panel.props.src, '/market-info/ui')
})

fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(results.join('\n'))
console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exit(1)
