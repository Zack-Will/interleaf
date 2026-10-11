import { EventEmitter } from 'node:events'
import { describe, it, expect, beforeEach } from 'vitest'
import sinon from 'sinon'
import { OpsConsumer } from '../../app/src/OpsConsumer.mjs'
import { Attribution } from '../../app/src/Attribution.mjs'

describe('OpsConsumer', () => {
  let consumer
  let manager
  let session
  let doc
  let fetchDocument
  let materializer
  beforeEach(() => {
    doc = { id: 'd', path: 'main.tex', content: '中😀abc', version: 0 }
    session = {
      projectId: 'p',
      directory: '/tmp/project',
      docs: new Map([['d', doc]]),
      attribution: new Attribution(),
      snapshot: { rootDoc: 'main.tex' },
      engine: {
        command: sinon.stub().callsFake(async (command, onReply) => {
          onReply?.({
            result: {
              edit_id: doc.version + 1,
              source_revision: doc.version + 1,
              outcome: { touched: [1] },
            },
          })
          return {}
        }),
      },
    }
    manager = {
      sessions: new Map([['p', session]]),
      enqueue: async (entry, run) => run(),
      noteEdit: sinon.spy(),
      restart: sinon.stub().resolves(),
      stop: sinon.stub().resolves(),
      failSource: sinon.stub().resolves(),
    }
    materializer = {
      checkSize: sinon.stub(),
      write: sinon.stub().resolves(),
      snapshot: sinon.stub(),
      writeSnapshot: sinon.stub().resolves(),
    }
    fetchDocument = sinon.stub()
    consumer = new OpsConsumer({
      subscriber: new EventEmitter(),
      manager,
      fetchDocument,
      materializer,
    })
  })
  function consume(op) {
    return consumer.consume('applied-ops', { project_id: 'p', doc_id: 'd', op })
  }
  it('skips dup and comments, applies sequential UTF-16 components and records user', async () => {
    await consume({ dup: true, v: 0, op: [{ p: 0, i: 'bad' }] })
    await consume({ v: 0, op: [{ c: 'comment' }] })
    expect(session.engine.command.called).toBe(false)
    expect(doc.version).toBe(1)
    await consume({
      v: 1,
      meta: { user_id: 'alice' },
      op: [
        { p: 3, d: 'a' },
        { p: 3, i: '文' },
      ],
    })
    expect(doc.content).toBe('中😀文bc')
    expect(session.engine.command.firstCall.args[0]).toEqual({
      cmd: 'edit',
      path: 'main.tex',
      start: 7,
      end: 8,
      text: '',
    })
    expect(
      session.attribution.forEvent({ par_id: 1, edit_id: 2 }).user_id
    ).toBe('alice')
  })
  it('updates the text mirror at each reply before events or asynchronous disk writes', async () => {
    const mirrored = []
    session.engine.command.callsFake(async (command, onReply) => {
      onReply({
        result: { edit_id: 1, source_revision: 1, outcome: { touched: [1] } },
      })
      mirrored.push(doc.content)
    })
    materializer.write.callsFake(async () => {
      expect(doc.content).toBe('中😀文bc')
    })
    await consume({
      v: 0,
      op: [
        { p: 3, d: 'a' },
        { p: 3, i: '文' },
      ],
    })
    expect(mirrored).toEqual(['中😀bc', '中😀文bc'])
  })

  it('replays gaps from document-updater in version order', async () => {
    fetchDocument.resolves({
      lines: ['中😀xyabc'],
      version: 2,
      ops: [
        { v: 0, op: [{ p: 3, i: 'x' }] },
        { v: 1, op: [{ p: 4, i: 'y' }] },
      ],
    })
    await consume({ v: 1, op: [{ p: 4, i: 'y' }] })
    expect(fetchDocument.calledWith('p', 'd', 0)).toBe(true)
    expect(doc.content).toBe('中😀xyabc')
    expect(doc.version).toBe(2)
    await consume({ v: 0, op: [{ p: 3, i: 'x' }] })
    await consume({ v: 1, op: [{ p: 4, i: 'y' }] })
    expect(fetchDocument.callCount).toBe(1)
    expect(session.engine.command.callCount).toBe(2)
    expect(doc.content).toBe('中😀xyabc')
    expect(
      session.engine.command
        .getCalls()
        .every(call => call.args[0].cmd === 'edit')
    ).toBe(true)
  })
  it('handles an out-of-order notification without applying it twice', async () => {
    doc.version = 2
    fetchDocument.resolves({ lines: [doc.content], version: 2, ops: [] })
    await consume({ v: 0, op: [{ p: 0, i: 'bad' }] })
    expect(doc.version).toBe(2)
    expect(session.engine.command.called).toBe(false)
    expect(fetchDocument.called).toBe(false)
    await consume({ v: 1, op: [{ retain: 4, insert: 'old' }] })
    expect(fetchDocument.called).toBe(false)
  })
  it('falls back to whole document when replay is unavailable', async () => {
    fetchDocument.onFirstCall().rejects(new Error('ops expired'))
    fetchDocument.onSecondCall().resolves({ lines: ['full text'], version: 9 })
    await consume({ v: 8, op: [{ p: 0, i: 'x' }] })
    expect(fetchDocument.secondCall.args).toEqual(['p', 'd'])
    expect(session.engine.command.firstCall.args[0].cmd).toBe('set_document')
    expect(doc.content).toBe('full text')
  })
  it('refetches history-ot and invalid deletes', async () => {
    fetchDocument.resolves({
      lines: ['authoritative'],
      version: 5,
      type: 'history-ot',
    })
    await consume({
      v: 0,
      op: [{ retain: 4, insert: 'x' }],
      meta: { user_id: 'bob' },
    })
    expect(doc.version).toBe(5)
    expect(session.engine.command.firstCall.args[0].cmd).toBe('set_document')
    expect(
      session.attribution.forEvent({ par_id: 1, edit_id: 1 }).user_id
    ).toBe('bob')
  })
  it('resyncs drift without flush endpoints and ignores unrelated projects', async () => {
    fetchDocument.resolves({ lines: ['updated'], version: 7, ops: [] })
    await consumer.checkDrift()
    expect(doc.content).toBe('updated')
    await consumer.consume('applied-ops', {
      project_id: 'other',
      doc_id: 'd',
      op: { v: 0 },
    })
    expect(fetchDocument.callCount).toBe(2)
  })
  it.each([
    'reciveNewDoc',
    'reciveNewFile',
    'reciveEntityRename',
    'reciveEntityMove',
    'removeEntity',
    'rootDocUpdated',
  ])('reconciles %s from an authoritative snapshot', async message => {
    materializer.snapshot.resolves({
      compiler: 'lualatex',
      rootDoc: message === 'rootDocUpdated' ? 'new.tex' : 'main.tex',
      docs: [doc, { id: 'new', path: 'new.tex', content: 'new', version: 0 }],
      files: [],
    })
    await consumer.consume('editor-events', {
      room_id: 'p',
      message,
      payload: ['folder', { _id: 'new' }],
    })
    expect(materializer.writeSnapshot.calledOnce).toBe(true)
    expect(session.docs.has('new')).toBe(true)
    if (
      [
        'reciveEntityRename',
        'reciveEntityMove',
        'removeEntity',
        'rootDocUpdated',
      ].includes(message)
    ) {
      expect(manager.restart.calledOnce).toBe(true)
    } else {
      expect(session.engine.command.lastCall.args[0].cmd).toBe('request_layout')
    }
  })
  it('stops on compiler change or deletion', async () => {
    await consumer.consume('editor-events', {
      room_id: 'p',
      message: 'compilerUpdated',
      payload: ['pdflatex'],
    })
    await consumer.consume('editor-events', {
      room_id: 'p',
      message: 'projectDeleted',
      payload: [],
    })
    expect(manager.stop.callCount).toBe(2)
  })
  it.each(['document', 'snapshot', 'drift'])(
    'reports %s service failures without restarting rtex',
    async source => {
      const error = Object.assign(new Error('unavailable'), {
        code: 'upstream_failed',
      })
      fetchDocument.rejects(error)
      materializer.snapshot.rejects(error)
      let result
      if (source === 'document')
        result = consume({ v: 5, op: [{ p: 0, i: 'x' }] })
      else if (source === 'snapshot')
        result = consumer.consume('editor-events', {
          room_id: 'p',
          message: 'rootDocUpdated',
          payload: [],
        })
      else result = consumer.checkDrift()
      await expect(result).rejects.toBe(error)
      expect(manager.failSource.calledOnceWithExactly(session, error)).toBe(
        true
      )
      expect(manager.restart.called).toBe(false)
    }
  )
})
