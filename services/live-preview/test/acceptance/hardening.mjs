// Sequential real-engine release checks. Run in a throwaway TeX Live image;
// /papers contains COPIES of Cleave and migrated CrossMem, never originals.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter, once } from 'node:events'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { createService } from '../../app/src/Service.mjs'
import { RtexProcess } from '../../app/src/RtexProcess.mjs'
import { PreviewError } from '../../app/src/Errors.mjs'
import { settingsFromEnv } from '../../config/settings.defaults.mjs'
import { createTicket } from '@overleaf/live-preview-protocol/Tickets.mjs'
import { decodeFrame } from '@overleaf/live-preview-protocol/Frames.mjs'
import { decodeDisplayList } from '@overleaf/live-preview-protocol/DisplayList.mjs'

const runFile = promisify(execFile)
const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-hardening-'))
const secret = 'isolated-hardening-test-secret'
const snapshots = new Map()
const sockets = []
const errors = []
const stderr = []
const reports = []
let service
let url
let projectNumber = 0
const settings = {
  ...settingsFromEnv(process.env),
  ticketSecret: secret,
  baseDir,
  port: 0,
  maxSessions: 2,
  idleMs: 150,
  driftMs: 3600000,
  fontRoots: ['/usr/local/texlive', '/usr/share/fonts'],
}

function log(value) {
  process.stdout.write(`${value}\n`)
}

async function waitFor(predicate, description, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await delay(25)
  }
  throw new Error(
    `Timeout: ${description}; ${JSON.stringify(errors)}; ${stderr.slice(-5).join(' ')}`
  )
}

function addProject(docs, files = [], rootDoc = 'main.tex') {
  const projectId = (++projectNumber).toString(16).padStart(24, '0')
  snapshots.set(projectId, {
    projectId,
    compiler: 'lualatex',
    rootDoc,
    docs: docs.map((doc, index) => ({ ...doc, id: String(index), version: 0 })),
    files,
  })
  return projectId
}

async function makeService() {
  const subscriber = Object.assign(new EventEmitter(), {
    subscribe: async () => {},
    unsubscribe: async () => {},
  })
  service = await createService({
    settings,
    subscriber,
    publisher: { publish: async () => {} },
    clients: {
      fetchSnapshot: async project => structuredClone(snapshots.get(project)),
      fetchBinary: async file => fs.readFile(new URL(file)),
      fetchDocument: async () => {
        throw new Error('unused document fetch')
      },
    },
    createEngine: () => {
      const engine = new RtexProcess({ settings })
      engine.on('stderr', message => stderr.push(message))
      return engine
    },
    onError: error => errors.push({ code: error.code, message: error.message }),
  })
  const address = await service.start()
  url = `http://127.0.0.1:${address.port}`
}

async function connect(project, user = 'viewer') {
  const frames = []
  const ticket = createTicket(project, user, secret)
  const socket = new WebSocket(
    `${url.replace('http:', 'ws:')}/live-preview/ws?project=${project}&ticket=${ticket}`
  )
  sockets.push(socket)
  socket.on('message', bytes => frames.push(decodeFrame(bytes)))
  await once(socket, 'open')
  await waitFor(() => frames.length, 'opening frame')
  return { socket, frames, project }
}

async function layout(viewer) {
  const frame = await waitFor(() => {
    const failure = viewer.frames.find(
      frame =>
        frame.type === 'busy' ||
        (frame.type === 'engine' && frame.header.state === 'Failed')
    )
    if (failure)
      throw new Error(`Engine failed: ${JSON.stringify(failure.header)}`)
    return viewer.frames.findLast(
      frame => frame.type === 'layout' && frame.header.pdf_url
    )
  }, 'real layout')
  assert.equal(frame.header.compile.state, 'Ok')
  return frame
}

async function stopProject(viewer) {
  await service.manager.stop(viewer.project)
  await waitFor(() => viewer.socket.readyState === 3, 'socket closed')
  await assert.rejects(fs.access(path.join(baseDir, viewer.project)))
}

async function textLogs(directory) {
  let result = ''
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) result += await textLogs(file)
    else if (entry.name.endsWith('.log'))
      result += await fs.readFile(file, 'utf8')
  }
  return result
}

async function security() {
  const project = addProject([
    {
      path: 'main.tex',
      content: String.raw`\documentclass{article}
\begin{document}
\input{chapter.tex}
\immediate\write18{touch shell-escape-sentinel}
\directlua{texio.write_nl('SHELL-STATUS:' .. status.shell_escape)}
\end{document}`,
    },
    { path: 'chapter.tex', content: 'Ordinary project input works.\n' },
  ])
  const viewer = await connect(project)
  await layout(viewer)
  const directory = path.join(baseDir, project)
  const enginePid = service.manager.sessions.get(project).engine.child.pid
  let checked = 0
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8')
      if (
        !stat.includes('(lualatex)') ||
        Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) !==
          enginePid
      )
        continue
      const environment = (
        await fs.readFile(`/proc/${name}/environ`, 'utf8')
      ).split('\0')
      assert.ok(environment.includes('openin_any=p'))
      assert.ok(environment.includes('openout_any=p'))
      assert.ok(environment.includes('shell_escape=f'))
      const limits = await fs.readFile(`/proc/${name}/limits`, 'utf8')
      assert.ok(limits.includes(String(settings.memoryBytes)))
      checked++
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  assert.ok(
    checked > 0,
    'checked actual LuaLaTeX child environment and inherited AS cap'
  )
  assert.match(await textLogs(directory), /SHELL-STATUS:0/)
  const { stdout } = await runFile('find', [
    directory,
    '-name',
    'shell-escape-sentinel',
  ])
  assert.equal(stdout, '')
  await stopProject(viewer)
  log(
    'PASS ordinary project input and disabled immediate write18 (shell status 0; no sentinel)'
  )

  const unsafe = addProject([
    {
      path: 'main.tex',
      content: String.raw`\documentclass{article}
\begin{document}
\directlua{texio.write_nl('OPENIN-POLICY:' .. kpse.var_value('openin_any')); texio.write_nl('OPENOUT-POLICY:' .. kpse.var_value('openout_any'))}
\newread\probe\openin\probe=/etc/passwd
\ifeof\probe\typeout{PASSWD-READ:blocked}\else\typeout{PASSWD-READ:opened}\fi\closein\probe
\input{/etc/passwd}\end{document}`,
    },
  ])
  const blocked = await connect(unsafe)
  await waitFor(async () => {
    const logs = await textLogs(path.join(baseDir, unsafe))
    return (
      logs.includes('OPENIN-POLICY:p') &&
      logs.includes('OPENOUT-POLICY:p') &&
      logs.includes('PASSWD-READ:blocked') &&
      /File [`']\/etc\/passwd(?:\.tex)?['`].*not found/.test(logs)
    )
  }, 'paranoid input rejection')
  assert.ok(
    !blocked.frames.some(
      frame => frame.type === 'paragraph' && frame.header.status === 'ok'
    )
  )
  await stopProject(blocked)
  log(
    'PASS input /etc/passwd refused by kpathsea openin_any=p in a live session'
  )
  const outside = path.join(baseDir, 'outside-output')
  const writeProject = addProject([
    {
      path: 'main.tex',
      content: `\\documentclass{article}\n\\begin{document}\n\\directlua{texio.write_nl('OPENOUT-POLICY:' .. kpse.var_value('openout_any'))}\n\\newwrite\\probe\\immediate\\openout\\probe=${outside}\n\\immediate\\write\\probe{escaped}\\end{document}\n`,
    },
  ])
  const writeViewer = await connect(writeProject)
  await waitFor(async () => {
    const logs = await textLogs(path.join(baseDir, writeProject))
    return (
      logs.includes('OPENOUT-POLICY:p') &&
      logs.includes("I can't write on file")
    )
  }, 'paranoid output rejection')
  await assert.rejects(fs.access(outside))
  await stopProject(writeViewer)
  log('PASS absolute output outside the session refused with openout_any=p')
}

async function processMemory(group) {
  let rss = 0
  let virtual = 0
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[2]) !== group) continue
      const status = await fs.readFile(`/proc/${name}/status`, 'utf8')
      rss += Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0)
      virtual = Math.max(
        virtual,
        Number(status.match(/VmSize:\s+(\d+)/)?.[1] || 0)
      )
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
    }
  }
  return { rss, virtual }
}

async function chineseAndResources() {
  const content = await fs.readFile(
    new URL('./fixtures/thesis.tex', import.meta.url),
    'utf8'
  )
  const project = addProject([{ path: 'main.tex', content }])
  const viewer = await connect(project)
  const session = service.manager.sessions.get(project)
  let peakRss = 0
  let peakVirtual = 0
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const memory = await processMemory(session.engine.child.pid)
      peakRss = Math.max(peakRss, memory.rss)
      peakVirtual = Math.max(peakVirtual, memory.virtual)
      await delay(100)
    }
  })()
  try {
    const initial = await layout(viewer)
    assert.ok(
      initial.header.pages_total >= 3 && initial.header.pages_total <= 4
    )
    const doc = session.docs.get('0')
    const position = content.indexOf('中文实时预览')
    await service.consumer.consume('applied-ops', {
      project_id: project,
      doc_id: '0',
      op: {
        v: 0,
        op: [{ p: position, i: '论文写作中，' }],
        meta: { user_id: 'author' },
      },
    })
    const paragraph = await waitFor(
      () =>
        viewer.frames.find(
          frame =>
            frame.type === 'paragraph' &&
            frame.body.length &&
            frame.header.status === 'ok'
        ),
      'Chinese live paragraph'
    )
    assert.ok(doc.content.includes('论文写作中，中文实时预览'))
    const display = decodeDisplayList(paragraph.body)
    const [fontId, font] = Object.entries(display.fonts).find(([, font]) =>
      /Fandol.*\.otf/i.test(font.filename)
    )
    assert.ok(font.filename.endsWith('.otf'))
    const ids = [
      ...new Set(
        display.lines
          .flatMap(line => line.items)
          .filter(item => item[0] === 'g' && item[1] === Number(fontId))
          .map(item => item[3])
      ),
    ]
    assert.ok(ids.length > 10)
    const fontKey = paragraph.header.fonts[fontId].font_key
    const access = viewer.frames.find(frame => frame.type === 'hello').header
      .access
    const response = await fetch(
      `${url}/live-preview/glyphs/${fontKey}?ids=${ids.join(',')}&ticket=${access}`
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const bytes = await response.arrayBuffer()
    const outlines = JSON.parse(Buffer.from(bytes).toString())
    assert.ok(
      Object.values(outlines.glyphs).every(glyph => glyph.path.length > 0)
    )
    const fontBytes = (await fs.stat(font.filename)).size
    log(
      `CHINESE pages=${initial.header.pages_total} unique-glyphs=${ids.length} payload-bytes=${bytes.byteLength} full-font-bytes=${fontBytes} font=${path.basename(font.filename)}`
    )
    await delay(5000)
    const steady = await processMemory(session.engine.child.pid)
    const { stdout } = await runFile('du', ['-sk', session.directory])
    const build = await runFile('du', [
      '-sk',
      path.join(session.directory, 'build'),
    ])
    reports.push({
      project: 'ctexbook',
      rssPeakKiB: peakRss,
      rssSteadyKiB: steady.rss,
      processVirtualPeakKiB: peakVirtual,
      memoryCapMiB: settings.memoryBytes / 1024 ** 2,
      disk: stdout.trim(),
      buildDisk: build.stdout.trim(),
    })
    log(`RESOURCE ${JSON.stringify(reports.at(-1))}`)
  } finally {
    sampling = false
    await sampler
    await stopProject(viewer)
  }
  log(
    'PASS ctexbook thesis live paragraph, Fandol OTF glyph HTTP and directory cleanup'
  )
}

async function paper(name, rootDoc) {
  const directory = path.join(
    process.env.LIVE_PREVIEW_TEST_PAPERS || '/papers',
    name
  )
  const docs = []
  const files = []
  async function walk(folder, prefix = '') {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name)
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(file, relative)
      else if (entry.isFile()) {
        if (entry.name.endsWith('.tex'))
          docs.push({
            path: relative,
            content: await fs.readFile(file, 'utf8'),
          })
        else
          files.push({
            id: `file-${files.length}`,
            path: relative,
            blobUrl: `http://fake/${files.length}`,
            source: file,
          })
      } else throw new Error(`Unexpected paper symlink: ${relative}`)
    }
  }
  await walk(directory)
  const project = addProject(docs, files, rootDoc)
  const original = service.manager.materializer.fetchBinary
  service.manager.materializer.fetchBinary = async url =>
    fs.readFile(files.find(file => file.blobUrl === url).source)
  const viewer = await connect(project)
  const session = service.manager.sessions.get(project)
  let peakRss = 0
  let peakVirtual = 0
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const memory = await processMemory(session.engine.child.pid)
      peakRss = Math.max(peakRss, memory.rss)
      peakVirtual = Math.max(peakVirtual, memory.virtual)
      await delay(100)
    }
  })()
  try {
    const first = await layout(viewer)
    await waitFor(
      () =>
        viewer.frames.findLast(frame => frame.type === 'layout')?.header
          .convergence?.state === 'Converged',
      'real-paper bibliography/layout convergence',
      180000
    )
    const doc = [...session.docs.values()].find(doc => doc.path === rootDoc)
    const target =
      name === 'cleave'
        ? 'Memory pooling recovers'
        : 'Tiering systems today choose pages'
    const position = doc.content.indexOf(target)
    assert.ok(position >= 0, 'real-paper paragraph edit target')
    for (let edit = 0; edit < 10; edit++) {
      await service.consumer.consume('applied-ops', {
        project_id: project,
        doc_id: doc.id,
        op: {
          v: doc.version,
          op: [
            edit % 2
              ? { p: position, d: 'Updated ' }
              : { p: position, i: 'Updated ' },
          ],
          meta: { user_id: 'load-test-author' },
        },
      })
      await delay(120)
    }
    const incorporated = await waitFor(
      () =>
        viewer.frames.findLast(
          frame =>
            frame.type === 'layout' &&
            frame.header.versions.source_revision >= 10
        ),
      'real-paper edits incorporated in full pages',
      180000
    )
    assert.equal(incorporated.header.compile.state, 'Ok')
    log(
      `LOAD ${name} edits=10 live-results=${viewer.frames.filter(frame => frame.type === 'paragraph' && frame.header.status.startsWith('ok')).length} background-notices=${viewer.frames.filter(frame => frame.type === 'background').length} pages=${incorporated.header.pages_total}`
    )
    await delay(15000)
    const steady = await processMemory(session.engine.child.pid)
    const { stdout } = await runFile('du', ['-sk', session.directory])
    const build = await runFile('du', [
      '-sk',
      path.join(session.directory, 'build'),
    ])
    reports.push({
      project: name,
      initialPages: first.header.pages_total,
      pages: incorporated.header.pages_total,
      rssPeakKiB: peakRss,
      rssSteadyKiB: steady.rss,
      processVirtualPeakKiB: peakVirtual,
      memoryCapMiB: settings.memoryBytes / 1024 ** 2,
      disk: stdout.trim(),
      buildDisk: build.stdout.trim(),
    })
    log(`RESOURCE ${JSON.stringify(reports.at(-1))}`)
  } finally {
    sampling = false
    await sampler
    await stopProject(viewer)
    service.manager.materializer.fetchBinary = original
  }
  log(`PASS real ${name} session under prlimit --as and cleanup`)
}

async function robustness() {
  const content =
    '\\documentclass{article}\n\\begin{document}A live paragraph.\\end{document}\n'
  const project = addProject([{ path: 'main.tex', content }])
  const viewer = await connect(project)
  await layout(viewer)
  const session = service.manager.sessions.get(project)
  const pid = session.engine.child.pid
  process.kill(pid, 'SIGKILL')
  await waitFor(() => session.engine.child.pid !== pid, 'single engine restart')
  await waitFor(
    () =>
      viewer.frames.filter(
        frame => frame.type === 'engine' && frame.header.state === 'Ready'
      ).length === 2,
    'restarted engine ready'
  )
  process.kill(session.engine.child.pid, 'SIGKILL')
  await waitFor(() => session.state === 'Failed', 'second crash failed')
  const generation = session.engineGeneration
  await delay(250)
  assert.equal(session.engineGeneration, generation)
  assert.ok(
    viewer.frames.some(
      frame => frame.type === 'engine' && frame.header.state === 'Failed'
    )
  )
  await stopProject(viewer)
  log(
    'PASS real child kill: one restart, second crash Failed without crash loop'
  )

  const before = await connect(project)
  await layout(before)
  await service.stop()
  const stale = path.join(baseDir, 'f'.repeat(24))
  await fs.mkdir(stale)
  await fs.writeFile(path.join(stale, 'stale.pdf'), 'previous process')
  await makeService()
  await assert.rejects(fs.access(stale))
  const rebuilt = await connect(project)
  await layout(rebuilt)
  await stopProject(rebuilt)
  log(
    'PASS service replacement, fresh socket/ticket, rebuilt session and stale startup cleanup'
  )

  // Three tiny sessions: only two engine trees ever coexist.
  settings.idleMs = 10000
  const a = await connect(addProject([{ path: 'main.tex', content }]), 'alice')
  await layout(a)
  const b = await connect(addProject([{ path: 'main.tex', content }]), 'bob')
  await layout(b)
  const cProject = addProject([{ path: 'main.tex', content }])
  const busy = await connect(cProject, 'carol')
  assert.equal(busy.frames[0].header.code, 'busy')
  a.socket.close()
  await once(a.socket, 'close')
  const c = await connect(cProject, 'carol')
  await layout(c)
  assert.equal(service.manager.sessions.size, 2)
  assert.equal(service.manager.sessions.has(a.project), false)
  await assert.rejects(fs.access(path.join(baseDir, a.project)))
  await stopProject(b)
  settings.idleMs = 150
  c.socket.close()
  await once(c.socket, 'close')
  await waitFor(() => service.manager.sessions.size === 0, 'idle reaping')
  await assert.rejects(fs.access(path.join(baseDir, c.project)))
  log(
    'PASS maxSessions=2 third project busy, viewerless LRU eviction and idle reaping'
  )
}

async function abruptServiceRestart() {
  await service.stop()
  const project = 'e'.repeat(24)
  const previousUrl = url
  let worker
  let enginePid
  async function startWorker() {
    let port
    worker = fork(new URL('./restart-worker.mjs', import.meta.url), [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    worker.on('message', message => {
      if (message.error) errors.push(message.error)
      port ||= message.port
      enginePid ||= message.enginePid
    })
    worker.send({ baseDir, project, secret })
    await waitFor(() => port, 'replacement Node service listening')
    url = `http://127.0.0.1:${port}`
  }
  try {
    await startWorker()
    const first = await connect(project)
    await layout(first)
    await waitFor(() => enginePid, 'engine pid')
    const exited = once(worker, 'exit')
    worker.kill('SIGKILL')
    await exited
    await waitFor(
      () => first.socket.readyState === 3,
      'socket closes on Node kill'
    )
    let remaining = 1
    for (let attempt = 0; attempt < 100 && remaining; attempt++) {
      remaining = (await processMemory(enginePid)).rss
      if (remaining) await delay(100)
    }
    assert.equal(remaining, 0, 'engine tree exits after service stdin EOF')
    await fs.access(path.join(baseDir, project))
    await startWorker()
    const next = await connect(project)
    const pass = await layout(next)
    assert.equal(pass.header.layout_version, 1)
    log(
      'PASS SIGKILL Node service, disconnected client, engine EOF exit, stale cleanup and rebuilt session'
    )
  } finally {
    if (worker?.exitCode === null && worker?.signalCode === null) {
      const exited = once(worker, 'exit')
      worker.kill('SIGTERM')
      await exited
    }
    url = previousUrl
  }
}

async function upstreamFailures() {
  const content =
    '\\documentclass{article}\n\\begin{document}Source outage test.\\end{document}\n'
  const project = addProject([{ path: 'main.tex', content }])
  const originalSnapshot = service.manager.materializer.fetchSnapshot
  const originalDocument = service.consumer.fetchDocument
  const unavailable = new PreviewError(
    'upstream_failed',
    'Source service unavailable'
  )
  service.manager.materializer.fetchSnapshot = async () => {
    throw unavailable
  }
  const failedOpen = await connect(project)
  assert.equal(failedOpen.frames[0].header.code, 'upstream_failed')
  assert.equal(service.manager.sessions.size, 0)
  service.manager.materializer.fetchSnapshot = originalSnapshot
  for (const source of ['snapshot', 'document']) {
    const viewer = await connect(project)
    await layout(viewer)
    const session = service.manager.sessions.get(project)
    const generation = session.engineGeneration
    let result
    if (source === 'snapshot') {
      service.manager.materializer.fetchSnapshot = async () => {
        throw unavailable
      }
      result = service.consumer.consume('editor-events', {
        room_id: project,
        message: 'rootDocUpdated',
        payload: [],
      })
    } else {
      service.consumer.fetchDocument = async () => {
        throw unavailable
      }
      result = service.consumer.consume('applied-ops', {
        project_id: project,
        doc_id: '0',
        op: { v: 9, op: [{ p: 0, i: 'gap' }] },
      })
    }
    await assert.rejects(result, { code: 'upstream_failed' })
    await waitFor(
      () =>
        viewer.frames.some(
          frame =>
            frame.type === 'engine' &&
            frame.header.state === 'Failed' &&
            frame.header.code === 'upstream_failed'
        ),
      'clear source failure frame'
    )
    await delay(250)
    assert.equal(session.engineGeneration, generation + 1)
    await stopProject(viewer)
    service.manager.materializer.fetchSnapshot = originalSnapshot
    service.consumer.fetchDocument = originalDocument
  }
  assert.ok(errors.every(error => error.code === 'upstream_failed'))
  errors.length = 0
  log(
    'PASS unavailable web snapshot and document-updater: clear error frames, no engine restart loop'
  )
}

try {
  await makeService()
  await security()
  await chineseAndResources()
  await paper('cleave', 'main.tex')
  await paper('crossmem', 'crossmem.tex')
  await robustness()
  await upstreamFailures()
  await abruptServiceRestart()
  assert.deepEqual(errors, [])
  log('Hardening acceptance: 11 passed (real rtex, full TeX Live; sequential)')
  if (process.env.LIVE_PREVIEW_TEST_REPORT)
    await fs.writeFile(
      process.env.LIVE_PREVIEW_TEST_REPORT,
      JSON.stringify(reports, null, 2)
    )
} finally {
  for (const socket of sockets) socket.terminate()
  await service?.stop()
  await fs.rm(baseDir, { recursive: true, force: true })
  log('CLEANUP stopped service and removed all session/build directories')
}
