import { EventEmitter } from 'node:events'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import sinon from 'sinon'
import { SessionManager } from '../../app/src/SessionManager.mjs'
import { decodeFrame } from '../../app/src/Frames.mjs'
import { settingsFromEnv } from '../../config/settings.defaults.mjs'
import { binaryList, binaryRow } from '../helpers/display-list.mjs'

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send: sinon.spy(),
    close: sinon.spy(),
  })
}

describe('SessionManager', () => {
  let manager
  let engines
  let time
  let filesystem
  beforeEach(() => {
    vi.useFakeTimers()
    time = 0
    engines = []
    filesystem = {
      mkdir: sinon.stub().resolves(),
      copyFile: sinon.stub().resolves(),
      rm: sinon.stub().resolves(),
    }
    manager = new SessionManager({
      settings: settingsFromEnv({}),
      materializer: {
        materialize: async projectId => ({
          directory: `/tmp/${projectId}`,
          snapshot: { compiler: 'lualatex', rootDoc: 'main.tex' },
          docs: new Map(),
        }),
      },
      createEngine: () => {
        const engine = Object.assign(new EventEmitter(), {
          start: sinon.spy(),
          stop: sinon.stub().resolves(),
          command: sinon.stub().resolves(),
        })
        engines.push(engine)
        return engine
      },
      publisher: { publish: sinon.stub().resolves() },
      fonts: {
        registerDisplayList: sinon.stub().returns({}),
        releaseProject: sinon.spy(),
      },
      filesystem,
      now: () => time,
    })
  })
  afterEach(async () => {
    await manager.shutdown()
    vi.useRealTimers()
  })
  it('shares one engine and announces active/inactive with native editor shape', async () => {
    const first = socket()
    const second = socket()
    const [a, b] = await Promise.all([
      manager.open('p', first),
      manager.open('p', second),
    ])
    expect(a).toBe(b)
    expect(engines.length).toBe(1)
    const active = JSON.parse(manager.publisher.publish.firstCall.args[1])
    expect(active).toMatchObject({
      room_id: 'p',
      message: 'livePreview.active',
      payload: [{ leaseMs: 75000 }],
    })
    expect(active._id).toMatch(/^live-preview:/)
    await manager.stop('p')
    expect(JSON.parse(manager.publisher.publish.lastCall.args[1]).message).toBe(
      'livePreview.inactive'
    )
  })
  it('keeps hello access credentials specific to each viewer and refreshes on resync', async () => {
    const first = socket()
    const second = socket()
    const getAccess = sinon.stub()
    getAccess.onFirstCall().returns({ access: 'alice', access_expiry: 900000 })
    getAccess
      .onSecondCall()
      .returns({ access: 'alice-new', access_expiry: 1000000 })
    const session = await manager.open('p', first, getAccess)
    await manager.open('p', second, () => ({
      access: 'bob',
      access_expiry: 900000,
    }))
    expect(decodeFrame(first.send.firstCall.args[0]).header.access).toBe(
      'alice'
    )
    expect(decodeFrame(second.send.firstCall.args[0]).header.access).toBe('bob')
    manager.resync(session, first)
    expect(decodeFrame(first.send.lastCall.args[0]).header.access).toBe(
      'alice-new'
    )
  })
  it('refreshes the active lease for late editors and stops refreshing on shutdown', async () => {
    await manager.open('p', socket())
    await vi.advanceTimersByTimeAsync(29999)
    expect(manager.publisher.publish.callCount).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(30000)
    expect(manager.publisher.publish.callCount).toBe(3)
    for (const call of manager.publisher.publish.getCalls()) {
      expect(JSON.parse(call.args[1])).toMatchObject({
        message: 'livePreview.active',
        payload: [{ leaseMs: 75000 }],
      })
    }
    await manager.stop('p')
    await vi.advanceTimersByTimeAsync(90000)
    expect(manager.publisher.publish.callCount).toBe(4)
    expect(
      JSON.parse(manager.publisher.publish.lastCall.args[1])
    ).toMatchObject({
      message: 'livePreview.inactive',
      payload: [],
    })
  })
  it('uses the configured lease refresh interval', async () => {
    manager.settings = settingsFromEnv({
      LIVE_PREVIEW_ACTIVE_LEASE_REFRESH_MS: '10000',
    })
    await manager.open('p', socket())
    await vi.advanceTimersByTimeAsync(10000)
    expect(manager.publisher.publish.callCount).toBe(2)
  })
  it('waits for old engine shutdown before reopening the same project', async () => {
    const session = await manager.open('p', socket())
    let finishStop
    engines[0].stop.callsFake(
      () =>
        new Promise(resolve => {
          finishStop = resolve
        })
    )
    const stopping = manager.stop('p')
    const opening = manager.open('p', socket())
    await Promise.resolve()
    expect(engines.length).toBe(1)
    expect(session.stopped).toBe(true)
    finishStop()
    await stopping
    const next = await opening
    expect(next).not.toBe(session)
    expect(engines.length).toBe(2)
  })
  it('evicts the LRU session without sockets and returns busy when all viewed', async () => {
    const a = socket()
    const b = socket()
    await manager.open('a', a)
    time = 1
    await manager.open('b', b)
    await expect(manager.open('c', socket())).rejects.toMatchObject({
      code: 'busy',
    })
    a.emit('close')
    time = 2
    b.emit('close')
    await manager.open('c', socket())
    expect(manager.sessions.has('a')).toBe(false)
    expect(manager.sessions.has('b')).toBe(true)
  })
  it('reaps five minutes after last close and cancels on reconnect', async () => {
    const first = socket()
    await manager.open('p', first)
    first.emit('close')
    await vi.advanceTimersByTimeAsync(299999)
    expect(manager.sessions.has('p')).toBe(true)
    const second = socket()
    await manager.open('p', second)
    await vi.advanceTimersByTimeAsync(2)
    expect(manager.sessions.has('p')).toBe(true)
    second.emit('close')
    await vi.advanceTimersByTimeAsync(300001)
    expect(manager.sessions.has('p')).toBe(false)
  })
  it('sends erase rectangles from changed pages, retains unchanged pages, and prunes deleted pages', async () => {
    const viewer = socket()
    const session = await manager.open('p', viewer)
    const placements = [
      {
        par_id: 99,
        fragments: [
          {
            page: 2,
            first_line: 1,
            last_line: 1,
            x: 100,
            xs: [100],
            baselines: [200],
          },
        ],
      },
    ]
    const layout = {
      event: 'LayoutUpdate',
      pages_total: 2,
      placements,
      versions: { source_revision: 0 },
    }
    await manager.handleEvent(session, {
      ...layout,
      pages_changed: [
        { page: 2, dl_b64: binaryList(binaryRow()).toString('base64') },
      ],
    })
    const expected = [{ page: 2, x: 100, y: 150, w: 300, h: 60 }]
    expect(session.layout.placements[0].row_rects).toEqual(expected)
    await manager.handleEvent(session, { ...layout, pages_changed: [] })
    expect(session.layout.placements[0].row_rects).toEqual(expected)
    manager.resync(session, viewer)
    expect(
      decodeFrame(viewer.send.lastCall.args[0]).header.placements[0].row_rects
    ).toEqual(expected)
    await manager.handleEvent(session, {
      ...layout,
      pages_total: 1,
      pages_changed: [],
    })
    expect(session.pageLists.has(2)).toBe(false)
    expect(session.layout.placements[0].row_rects).toEqual([])
  })

  it('resyncs last good drawings after errors and replays removals until a pass catches up', async () => {
    const viewer = socket()
    const session = await manager.open('p', viewer)
    const paragraph = {
      event: 'ParagraphUpdate',
      par_id: 1,
      status: 'ok',
      versions: { source_revision: 1 },
    }
    await manager.handleEvent(session, paragraph)
    await manager.handleEvent(session, { ...paragraph, status: 'error' })
    manager.resync(session, viewer)
    expect(decodeFrame(viewer.send.lastCall.args[0]).header.status).toBe('ok')
    await manager.handleEvent(session, {
      ...paragraph,
      status: 'removed',
      versions: { source_revision: 2 },
    })
    manager.resync(session, viewer)
    expect(decodeFrame(viewer.send.lastCall.args[0]).header.status).toBe(
      'removed'
    )
    await manager.handleEvent(session, {
      event: 'LayoutUpdate',
      pages_total: 1,
      placements: [],
      versions: { source_revision: 1 },
    })
    expect(session.paragraphs.has(1)).toBe(true)
    await manager.handleEvent(session, {
      event: 'LayoutUpdate',
      pages_total: 1,
      placements: [],
      versions: { source_revision: 2 },
    })
    expect(session.paragraphs.has(1)).toBe(false)
  })

  it('forces a layout after three seconds despite continuous edits', async () => {
    const session = await manager.open('p', socket())
    for (let index = 0; index < 30; index++) {
      manager.noteEdit(session)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(
      engines[0].command.calledOnceWithExactly({ cmd: 'request_layout' })
    ).toBe(true)
  })
  it('restarts once, fails on a second crash in one minute, resets on next open', async () => {
    const viewer = socket()
    const session = await manager.open('p', viewer)
    engines[0].emit('crash', { code: 1 })
    await session.queue
    expect(engines.length).toBe(2)
    time = 1000
    engines[1].emit('crash', { code: 1 })
    await session.queue
    expect(session.state).toBe('Failed')
    const notices = manager.publisher.publish.callCount
    await vi.advanceTimersByTimeAsync(90000)
    expect(manager.publisher.publish.callCount).toBe(notices)
    const next = await manager.open('p', socket())
    expect(next).not.toBe(session)
    expect(engines.length).toBe(3)
  })
  it('keeps the last three PDFs, broadcasts matching frames and restores overlays', async () => {
    const viewer = socket()
    const session = await manager.open('p', viewer)
    for (let version = 1; version <= 4; version++) {
      await manager.handleEvent(session, {
        event: 'LayoutUpdate',
        pass_pdf: '/tmp/p/build/rtex/pass.pdf',
        pages_total: 1,
        placements: [],
        versions: { source_revision: version },
      })
    }
    expect([...session.pdfs.keys()]).toEqual([2, 3, 4])
    expect(filesystem.rm.calledWith('/tmp/p/.live-preview-pdfs/1.pdf')).toBe(
      true
    )
    const event = {
      event: 'ParagraphUpdate',
      par_id: 1,
      edit_id: 10,
      status: 'ok',
      versions: { source_revision: 10 },
    }
    session.attribution.record(
      { edit_id: 10, outcome: { touched: [1] } },
      'alice'
    )
    await manager.handleEvent(session, event)
    expect(decodeFrame(viewer.send.lastCall.args[0]).header.user_id).toBe(
      'alice'
    )
    const newViewer = socket()
    manager.resync(session, newViewer)
    expect(
      newViewer.send.getCalls().map(call => decodeFrame(call.args[0]).type)
    ).toEqual(['hello', 'layout', 'paragraph'])
  })
  it('rejects PDFs outside the session and disconnects slow viewers', async () => {
    const viewer = socket()
    const session = await manager.open('p', viewer)
    await expect(
      manager.handleEvent(session, {
        event: 'LayoutUpdate',
        pass_pdf: '/etc/passwd',
      })
    ).rejects.toThrow('outside')
    viewer.bufferedAmount = 9 * 1024 * 1024
    manager.broadcast(session, 'engine', { state: 'Ready' })
    expect(viewer.close.calledWith(1013)).toBe(true)
  })
})
