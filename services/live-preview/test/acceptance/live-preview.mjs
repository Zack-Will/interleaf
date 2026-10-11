import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import redis from '@overleaf/redis-wrapper'
import WebSocket from 'ws'
import { settingsFromEnv } from '../../config/settings.defaults.mjs'
import { createService } from '../../app/src/Service.mjs'
import {
  createTicket,
  createAccessToken,
} from '@overleaf/live-preview-protocol/Tickets.mjs'
import { decodeFrame } from '@overleaf/live-preview-protocol/Frames.mjs'

const runFile = promisify(execFile)
const project = 'a'.repeat(24)
const docId = 'b'.repeat(24)
const otherDocId = 'c'.repeat(24)
const secret = randomUUID()
const rtexRoot =
  process.env.RTEX_TEST_ROOT ||
  '/home/zack/overleaf-workspace/rtex-spike/realtime-tex'
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'live-preview-acceptance-')
)
const redisName = `live-preview-test-${randomUUID()}`
const sockets = []
const servers = []
const redisClients = []
const errors = []
let service
let startedRedis = false
const frames = []
const twinFrames = []
const state = {
  projectId: project,
  compiler: 'lualatex',
  rootDoc: 'main.tex',
  docs: [
    {
      id: docId,
      path: 'main.tex',
      content: await fs.readFile(
        new URL('./fixtures/main.tex', import.meta.url),
        'utf8'
      ),
      version: 0,
    },
  ],
  files: [],
}
const history = new Map([[docId, []]])
const requests = []

function log(message) {
  process.stdout.write(`${message}\n`)
}

async function waitFor(predicate, description, timeout = 30000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    const value = predicate()
    if (value) {
      return value
    }
    await delay(10)
  }
  throw new Error(
    `Timeout: ${description}. Recent errors: ${errors.map(error => error.message).join('; ')}`
  )
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function freePort() {
  const server = net.createServer()
  const port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}

async function fakeServer(handler) {
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    res.setHeader('Content-Type', 'application/json')
    handler(req, res)
  })
  servers.push(server)
  const port = await listen(server)
  return `http://127.0.0.1:${port}`
}

function currentDocument(id = docId) {
  return state.docs.find(doc => doc.id === id)
}

function update(component, user, id = docId) {
  const doc = currentDocument(id)
  const op = {
    doc: id,
    v: doc.version,
    op: [component],
    meta: { user_id: user, ts: Date.now(), source: user },
  }
  const end = component.p + (component.d?.length || 0)
  doc.content =
    doc.content.slice(0, component.p) +
    (component.i || '') +
    doc.content.slice(end)
  doc.version += 1
  history.get(id).push(op)
  return op
}

async function publishOp(publisher, op, id = docId) {
  await publisher.publish(
    'applied-ops',
    JSON.stringify({ project_id: project, doc_id: id, op })
  )
}

async function editorEvent(publisher, message, payload) {
  await publisher.publish(
    'editor-events',
    JSON.stringify({ room_id: project, message, payload, _id: randomUUID() })
  )
}

async function connect(url, target) {
  const ticket = createTicket(project, 'viewer', secret)
  const socket = new WebSocket(
    `${url.replace('http:', 'ws:')}/live-preview/ws?project=${project}&ticket=${ticket}`
  )
  sockets.push(socket)
  socket.on('message', bytes =>
    target.push({
      ...decodeFrame(bytes),
      at: performance.now(),
      bytes: Buffer.from(bytes),
    })
  )
  await once(socket, 'open')
  return socket
}

async function run() {
  const redisPort = await freePort()
  await runFile('docker', [
    'run',
    '--rm',
    '-d',
    '--name',
    redisName,
    '-p',
    `127.0.0.1:${redisPort}:6379`,
    'docker.1ms.run/redis:7.4',
  ])
  startedRedis = true
  for (let index = 0; index < 4; index++) {
    const client = redis.createClient({
      host: '127.0.0.1',
      port: redisPort,
      retryStrategy: () => 50,
    })
    client.on('error', () => {})
    redisClients.push(client)
  }
  const [subscriber, publisher, editorA, editorB] = redisClients
  await waitFor(
    () => redisClients.every(client => client.status === 'ready'),
    'test Redis ready'
  )
  const notices = []
  const observe = redis.createClient({ host: '127.0.0.1', port: redisPort })
  redisClients.push(observe)
  observe.on('message', (channel, message) => notices.push(JSON.parse(message)))
  await observe.subscribe('editor-events')

  const webUrl = await fakeServer((req, res) => {
    if (req.url.endsWith('/live-preview/snapshot')) {
      assert.ok(req.headers.authorization?.startsWith('Basic '))
      res.end(JSON.stringify(state))
    } else if (req.url === '/blob') {
      res.setHeader('Content-Type', 'application/octet-stream')
      res.end(Buffer.from([0, 1, 255]))
    } else {
      res.writeHead(404)
      res.end('{}')
    }
  })
  const documentUpdaterUrl = await fakeServer((req, res) => {
    const url = new URL(req.url, 'http://fake')
    const id = url.pathname.split('/').at(-1)
    const doc = currentDocument(id)
    if (!doc) {
      res.writeHead(404)
      res.end('{}')
      return
    }
    const fromVersion = url.searchParams.has('fromVersion')
      ? Number(url.searchParams.get('fromVersion'))
      : -1
    res.end(
      JSON.stringify({
        id,
        lines: doc.content.split('\n'),
        version: doc.version,
        ops: (history.get(id) || []).filter(
          op => fromVersion >= 0 && op.v >= fromVersion
        ),
        type: 'sharejs-text-ot',
        pathname: doc.path,
      })
    )
  })
  const settings = {
    ...settingsFromEnv({ LIVE_PREVIEW_TICKET_SECRET: secret }),
    port: 0,
    baseDir: directory,
    webUrl,
    documentUpdaterUrl,
    rtexBinary: path.join(rtexRoot, 'target/release/rtex'),
    texDir: path.join(rtexRoot, 'tex'),
    maxSessions: 1,
    fontRoots: [path.join(rtexRoot, 'build/texlive')],
    memoryBytes: 2 * 1024 ** 3,
  }
  service = await createService({
    settings,
    subscriber,
    publisher,
    onError: error => {
      errors.push(error)
      log(`service error: ${error.code || ''} ${error.message}`)
    },
  })
  const address = await service.start()
  const url = `http://127.0.0.1:${address.port}`
  await connect(url, frames)
  const hello = await waitFor(
    () => frames.find(frame => frame.type === 'hello'),
    'hello'
  )
  assert.ok(hello.header.access)
  assert.ok(hello.header.access_expiry > Date.now() + 890000)
  const accessQuery = `ticket=${hello.header.access}`
  await waitFor(
    () => frames.find(frame => frame.type === 'layout' && frame.header.pdf_url),
    'initial PDF layout',
    60000
  )
  await waitFor(
    () =>
      frames.find(
        frame => frame.type === 'engine' && frame.header.state === 'Ready'
      ),
    'ready engine'
  )
  assert.equal(service.manager.sessions.size, 1)
  assert.ok(
    notices.some(
      notice =>
        notice.message === 'livePreview.active' &&
        notice.room_id === project &&
        notice.payload[0]?.leaseMs === 75000
    )
  )
  log('PASS real rtex startup, LuaLaTeX layout and native active notice')

  const layout = frames.findLast(
    frame => frame.type === 'layout' && frame.header.pdf_url
  )
  const pdf = await fetch(`${url}${layout.header.pdf_url}?${accessQuery}`)
  assert.equal(pdf.status, 200)
  assert.equal(
    Buffer.from(await pdf.arrayBuffer()).toString('ascii', 0, 4),
    '%PDF'
  )
  assert.equal((await fetch(`${url}${layout.header.pdf_url}`)).status, 401)
  const font = Object.values(layout.header.fonts).find(
    entry => entry.ids === 'glyph_index'
  )
  assert.ok(font, 'rtex layout registered an OpenType font')
  const glyphResponse = await fetch(
    `${url}/live-preview/glyphs/${font.font_key}?ids=36&${accessQuery}`
  )
  assert.equal(glyphResponse.status, 200)
  const glyph = await glyphResponse.json()
  assert.ok(glyph.unitsPerEm > 0)
  assert.ok(glyph.glyphs[36].path.length > 0)
  assert.ok(glyph.glyphs[36].advance > 0)
  const type1Font = Object.values(layout.header.fonts).find(
    entry => entry.ids === 'char_code'
  )
  assert.ok(type1Font, 'rtex math registered a Type 1 font')
  const type1Response = await fetch(
    `${url}/live-preview/glyphs/${type1Font.font_key}?ids=120&${accessQuery}`
  )
  assert.equal(type1Response.status, 200)
  const type1Glyph = await type1Response.json()
  assert.ok(type1Glyph.glyphs[120].path.length > 0)
  assert.ok(type1Glyph.glyphs[120].advance > 0)
  log('PASS real Type 1 math glyph paths and advance metrics')
  const wrongTicket = createAccessToken('f'.repeat(24), 'outsider', secret)
  assert.equal(
    (
      await fetch(
        `${url}/live-preview/glyphs/${font.font_key}?ids=36&ticket=${wrongTicket}`
      )
    ).status,
    404
  )
  const openingTicket = createTicket(project, 'viewer', secret)
  assert.equal(
    (await fetch(`${url}${layout.header.pdf_url}?ticket=${openingTicket}`))
      .status,
    401
  )
  assert.equal(
    (
      await fetch(
        `${url}/live-preview/glyphs/${font.font_key}?ids=36&ticket=${openingTicket}`
      )
    ).status,
    401
  )
  log(
    'PASS PDF and glyphs using hello access token, project binding and opening-ticket rejection'
  )

  const session = service.manager.sessions.get(project)
  const paragraphCount = frames.filter(
    frame => frame.type === 'paragraph'
  ).length
  await publishOp(
    editorA,
    update(
      { p: currentDocument().content.indexOf('live') + 4, i: ' updated' },
      'alice'
    )
  )
  await waitFor(
    () =>
      frames.filter(frame => frame.type === 'paragraph').length >
      paragraphCount,
    'paragraph update'
  )
  const paragraph = frames.findLast(frame => frame.type === 'paragraph')
  assert.equal(paragraph.header.user_id, 'alice')
  assert.equal(paragraph.body.toString('ascii', 0, 4), 'RTDL')
  log('PASS applied-ops paragraph binary frame and user attribution')

  // Publish only the second applied op; the first is recovered from recent ops.
  update(
    { p: currentDocument().content.indexOf('ordinary'), i: 'missing ' },
    'alice'
  )
  const afterGap = update(
    { p: currentDocument().content.indexOf('ordinary'), i: 'recovered ' },
    'bob'
  )
  await publishOp(editorB, afterGap)
  await waitFor(
    () => session.docs.get(docId).version === currentDocument().version,
    'gap replay'
  )
  assert.equal(session.docs.get(docId).content, currentDocument().content)
  assert.ok(requests.some(request => request.includes('fromVersion=1')))
  await publishOp(editorA, history.get(docId)[0])
  await delay(100)
  assert.equal(session.docs.get(docId).content, currentDocument().content)
  assert.ok(requests.every(request => !request.includes('get_and_flush')))
  log('PASS missing/out-of-order op recovery through document-updater GET')

  // Warm any probe work before measuring continuous collaboration.
  await session.queue
  await waitFor(
    () =>
      frames.findLast(frame => frame.type === 'layout')?.header.versions
        .source_revision >= 3,
    'settled layout'
  )
  await connect(url, twinFrames)
  await waitFor(
    () => twinFrames.some(frame => frame.type === 'hello'),
    'second preview'
  )
  const baseline = await session.engine.command({ cmd: 'status' })
  const pending = new Map()
  const latencies = []
  const collaborationStart = performance.now()
  const originalPush = frames.push.bind(frames)
  frames.push = (...items) => {
    for (const frame of items) {
      if (frame.type === 'paragraph') {
        const sample = pending.get(frame.header.versions.source_revision)
        if (sample) {
          assert.equal(frame.header.user_id, sample.user)
          latencies.push(frame.at - sample.at)
          pending.delete(frame.header.versions.source_revision)
        }
      }
    }
    return originalPush(...items)
  }
  const fanoutStartA = frames.length
  const fanoutStartB = twinFrames.length
  const count = 100
  for (let index = 0; index < count; index++) {
    const user = index % 2 === 0 ? 'alice' : 'bob'
    const content = currentDocument().content
    const position = content.indexOf('ordinary')
    const component =
      index % 2 === 0 ? { p: position, i: 'x ' } : { p: position - 2, d: 'x ' }
    const op = update(component, user)
    pending.set(baseline.versions.source_revision + index + 1, {
      user,
      at: performance.now(),
    })
    await publishOp(index % 2 === 0 ? editorA : editorB, op)
    await delay(120)
  }
  const collaborationEnd = performance.now()
  await waitFor(
    () => session.docs.get(docId).version === currentDocument().version,
    'collaboration versions'
  )
  await delay(500)
  assert.equal(session.docs.get(docId).content, currentDocument().content)
  assert.ok(
    latencies.length >= count * 0.9,
    `Too few live samples: ${latencies.length}/${count}`
  )
  latencies.sort((a, b) => a - b)
  const median = latencies[Math.floor(latencies.length / 2)]
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]
  const layouts = frames
    .filter(
      frame =>
        frame.type === 'layout' &&
        frame.at >= collaborationStart &&
        frame.at <= collaborationEnd
    )
    .map(frame => frame.at)
  assert.ok(
    layouts.length >= 3,
    `Only ${layouts.length} layouts during continuous edits`
  )
  const boundaries = [collaborationStart, ...layouts, collaborationEnd]
  const gaps = boundaries.slice(1).map((at, index) => at - boundaries[index])
  const maxGap = Math.max(...gaps)
  log(
    `COLLABORATION samples=${latencies.length}/${count} median=${median.toFixed(2)}ms P95=${p95.toFixed(2)}ms layouts=${layouts.length} max-layout-gap=${maxGap.toFixed(2)}ms duration=${(collaborationEnd - collaborationStart).toFixed(0)}ms`
  )
  assert.ok(p95 < 300, `P95 ${p95}ms exceeds 300ms`)
  assert.ok(maxGap <= 4000, `Layout gap ${maxGap}ms exceeds 4s`)
  const streamA = frames.slice(fanoutStartA).map(frame => frame.bytes)
  const streamB = twinFrames.slice(fanoutStartB).map(frame => frame.bytes)
  assert.deepEqual(
    streamA,
    streamB,
    'Both previews receive identical ordered frames'
  )
  log(
    'PASS two-editor convergence, ordered fan-out, P95 latency and layout max-wait'
  )

  state.docs.push({
    id: otherDocId,
    path: 'extra.tex',
    content: 'An extra document.\n',
    version: 0,
  })
  history.set(otherDocId, [])
  await editorEvent(publisher, 'reciveNewDoc', [
    'folder',
    { _id: otherDocId, name: 'extra.tex' },
    'editor',
    'alice',
  ])
  await waitFor(() => session.docs.has(otherDocId), 'new document')
  assert.equal(
    await fs.readFile(path.join(directory, project, 'extra.tex'), 'utf8'),
    'An extra document.\n'
  )
  state.files.push({
    id: 'e'.repeat(24),
    path: 'assets/data.bin',
    blobUrl: `${webUrl}/blob`,
  })
  await editorEvent(publisher, 'reciveNewFile', [
    'folder',
    { name: 'data.bin' },
  ])
  await waitFor(() => session.snapshot.files.length === 1, 'new binary file')
  assert.deepEqual(
    await fs.readFile(path.join(directory, project, 'assets/data.bin')),
    Buffer.from([0, 1, 255])
  )
  let generation = session.engineGeneration
  currentDocument(otherDocId).path = 'renamed.tex'
  await editorEvent(publisher, 'reciveEntityRename', [
    otherDocId,
    'renamed.tex',
  ])
  await waitFor(() => session.engineGeneration > generation, 'rename restart')
  await session.queue
  generation = session.engineGeneration
  currentDocument(otherDocId).path = 'chapters/renamed.tex'
  await editorEvent(publisher, 'reciveEntityMove', [otherDocId, 'folder2'])
  await waitFor(() => session.engineGeneration > generation, 'move restart')
  await session.queue
  generation = session.engineGeneration
  state.docs = state.docs.filter(doc => doc.id !== otherDocId)
  await editorEvent(publisher, 'removeEntity', [otherDocId])
  await waitFor(() => session.engineGeneration > generation, 'remove restart')
  await session.queue
  currentDocument().path = 'new-main.tex'
  state.rootDoc = 'new-main.tex'
  generation = session.engineGeneration
  await editorEvent(publisher, 'rootDocUpdated', [docId])
  await waitFor(() => session.engineGeneration > generation, 'root restart')
  await session.queue
  await waitFor(
    () =>
      frames.findLast(frame => frame.type === 'engine')?.header.state ===
      'Ready',
    'restarted engine',
    60000
  )
  state.compiler = 'pdflatex'
  await editorEvent(publisher, 'compilerUpdated', ['pdflatex'])
  await waitFor(
    () => service.manager.sessions.size === 0,
    'compiler stops session'
  )
  await waitFor(
    () => notices.some(notice => notice.message === 'livePreview.inactive'),
    'inactive notice'
  )
  log(
    'PASS native new-doc/file, rename, move, remove, root and compiler events'
  )
  assert.ok(
    errors.every(error =>
      ['invalid_ticket', 'font_not_found'].includes(error.code)
    ),
    'Only expected authorization errors'
  )
  log(
    'Acceptance: 7 passed (real rtex + isolated Redis + fake HTTP; collaboration included)'
  )
}

try {
  await run()
} finally {
  for (const socket of sockets) {
    socket.terminate()
  }
  await service?.stop()
  for (const client of redisClients) {
    client.disconnect()
  }
  for (const server of servers) {
    await new Promise(resolve => server.close(resolve))
  }
  if (startedRedis) {
    await runFile('docker', ['stop', redisName])
    log(`CLEANUP stopped ${redisName}`)
  }
  await fs.rm(directory, { recursive: true, force: true })
}
