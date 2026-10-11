import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import redis from '@overleaf/redis-wrapper'
import { Materializer } from '../../app/src/Materializer.mjs'

// Run only against the develop gateway and its dedicated Redis. Credentials
// live in an untracked JSON file: { email, password, activationUrl? }.
const config = JSON.parse(
  await fs.readFile(process.env.LIVE_PREVIEW_TEST_CONFIG, 'utf8')
)
const base = 'http://127.0.0.1:8088'
const subscriber = redis.createClient({ host: '127.0.0.1', port: 6380 })
const cookies = new Map()
const frames = []
const events = []
let csrf, project, client, token, tokenId
let requestId = 0

function log(message) {
  process.stdout.write(`${message}\n`)
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
    headers: {
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...(body
        ? {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-csrf-token': csrf,
            'x-requested-with': 'XMLHttpRequest',
          }
        : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  for (const cookie of response.headers.getSetCookie()) {
    const [entry] = cookie.split(';')
    const split = entry.indexOf('=')
    cookies.set(entry.slice(0, split), entry.slice(split + 1))
  }
  return response
}

async function page(path) {
  const response = await request(path)
  assert.equal(response.status, 200, `${path} page`)
  const html = await response.text()
  csrf = html.match(/name="ol-csrfToken" content="([^"]+)"/)?.[1]
  assert.ok(csrf, 'page provides a CSRF token')
  return html
}

async function post(path, body) {
  const response = await request(path, { method: 'POST', body })
  const text = await response.text()
  assert.ok(
    [200, 204].includes(response.status),
    `${path}: HTTP ${response.status} ${text}`
  )
  return text ? JSON.parse(text) : null
}

async function tool(name, args) {
  const response = await request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
    },
    body: {
      jsonrpc: '2.0',
      id: ++requestId,
      method: 'tools/call',
      params: { name, arguments: args },
    },
  })
  const text = await response.text()
  assert.equal(response.status, 200, `${name}: ${text}`)
  const data = text.startsWith('event:')
    ? text.match(/^data: (.*)$/m)?.[1]
    : text
  const result = JSON.parse(data).result
  assert.ok(result && !result.isError, `${name}: ${JSON.stringify(result)}`)
  log(
    `MCP ${name} HTTP 200 project_version=${result.structuredContent?.project_version ?? '-'}`
  )
  return result.structuredContent
}

async function waitFor(predicate, description, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const unavailable = frames.find(frame => frame.type === 'busy')
    if (unavailable) throw new Error(JSON.stringify(unavailable.header))
    const result = predicate()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function startClient(url) {
  client = spawn(process.execPath, [
    new URL('../../bin/test-client.mjs', import.meta.url).pathname,
    url,
  ])
  let pending = ''
  client.stdout.on('data', bytes => {
    pending += bytes.toString()
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const line of lines) {
      const match = line.match(/^(\w+) (.*) body=(\d+)$/)
      if (!match) continue
      const frame = {
        type: match[1],
        header: JSON.parse(match[2]),
        bodyLength: Number(match[3]),
      }
      frames.push(frame)
      const h = frame.header
      log(
        `frame ${frame.type} state=${h.state ?? '-'} layout=${h.layout_version ?? '-'} pages=${h.pages_total ?? '-'} par_id=${h.par_id ?? '-'} user_id=${h.user_id ?? '-'} body=${frame.bodyLength}`
      )
      if (frame.type === 'busy' || frame.type === 'diagnostics')
        log(JSON.stringify(h))
    }
  })
  client.stderr.on('data', bytes => log(`test-client: ${bytes}`))
}

try {
  await subscriber.subscribe('editor-events', 'applied-ops')
  subscriber.on('message', (channel, text) => {
    const event = JSON.parse(text)
    if (String(event.room_id || event.project_id) !== project) return
    events.push({ channel, ...event })
    if (event.message === 'livePreview.active') {
      log(`editor-events livePreview.active ${JSON.stringify(event.payload)}`)
    } else if (channel === 'applied-ops') {
      log(`applied-ops doc=${event.doc_id} version=${event.op?.v}`)
    }
  })

  if (config.activationUrl) {
    await page(
      new URL(config.activationUrl).pathname +
        new URL(config.activationUrl).search
    )
    const activation = new URL(config.activationUrl)
    const response = await request('/user/password/set', {
      method: 'POST',
      body: {
        email: config.email,
        password: config.password,
        passwordResetToken: activation.searchParams.get('token'),
      },
    })
    assert.ok([200, 302].includes(response.status), await response.text())
    log('dev admin activated via server admin script and password-set route')
  }
  await page('/login')
  await post('/login', { email: config.email, password: config.password })
  log('POST /login HTTP 200; session cookie established')
  await page('/project')
  const created = await post('/project/new', {
    projectName: `P2 live preview ${Date.now()}`,
  })
  project = created.project_id
  log(`created project ${project}`)
  const denied = await request(`/project/${project}/live-preview/ticket`, {
    method: 'POST',
    body: {},
  })
  assert.equal(denied.status, 409)
  assert.equal((await denied.json()).code, 'compiler_not_lualatex')
  log('ticket before LuaLaTeX HTTP 409 compiler_not_lualatex')
  await post(`/project/${project}/settings`, { compiler: 'lualatex' })
  const pat = await post('/user/personal-access-tokens', {
    scopes: ['mcp'],
    label: 'P2 live acceptance',
    expiresInDays: 1,
  })
  token = pat.token
  tokenId = pat.id
  const current = await tool('get_project', { project })
  const content = await fs.readFile(
    new URL('./fixtures/main.tex', import.meta.url),
    'utf8'
  )
  const written = await tool('write_files', {
    project,
    base_version: current.project_version,
    overwrite: true,
    files: [
      { path: 'main.tex', content },
      {
        path: 'assets/probe.bin',
        contentBase64: Buffer.from([0, 1, 2, 3, 255]).toString('base64'),
      },
    ],
    message: 'P2 live-preview fixture',
    agent: 'P2 acceptance',
  })
  const snapshotPath = `/internal/project/${project}/live-preview/snapshot`
  assert.equal((await request(snapshotPath)).status, 401)
  const snapshotResponse = await request(snapshotPath, {
    headers: { authorization: 'Basic b3ZlcmxlYWY6b3ZlcmxlYWY=' },
  })
  assert.equal(snapshotResponse.status, 200)
  const snapshot = await snapshotResponse.json()
  const materializer = new Materializer({
    settings: { baseDir: '/tmp' },
    fetchSnapshot: async () => snapshot,
  })
  await materializer.snapshot(project)
  log(
    `private snapshot HTTP 200 root=${snapshot.rootDoc} docs=${snapshot.docs.length} files=${snapshot.files.length} versions=${snapshot.docs.map(doc => doc.version).join(',')}; unauthenticated HTTP 401`
  )
  const html = await page(`/project/${project}`)
  const previewMeta = html.match(
    /<meta name="ol-livePreviewEnabled"[^>]*>/
  )?.[0]
  assert.ok(
    previewMeta?.includes('content'),
    'enabled preview meta has the Pug boolean content attribute'
  )
  log('editor meta ol-livePreviewEnabled=true')

  const issued = await post(`/project/${project}/live-preview/ticket`, {})
  assert.equal(
    JSON.parse(Buffer.from(issued.ticket.split('.')[0], 'base64url')).kind,
    'open'
  )
  log('session-authenticated ticket HTTP 200 kind=open')
  startClient(
    `ws://127.0.0.1:8088/live-preview/ws?project=${project}&ticket=${issued.ticket}`
  )
  const hello = await waitFor(
    () => frames.find(frame => frame.type === 'hello'),
    'hello'
  )
  assert.ok(hello.header.access)
  const first = await waitFor(
    () => frames.find(frame => frame.type === 'layout' && frame.header.pdf_url),
    'initial layout'
  )
  await waitFor(
    () =>
      frames.find(
        frame => frame.type === 'engine' && frame.header.state === 'Ready'
      ),
    'ready engine'
  )
  await waitFor(
    () => events.find(event => event.message === 'livePreview.active'),
    'active lease'
  )
  const before = frames.length
  await tool('edit_file', {
    project,
    path: 'main.tex',
    base_version: written.project_version,
    edits: [
      {
        type: 'replace_range',
        start_line: 5,
        end_line: 5,
        new_text:
          'The live paragraph now includes a real document-updater edit and a fresh layout.',
      },
    ],
    message: 'P2 live edit through document-updater',
    agent: 'P2 acceptance',
  })
  await waitFor(
    () =>
      frames
        .slice(before)
        .find(frame => frame.type === 'paragraph' && frame.bodyLength > 0),
    'edited paragraph'
  )
  const latest = await waitFor(
    () =>
      frames
        .slice(before)
        .find(
          frame =>
            frame.type === 'layout' &&
            frame.header.layout_version > first.header.layout_version
        ),
    'updated layout'
  )
  const accessQuery = `ticket=${encodeURIComponent(hello.header.access)}`
  const pdf = await request(`${latest.header.pdf_url}?${accessQuery}`)
  assert.equal(pdf.status, 200)
  assert.equal(
    Buffer.from(await pdf.arrayBuffer()).toString('ascii', 0, 4),
    '%PDF'
  )
  const font = frames
    .flatMap(frame => Object.values(frame.header.fonts || {}))
    .find(entry => entry.ids === 'glyph_index')
  log(
    `registered font modes=${frames
      .flatMap(frame => Object.values(frame.header.fonts || {}))
      .map(entry => entry.ids)
      .join(',')}`
  )
  assert.ok(font)
  const glyph = await request(
    `/live-preview/glyphs/${font.font_key}?ids=36&${accessQuery}`
  )
  assert.equal(glyph.status, 200)
  const outlines = await glyph.json()
  assert.ok(outlines.glyphs[36].path.length > 0)
  log(
    `PDF HTTP ${pdf.status}; glyph HTTP ${glyph.status}; glyph path chars=${outlines.glyphs[36].path.length}`
  )
  assert.equal((await request(latest.header.pdf_url)).status, 401)
  assert.equal(
    (
      await request(
        `${latest.header.pdf_url}?ticket=${encodeURIComponent(issued.ticket)}`
      )
    ).status,
    401
  )
  log('PDF without access HTTP 401; PDF with opening ticket HTTP 401')
  log(
    `PASS live web → ticket → snapshot → rtex → frames; real MCP edit; frames=${frames.length}`
  )
} finally {
  if (client) client.kill('SIGINT')
  if (tokenId) {
    const response = await request(`/user/personal-access-tokens/${tokenId}`, {
      method: 'DELETE',
      headers: { 'x-csrf-token': csrf },
    })
    log(`test PAT revoked HTTP ${response.status}`)
  }
  await subscriber.quit()
}
