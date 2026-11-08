/**
 * Source probe: hit adapters over the real network and print what came back.
 *
 *   node test/source-probe.mjs            # every adapter
 *   node test/source-probe.mjs cninfo     # one adapter
 *   node test/source-probe.mjs cninfo sse # several
 */
import { adapters } from '../lib/sources/all.mjs'
import { createSourceLayer } from '../lib/sources/index.mjs'

const wanted = process.argv.slice(2)
const selected = wanted.length ? adapters.filter((a) => wanted.includes(a.id)) : adapters

if (selected.length === 0) {
  console.log('no adapter matched:', wanted.join(', '))
  console.log('available:', adapters.map((a) => a.id).join(', '))
  process.exit(1)
}

const layer = createSourceLayer({ adapters: selected, log: () => {} })
let failed = 0

for (const adapter of selected) {
  const started = Date.now()
  const result = await layer.fetchOne(adapter.id, { limit: 5 }, { refresh: true })
  const ms = Date.now() - started
  const items = result.items || []
  const flag = result.ok && items.length > 0 ? 'OK  ' : items.length === 0 ? 'EMPTY' : 'FAIL'
  if (flag !== 'OK  ') failed += 1
  console.log('[' + flag + '] ' + adapter.id.padEnd(14) + String(ms).padStart(6) + 'ms  ' + String(items.length).padStart(3) + ' items' + (result.error ? '  err=' + result.error : '') + (result.note ? '  note=' + result.note : ''))
  for (const item of items.slice(0, 3)) {
    const when = item.publishedAt ? new Date(item.publishedAt).toISOString().slice(0, 16) : '-'
    console.log('        ' + when + '  ' + String(item.title).slice(0, 70))
    if (item.url) console.log('        ' + String(item.url).slice(0, 100))
  }
}

console.log('')
console.log(failed === 0 ? 'all adapters returned data' : failed + ' adapter(s) returned nothing')
process.exit(0)
