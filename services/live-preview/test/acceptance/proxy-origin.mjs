// Real nginx forwarding regression, no rtex/Redis/develop stack or browser.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { createServer } from '../../app/src/Server.mjs'
import { settingsFromEnv } from '../../config/settings.defaults.mjs'
import { createTicket } from '@overleaf/live-preview-protocol/Tickets.mjs'
import {
  encodeFrame,
  decodeFrame,
} from '@overleaf/live-preview-protocol/Frames.mjs'

const runFile = promisify(execFile)
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-proxy-'))
await fs.chmod(directory, 0o755)
const project = 'a'.repeat(24)
const secret = 'isolated-proxy-test'
const backend = createServer({
  settings: settingsFromEnv({ LIVE_PREVIEW_TICKET_SECRET: secret }),
  fonts: {},
  manager: {
    sessions: new Map(),
    send: (socket, frame) => socket.send(frame),
    open: async (project, socket, access) => {
      socket.send(encodeFrame('hello', access()))
      return {}
    },
    resync: () => {},
  },
})
backend.server.listen(0, '127.0.0.1')
await once(backend.server, 'listening')
const target = `http://127.0.0.1:${backend.server.address().port}`

async function freePort() {
  const socket = net.createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}

async function check(configPath) {
  const source = await fs.readFile(new URL(configPath, import.meta.url), 'utf8')
  const location = source.match(/location = \/live-preview\/ws \{[^}]*\}/)[0]
  const proxyLocation = location.replace(
    /proxy_pass http:\/\/[^;]+;/,
    `proxy_pass ${target};`
  )
  const port = await freePort()
  const configuration = `pid /tmp/nginx.pid;
error_log /tmp/nginx-error.log;
events {}
http {
  access_log off;
  client_body_temp_path /tmp/client-body;
  proxy_temp_path /tmp/proxy-temp;
  fastcgi_temp_path /tmp/fastcgi-temp;
  uwsgi_temp_path /tmp/uwsgi-temp;
  scgi_temp_path /tmp/scgi-temp;
  server {
    listen 127.0.0.1:${port};
    location = /health { return 200 'ok'; }
    ${proxyLocation}
  }
}`
  await fs.writeFile(path.join(directory, 'nginx.conf'), configuration)
  const container = `live-preview-proxy-test-${randomUUID()}`
  let started = false
  let socket
  try {
    await runFile('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '--cpus',
      '1',
      '--memory',
      '256m',
      '--network',
      'host',
      '--read-only',
      '--user',
      'www-data',
      '--tmpfs',
      '/tmp:rw,mode=1777,size=32m',
      '-v',
      `${directory}:/check:ro`,
      '--entrypoint',
      'nginx',
      'ghcr.io/zack-will/interleaf:6.2.4',
      '-c',
      '/check/nginx.conf',
      '-g',
      'daemon off;',
    ])
    started = true
    let ready = false
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`)).status === 200
      } catch {
        await delay(50)
      }
    }
    assert.ok(ready, 'isolated nginx listening')
    const ticket = createTicket(project, 'viewer', secret)
    const endpoint = `ws://127.0.0.1:${port}/live-preview/ws?project=${project}&ticket=${ticket}`
    socket = new WebSocket(endpoint, { origin: `http://127.0.0.1:${port}` })
    assert.equal(decodeFrame((await once(socket, 'message'))[0]).type, 'hello')
    socket.close()
    await once(socket, 'close')
    const rejected = new WebSocket(endpoint, {
      origin: 'https://attacker.example',
    })
    assert.match((await once(rejected, 'error'))[0].message, /403/)
    process.stdout.write(
      `PASS nginx ${configPath}: port-preserving same-origin WS and cross-origin 403\n`
    )
  } finally {
    socket?.terminate()
    if (started) await runFile('docker', ['stop', container])
  }
}

try {
  await check('../../../../server-ce/nginx/overleaf.conf')
  await check('../../../../develop/live-preview-nginx.conf')
  process.stdout.write(
    'Proxy acceptance: 2 passed (real nginx; no production/develop services)\n'
  )
} finally {
  await backend.close()
  await fs.rm(directory, { recursive: true, force: true })
}
