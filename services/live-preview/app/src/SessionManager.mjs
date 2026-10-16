import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Attribution } from './Attribution.mjs'
import { utf16Offset } from './Offsets.mjs'
import { assertNoSymlinks } from './Materializer.mjs'
import {
  encodeFrame,
  decodeFrame,
} from '@overleaf/live-preview-protocol/Frames.mjs'
import { PreviewError } from './Errors.mjs'
import { missingGlyphDiagnostics } from './MissingGlyphs.mjs'
import {
  newerThanLayout,
  snapshotRevision,
} from '@overleaf/live-preview-protocol/Layout.mjs'
import {
  decodeDisplayList,
  layoutRowRects,
} from '@overleaf/live-preview-protocol/DisplayList.mjs'

export class SessionManager {
  constructor({
    settings,
    materializer,
    createEngine,
    publisher,
    fonts,
    filesystem = fs,
    now = Date.now,
    onError = () => {},
  }) {
    Object.assign(this, {
      settings,
      materializer,
      createEngine,
      publisher,
      fonts,
      now,
      onError,
    })
    this.fs = filesystem
    this.sessions = new Map()
    this.socketAccess = new WeakMap()
    this.admission = Promise.resolve()
  }

  open(projectId, socket, getAccess) {
    const result = this.admission.then(() =>
      this.admit(projectId, socket, getAccess)
    )
    this.admission = result.catch(() => {})
    return result
  }

  async admit(projectId, socket, getAccess) {
    let session = this.sessions.get(projectId)
    if (session?.stopped) {
      await session.stopPromise
      session = null
    }
    if (session?.state === 'Failed') {
      await session.queue
      await this.stop(projectId)
      session = null
    }
    if (!session) {
      if (this.sessions.size >= this.settings.maxSessions) {
        const idle = [...this.sessions.values()]
          .filter(entry => entry.sockets.size === 0)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0]
        if (!idle) {
          throw new PreviewError(
            'busy',
            'All live-preview sessions have viewers',
            503
          )
        }
        await idle.queue
        await this.stop(idle.projectId)
      }
      session = {
        projectId,
        sockets: new Set(),
        lastUsed: this.now(),
        state: 'Starting',
        queue: Promise.resolve(),
        eventQueue: Promise.resolve(),
        attribution: new Attribution(),
        pdfs: new Map(),
        paragraphs: new Map(),
        notices: new Map(),
        diagnostics: new Map(),
        pageLists: new Map(),
        layoutVersion: 0,
        engineGeneration: 0,
        crashAt: null,
        stopped: false,
      }
      this.sessions.set(projectId, session)
      session.ready = this.initialize(session)
      try {
        await session.ready
      } catch (error) {
        await this.stop(projectId)
        throw error
      }
    }
    if (socket.readyState !== 1) {
      this.scheduleIdle(session)
      return session
    }
    clearTimeout(session.idleTimer)
    session.sockets.add(socket)
    this.socketAccess.set(socket, getAccess)
    session.lastUsed = this.now()
    socket.once('close', () => this.detach(session, socket))
    this.resync(session, socket)
    return session
  }

  async initialize(session) {
    Object.assign(
      session,
      await this.materializer.materialize(session.projectId)
    )
    if (session.snapshot.compiler !== 'lualatex') {
      throw new PreviewError(
        'compiler_not_lualatex',
        'Live preview requires LuaLaTeX',
        409
      )
    }
    this.startEngine(session)
    await this.publishActive(session)
    session.activePublished = true
    session.activeTimer = setInterval(() => {
      this.enqueue(session, () => this.publishActive(session)).catch(
        this.onError
      )
    }, this.settings.activeLeaseRefreshMs)
    session.activeTimer.unref?.()
  }

  startEngine(session) {
    const engine = this.createEngine()
    session.engine = engine
    const generation = ++session.engineGeneration
    engine.on('event', event => {
      const run = () => {
        if (!session.stopped && session.engineGeneration === generation) {
          return this.handleEvent(session, event)
        }
      }
      session.eventQueue = session.eventQueue.then(run).catch(this.onError)
    })
    engine.on('crash', details => {
      this.enqueue(session, () =>
        this.crashed(session, generation, details)
      ).catch(this.onError)
    })
    engine.start(session.directory, session.snapshot.rootDoc)
  }

  enqueue(session, run) {
    const result = session.queue.then(async () => {
      await session.ready
      if (!session.stopped && session.state !== 'Failed') {
        return run()
      }
    })
    session.queue = result.catch(this.onError)
    return result
  }

  publishActive(session) {
    return this.publish(session, 'livePreview.active', [
      { leaseMs: this.settings.activeLeaseMs },
    ])
  }

  async publish(session, message, payload = []) {
    await this.publisher.publish(
      'editor-events',
      JSON.stringify({
        room_id: session.projectId,
        message,
        payload,
        _id: `live-preview:${randomUUID()}`,
      })
    )
  }

  detach(session, socket) {
    session.sockets.delete(socket)
    this.socketAccess.delete(socket)
    session.lastUsed = this.now()
    if (!session.sockets.size && !session.stopped) {
      this.scheduleIdle(session)
    }
  }

  scheduleIdle(session) {
    clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      this.enqueue(session, () => this.stop(session.projectId)).catch(
        this.onError
      )
    }, this.settings.idleMs)
    session.idleTimer.unref?.()
  }

  send(socket, frame) {
    if (socket.readyState === 1) {
      if (socket.bufferedAmount > 8 * 1024 * 1024) {
        socket.close(1013, 'Preview client is too slow')
      } else {
        socket.send(frame)
      }
    }
  }

  broadcast(session, type, header, body) {
    const frame = encodeFrame(type, header, body)
    for (const socket of session.sockets) {
      this.send(socket, frame)
    }
    return frame
  }

  resync(session, socket) {
    this.send(
      socket,
      encodeFrame('hello', {
        state: session.state,
        layout_version: session.layoutVersion,
        engine_state: session.state,
        pages_total: session.layout?.pages_total || 0,
        ...this.socketAccess.get(socket)?.(),
      })
    )
    if (session.layout) {
      this.send(socket, encodeFrame('layout', session.layout))
    }
    for (const frame of session.paragraphs.values()) {
      this.send(socket, frame)
    }
    for (const frame of session.notices.values()) {
      this.send(socket, frame)
    }
    for (const frame of session.diagnostics.values()) {
      this.send(socket, frame)
    }
  }

  async sourceRange(session, parId) {
    if (parId == null) return {}
    const engine = session.engine
    for (const doc of session.docs.values()) {
      let source
      await engine.command({ cmd: 'spans', path: doc.path }, reply => {
        const span = reply.spans.find(span => span.id === parId)
        if (span) {
          source = {
            path: doc.path,
            doc_id: doc.id,
            source_revision: span.last_revision,
            range: {
              start: utf16Offset(doc.content, span.range.start),
              end: utf16Offset(doc.content, span.range.end),
            },
          }
        }
      })
      if (source) return source
    }
    return {}
  }

  diagnosticItems(session, items = []) {
    return items.map(item => {
      const file = item.file
      const relative =
        file && path.isAbsolute(file)
          ? path.relative(session.directory, file)
          : file?.replace(/^\.\//, '')
      const insideProject =
        relative && !relative.startsWith('../') && !path.isAbsolute(relative)
      return { ...item, file: insideProject ? relative : null }
    })
  }

  noteEdit(session) {
    session.lastUsed = this.now()
    if (session.layoutTimer) {
      return
    }
    session.layoutTimer = setTimeout(
      () => {
        session.layoutTimer = null
        this.enqueue(session, () =>
          session.engine.command({ cmd: 'request_layout' })
        ).catch(this.onError)
      },
      Math.max(
        this.settings.layoutMaxWaitMs,
        (this.settings.layoutMaxWaitFactor ?? 2) * (session.lastPassMs || 0)
      )
    )
    session.layoutTimer.unref?.()
  }

  async handleEvent(session, event) {
    const {
      event: kind,
      dl_b64: encoded,
      pages_changed: pages,
      ...header
    } = event
    if (kind === 'ParagraphUpdate') {
      const attribution = session.attribution.forEvent(event)
      if (attribution.stale) {
        return
      }
      const body = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0)
      const fonts = this.fonts.registerDisplayList(session.projectId, body)
      const frame = this.broadcast(
        session,
        'paragraph',
        {
          ...header,
          ...attribution,
          fonts,
          diagnostics: this.diagnosticItems(session, header.diagnostics),
          ...(event.status === 'error'
            ? await this.sourceRange(session, event.par_id)
            : {}),
        },
        body
      )
      // Resync must reproduce the last good drawing or removal until the pass
      // snapshot catches up. An error is a notification, not a replacement.
      if (event.status !== 'error') {
        session.paragraphs.set(event.par_id, frame)
        session.notices.delete(event.par_id)
      } else {
        session.notices.set(event.par_id, frame)
      }
    } else if (kind === 'LayoutUpdate') {
      if (Number.isFinite(event.wall_ms)) session.lastPassMs = event.wall_ms
      clearTimeout(session.layoutTimer)
      session.layoutTimer = null
      if (snapshotRevision(event) < (event.versions?.source_revision || 0))
        this.noteEdit(session)
      const fonts = {}
      for (const page of pages || []) {
        if (page.dl_b64) {
          session.pageLists.set(
            page.page,
            decodeDisplayList(Buffer.from(page.dl_b64, 'base64'), {
              geometryOnly: true,
            })
          )
        }
        Object.assign(
          fonts,
          this.fonts.registerDisplayList(
            session.projectId,
            Buffer.from(page.dl_b64 || '', 'base64')
          )
        )
      }
      for (const page of session.pageLists.keys()) {
        if (page > event.pages_total) session.pageLists.delete(page)
      }
      session.layoutVersion += 1
      let pdfUrl = null
      if (event.pass_pdf) {
        const relative = path.relative(session.directory, event.pass_pdf)
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new PreviewError(
            'invalid_pdf_path',
            'Engine PDF is outside session directory'
          )
        }
        const directory = path.join(session.directory, '.live-preview-pdfs')
        await assertNoSymlinks(this.fs, session.directory, event.pass_pdf)
        await assertNoSymlinks(this.fs, session.directory, directory)
        await this.fs.mkdir(directory, { recursive: true })
        const destination = path.join(directory, `${session.layoutVersion}.pdf`)
        await assertNoSymlinks(this.fs, session.directory, destination)
        await this.fs.copyFile(event.pass_pdf, destination)
        session.pdfs.set(session.layoutVersion, destination)
        pdfUrl = `/live-preview/pdf/${session.projectId}/${session.layoutVersion}`
      }
      for (const [version, file] of session.pdfs) {
        if (version <= session.layoutVersion - 3) {
          session.pdfs.delete(version)
          await this.fs.rm(file, { force: true })
        }
      }
      session.layout = {
        ...header,
        snapshot_source_revision: snapshotRevision(event),
        layout_version: session.layoutVersion,
        pdf_url: pdfUrl,
        fonts,
        placements: layoutRowRects(event.placements || [], session.pageLists),
      }
      // Preserve paragraph results newer than the pass snapshot.
      for (const [id, frame] of session.paragraphs) {
        const { header: paragraph } = decodeFrame(frame)
        if (!newerThanLayout(paragraph, session.layout)) {
          session.paragraphs.delete(id)
        }
      }
      // rtex emits diagnostics only when nonempty. Clear a previous pass's
      // diagnostics when a clean pass arrives, while keeping fresh warnings.
      if (
        event.compile?.state === 'Ok' &&
        !session.backgroundDiagnosticsPending &&
        session.diagnostics.has('background')
      ) {
        session.diagnostics.delete('background')
        this.broadcast(session, 'diagnostics', {
          source: 'background',
          items: [],
        })
      }
      session.backgroundDiagnosticsPending = false
      if (pdfUrl) await this.missingGlyphs(session)
      this.broadcast(session, 'layout', session.layout)
      const contained = new Set(
        (event.placements || []).map(unit => unit.par_id)
      )
      for (const [id, frame] of session.notices) {
        const notice = decodeFrame(frame).header
        if (
          contained.has(id) &&
          (notice.versions?.source_revision || 0) <=
            snapshotRevision(session.layout)
        ) {
          session.notices.delete(id)
        }
      }
    } else if (kind === 'EngineState') {
      session.state = event.state
      this.broadcast(session, 'engine', header)
    } else if (kind === 'BackgroundScheduled') {
      if (session.attribution.forEvent(event).stale) return
      const source = await this.sourceRange(session, event.par_id)
      const revision = session.attribution.units.get(
        event.par_id
      )?.source_revision
      const frame = this.broadcast(session, 'background', {
        ...header,
        ...source,
        versions: {
          source_revision:
            header.versions?.source_revision ??
            revision ??
            source.source_revision ??
            0,
        },
      })
      if (event.par_id != null) session.notices.set(event.par_id, frame)
    } else if (kind === 'Diagnostics') {
      const items = this.diagnosticItems(session, header.items)
      const frame = this.broadcast(session, 'diagnostics', { ...header, items })
      session.diagnostics.set(header.source, frame)
      if (header.source === 'background')
        session.backgroundDiagnosticsPending = true
    }
  }

  async missingGlyphs(session) {
    const job = path.parse(session.snapshot.rootDoc).name
    const file = path.join(session.directory, 'build/rtex/bg', `${job}.log`)
    let log = ''
    try {
      await assertNoSymlinks(this.fs, session.directory, file)
      log = await this.fs.readFile(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const items = missingGlyphDiagnostics(log, session.docs)
    const source = 'missing-glyphs'
    if (items.length || session.diagnostics.has(source)) {
      const frame = this.broadcast(session, 'diagnostics', { source, items })
      if (items.length) session.diagnostics.set(source, frame)
      else session.diagnostics.delete(source)
    }
  }

  async restart(session, reason) {
    clearTimeout(session.layoutTimer)
    session.layoutTimer = null
    ++session.engineGeneration
    await session.engine.stop()
    await session.eventQueue
    session.attribution = new Attribution()
    session.paragraphs.clear()
    session.notices.clear()
    session.diagnostics.clear()
    session.backgroundDiagnosticsPending = false
    session.pageLists.clear()
    session.state = 'Restarting'
    this.broadcast(session, 'engine', { state: 'Restarting', reason })
    this.startEngine(session)
  }

  async crashed(session, generation, details) {
    if (session.engineGeneration !== generation) {
      return
    }
    if (session.crashAt !== null && this.now() - session.crashAt < 60000) {
      session.state = 'Failed'
      clearInterval(session.activeTimer)
      clearTimeout(session.layoutTimer)
      session.layoutTimer = null
      this.broadcast(session, 'engine', {
        state: 'Failed',
        reason: 'Repeated engine crash',
        details,
      })
      await this.publish(session, 'livePreview.inactive')
      session.activePublished = false
      return
    }
    session.crashAt = this.now()
    await this.restart(session, 'Engine exited')
  }

  async failSource(session, error) {
    session.state = 'Failed'
    ++session.engineGeneration
    clearInterval(session.activeTimer)
    clearTimeout(session.layoutTimer)
    session.layoutTimer = null
    this.broadcast(session, 'engine', {
      state: 'Failed',
      code: error.code || 'source_unavailable',
      reason:
        'Live preview could not read project sources. Retry when the source service is available.',
    })
    await session.engine?.stop()
    await this.publish(session, 'livePreview.inactive')
    session.activePublished = false
  }

  stop(projectId) {
    const session = this.sessions.get(projectId)
    if (!session) {
      return
    }
    if (session.stopped) {
      return session.stopPromise
    }
    session.stopped = true
    clearInterval(session.activeTimer)
    session.stopPromise = this.stopSession(session)
    return session.stopPromise
  }

  async stopSession(session) {
    const projectId = session.projectId
    clearTimeout(session.idleTimer)
    clearTimeout(session.layoutTimer)
    ++session.engineGeneration
    await session.engine?.stop()
    await session.eventQueue
    for (const socket of session.sockets) {
      socket.close(1001, 'Live preview stopped')
    }
    if (session.activePublished) {
      await this.publish(session, 'livePreview.inactive').catch(this.onError)
    }
    this.fonts.releaseProject(projectId)
    if (session.directory) {
      await this.fs.rm(session.directory, { recursive: true, force: true })
    }
    if (this.sessions.get(projectId) === session) {
      this.sessions.delete(projectId)
    }
  }

  async shutdown() {
    await this.admission
    for (const session of this.sessions.values()) {
      await session.queue
      await this.stop(session.projectId)
    }
  }
}
