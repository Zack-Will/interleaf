import { convertComponent } from './Offsets.mjs'

const structureEvents = new Set([
  'reciveNewDoc',
  'reciveNewFile',
  'reciveEntityRename',
  'reciveEntityMove',
  'removeEntity',
  'rootDocUpdated',
  'compilerUpdated',
])

function isTextOp(op) {
  return (
    Array.isArray(op.op) &&
    op.op.every(
      component =>
        component.c !== undefined ||
        (Number.isSafeInteger(component.p) &&
          (typeof component.i === 'string' || typeof component.d === 'string'))
    )
  )
}

function documentContent(document) {
  return document.lines.join('\n')
}

export class OpsConsumer {
  constructor({
    subscriber,
    manager,
    fetchDocument,
    materializer,
    driftMs = 30000,
    onError = () => {},
  }) {
    this.subscriber = subscriber
    this.manager = manager
    this.fetchDocument = fetchDocument
    this.materializer = materializer
    this.driftMs = driftMs
    this.onError = onError
    this.onMessage = (channel, raw) => {
      try {
        const message = JSON.parse(raw)
        this.consume(channel, message).catch(this.onError)
      } catch (error) {
        this.onError(error)
      }
    }
  }

  async start() {
    this.subscriber.on('message', this.onMessage)
    await this.subscriber.subscribe('applied-ops', 'editor-events')
    this.timer = setInterval(
      () => this.checkDrift().catch(this.onError),
      this.driftMs
    )
    this.timer.unref?.()
  }

  async stop() {
    clearInterval(this.timer)
    this.subscriber.off('message', this.onMessage)
    await this.subscriber.unsubscribe('applied-ops', 'editor-events')
  }

  async consume(channel, message) {
    const projectId =
      channel === 'applied-ops' ? message.project_id : message.room_id
    const session = this.manager.sessions.get(projectId)
    if (!session || message.health_check) {
      return
    }
    return this.manager.enqueue(session, async () => {
      if (channel === 'applied-ops' && message.op && !message.op.dup) {
        const doc = session.docs.get(message.doc_id)
        if (doc) {
          await this.applyOrRecover(session, doc, message.op)
        }
      } else if (channel === 'editor-events') {
        await this.structure(session, message)
      }
    })
  }

  async applyOrRecover(session, doc, op) {
    if (!isTextOp(op)) {
      await this.refetch(session, doc, op.meta?.user_id)
      return
    }
    if (op.v !== doc.version) {
      await this.recover(session, doc)
      return
    }
    try {
      await this.apply(session, doc, op)
    } catch {
      await this.refetch(session, doc, op.meta?.user_id)
    }
  }

  async apply(session, doc, op) {
    // Validate every component against the evolving text before sending any edit.
    let content = doc.content
    const edits = []
    for (const component of op.op) {
      if (component.c !== undefined) {
        continue
      }
      const edit = convertComponent(content, component)
      content = edit.content
      edits.push(edit)
    }
    for (const edit of edits) {
      this.manager.noteEdit(session)
      await session.engine.command(
        {
          cmd: 'edit',
          path: doc.path,
          start: edit.start,
          end: edit.end,
          text: edit.text,
        },
        reply => session.attribution.record(reply.result, op.meta?.user_id)
      )
    }
    await this.materializer.write(session.directory, doc.path, content)
    doc.content = content
    doc.version = op.v + 1
  }

  async recover(session, doc) {
    try {
      const remote = await this.fetchDocument(
        session.projectId,
        doc.id,
        doc.version
      )
      if (remote.type === 'history-ot' || !Array.isArray(remote.ops)) {
        await this.replace(session, doc, remote)
        return
      }
      for (const op of remote.ops) {
        if (op.dup || op.v < doc.version) {
          continue
        }
        if (op.v !== doc.version || !isTextOp(op)) {
          await this.replace(session, doc, remote)
          return
        }
        await this.apply(session, doc, op)
      }
      if (
        doc.version !== remote.version ||
        doc.content !== documentContent(remote)
      ) {
        await this.replace(session, doc, remote)
      }
    } catch {
      await this.refetch(session, doc)
    }
  }

  async refetch(session, doc, userId) {
    const remote = await this.fetchDocument(session.projectId, doc.id)
    await this.replace(session, doc, remote, userId)
  }

  async replace(session, doc, remote, userId) {
    const content = documentContent(remote)
    this.manager.noteEdit(session)
    await session.engine.command(
      { cmd: 'set_document', path: doc.path, text: content },
      reply => session.attribution.record(reply.result, userId)
    )
    await this.materializer.write(session.directory, doc.path, content)
    doc.content = content
    doc.version = remote.version
  }

  async checkDrift() {
    for (const session of this.manager.sessions.values()) {
      await this.manager.enqueue(session, async () => {
        for (const doc of session.docs.values()) {
          const remote = await this.fetchDocument(
            session.projectId,
            doc.id,
            doc.version
          )
          if (
            remote.version !== doc.version ||
            documentContent(remote) !== doc.content
          ) {
            await this.recover(session, doc)
          }
        }
      })
    }
  }

  async structure(session, message) {
    if (message.message === 'projectDeleted') {
      await this.manager.stop(session.projectId)
      return
    }
    if (!structureEvents.has(message.message)) {
      return
    }
    if (
      message.message === 'compilerUpdated' &&
      message.payload[0] !== 'lualatex'
    ) {
      await this.manager.stop(session.projectId)
      return
    }
    const snapshot = await this.materializer.snapshot(session.projectId)
    if (snapshot.compiler !== 'lualatex') {
      await this.manager.stop(session.projectId)
      return
    }
    const previousDocs = session.docs
    await this.materializer.writeSnapshot(
      session.directory,
      snapshot,
      session.snapshot
    )
    const topologyChanged = [...previousDocs.values()].some(
      doc =>
        !snapshot.docs.some(
          entry => entry.id === doc.id && entry.path === doc.path
        )
    )
    const restart =
      topologyChanged ||
      snapshot.rootDoc !== session.snapshot.rootDoc ||
      ['reciveEntityRename', 'reciveEntityMove', 'removeEntity'].includes(
        message.message
      )
    session.snapshot = snapshot
    session.docs = new Map(snapshot.docs.map(doc => [doc.id, { ...doc }]))
    if (restart) {
      await this.manager.restart(session, 'Project structure changed')
    } else {
      for (const doc of session.docs.values()) {
        if (previousDocs.get(doc.id)?.content !== doc.content) {
          this.manager.noteEdit(session)
          await session.engine.command(
            { cmd: 'set_document', path: doc.path, text: doc.content },
            reply =>
              session.attribution.record(reply.result, message.payload?.at(-1))
          )
        }
      }
      await session.engine.command({ cmd: 'request_layout' })
    }
  }
}
