/**
 * Dev/test harness: serve the panel UI + API on 127.0.0.1 without DSH.
 * Usage: node test/serve.mjs [port] [dataDir]
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createService } from '../lib/service.mjs'
import { createHandler } from '../lib/routes.mjs'

const port = Number(process.argv[2] || 7799)
const dataDir = process.argv[3] || path.join(os.tmpdir(), 'dsh-market-info-serve')
const service = createService({ dataDir: dataDir }, (message) => console.log('[svc] ' + message))
const server = http.createServer(createHandler(service))
server.listen(port, '127.0.0.1', () => {
  console.log('panel: http://127.0.0.1:' + port + '/market-info/ui')
  console.log('data:  ' + dataDir)
})
