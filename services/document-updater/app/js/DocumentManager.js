const { callbackifyAll } = require('@overleaf/promise-utils')
const RedisManager = require('./RedisManager')
const ProjectHistoryRedisManager = require('./ProjectHistoryRedisManager')
const PersistenceManager = require('./PersistenceManager')
const DiffCodec = require('./DiffCodec')
const logger = require('@overleaf/logger')
const Metrics = require('./Metrics')
const HistoryManager = require('./HistoryManager')
const Errors = require('./Errors')
const RangesManager = require('./RangesManager')
const { extractOriginOrSource } = require('./Utils')
const { getTotalSizeOfLines } = require('./Limits')
const Settings = require('@overleaf/settings')
const RangesTracker = require('@overleaf/ranges-tracker')
const { StringFileData } = require('overleaf-editor-core')

const MAX_UNFLUSHED_AGE = Settings.maxUnflushedAgeMs // document should be flushed to mongo this time after a change

/**
 * @import { Ranges, TrackedChange } from './types'
 */

/**
 * The text a tracked change covers, which is the inserted text for a tracked
 * insert and the deleted text for a tracked delete.
 *
 * @param {TrackedChange} change
 * @return {string}
 */
function getTrackedChangeText(change) {
  const op = change.op || {}
  if (typeof op.i === 'string') {
    return `i:${op.i}`
  }
  if (typeof op.d === 'string') {
    return `d:${op.d}`
  }
  return ''
}

/**
 * The tracked changes a single update produced.
 *
 * A change the update created has an id built from the update's id seed
 * (`RangesTracker.newId()` is `idSeed` plus a counter), which is exact.  An
 * update can also grow a tracked change that was already there, when it edits
 * right up against an existing tracked change of the same user: those are
 * merged into the old change and keep its id, so they are recognised by their
 * text having changed.  Position alone is not enough — every change after an
 * edit is shifted along without being part of it — and the timestamp is not
 * enough either, because a merge keeps the *older* of the two (`pickTimestamp`
 * in `libraries/ranges-tracker/index.cjs`).  Server-side change metadata only
 * carries `user_id`, so the ownership test is on that alone.
 *
 * @param {Ranges | undefined} rangesBefore
 * @param {Ranges | undefined} rangesAfter
 * @param {string} idSeed
 * @param {string} userId
 * @return {string[]}
 */
function findTrackedChangeIds(rangesBefore, rangesAfter, idSeed, userId) {
  const textBefore = new Map(
    (rangesBefore?.changes || []).map(change => [
      change.id,
      getTrackedChangeText(change),
    ])
  )
  const ids = []
  for (const change of rangesAfter?.changes || []) {
    if (String(change.id).startsWith(idSeed)) {
      ids.push(change.id)
      continue
    }
    if (String(change.metadata?.user_id ?? '') !== String(userId ?? '')) {
      continue
    }
    const before = textBefore.get(change.id)
    if (before != null && before !== getTrackedChangeText(change)) {
      ids.push(change.id)
    }
  }
  return ids
}

const DocumentManager = {
  /**
   * @param {string} projectId
   * @param {string} docId
   * @return {Promise<{lines: (string[] | StringFileRawData), version: number, ranges: Ranges, resolvedCommentIds: any[], pathname: string, projectHistoryId: string, unflushedTime: any, alreadyLoaded: boolean, historyRangesSupport: boolean, type: OTType}>}
   */
  async getDoc(projectId, docId) {
    const {
      lines,
      version,
      ranges,
      resolvedCommentIds,
      pathname,
      projectHistoryId,
      unflushedTime,
      historyRangesSupport,
    } = await RedisManager.promises.getDoc(projectId, docId)
    if (lines == null || version == null) {
      logger.debug(
        { projectId, docId },
        'doc not in redis so getting from persistence API'
      )
      const {
        lines,
        version,
        ranges,
        resolvedCommentIds,
        pathname,
        projectHistoryId,
        historyRangesSupport,
      } = await PersistenceManager.promises.getDoc(projectId, docId)
      logger.debug(
        {
          projectId,
          docId,
          lines,
          ranges,
          resolvedCommentIds,
          version,
          pathname,
          projectHistoryId,
          historyRangesSupport,
        },
        'got doc from persistence API'
      )
      await RedisManager.promises.putDocInMemory(
        projectId,
        docId,
        lines,
        version,
        ranges,
        resolvedCommentIds,
        pathname,
        projectHistoryId,
        historyRangesSupport
      )
      return {
        lines,
        version,
        ranges: ranges || {},
        resolvedCommentIds,
        pathname,
        projectHistoryId,
        unflushedTime: null,
        alreadyLoaded: false,
        historyRangesSupport,
        type: Array.isArray(lines) ? 'sharejs-text-ot' : 'history-ot',
      }
    } else {
      return {
        lines,
        version,
        ranges,
        pathname,
        projectHistoryId,
        resolvedCommentIds,
        unflushedTime,
        alreadyLoaded: true,
        historyRangesSupport,
        type: Array.isArray(lines) ? 'sharejs-text-ot' : 'history-ot',
      }
    }
  },

  async getDocAndRecentOps(projectId, docId, fromVersion) {
    const { lines, version, ranges, pathname, projectHistoryId, type } =
      await DocumentManager.getDoc(projectId, docId)

    if (fromVersion === -1) {
      return {
        lines,
        version,
        ops: [],
        ranges,
        pathname,
        projectHistoryId,
        type,
      }
    } else {
      const ops = await RedisManager.promises.getPreviousDocOps(
        docId,
        fromVersion,
        version
      )
      return {
        lines,
        version,
        ops,
        ranges,
        pathname,
        projectHistoryId,
        type,
      }
    }
  },

  async appendToDoc(projectId, docId, linesToAppend, originOrSource, userId) {
    let { lines: currentLines, type } = await DocumentManager.getDoc(
      projectId,
      docId
    )
    if (type === 'history-ot') {
      const file = StringFileData.fromRaw(currentLines)
      // TODO(24596): tc support for history-ot
      currentLines = file.getLines()
    }
    const currentLineSize = getTotalSizeOfLines(currentLines)
    const addedSize = getTotalSizeOfLines(linesToAppend)
    const newlineSize = '\n'.length

    if (currentLineSize + newlineSize + addedSize > Settings.max_doc_length) {
      throw new Errors.FileTooLargeError(
        'doc would become too large if appending this text'
      )
    }

    return await DocumentManager.setDoc(
      projectId,
      docId,
      currentLines.concat(linesToAppend),
      originOrSource,
      userId,
      false,
      false
    )
  },

  async setDoc(
    projectId,
    docId,
    newLines,
    originOrSource,
    userId,
    undoing,
    external,
    trackChanges = false
  ) {
    if (newLines == null) {
      throw new Error('No lines were provided to setDoc')
    }

    // Circular dependencies. Import at runtime.
    const HistoryOTUpdateManager = require('./HistoryOTUpdateManager')
    const UpdateManager = require('./UpdateManager')

    const {
      lines: oldLines,
      version,
      ranges: oldRanges,
      alreadyLoaded,
      type,
    } = await DocumentManager.getDoc(projectId, docId)

    // Tracked changes only exist on sharejs documents: `RangesManager` is not
    // part of the history-ot path at all, so there is nothing to attach them to.
    if (trackChanges && type === 'history-ot') {
      throw new Errors.OTTypeMismatchError(type, 'sharejs-text-ot')
    }

    logger.debug(
      { docId, projectId, oldLines, newLines },
      'setting a document via http'
    )

    let op
    if (type === 'history-ot') {
      const file = StringFileData.fromRaw(oldLines)
      const operation = DiffCodec.diffAsHistoryOTEditOperation(
        file,
        newLines.join('\n')
      )
      if (operation.isNoop()) {
        op = []
      } else {
        op = [operation.toJSON()]
      }
    } else {
      op = DiffCodec.diffAsShareJsOp(oldLines, newLines)
      if (undoing) {
        for (const o of op || []) {
          o.u = true
        } // Turn on undo flag for each op for track changes
      }
    }

    const { origin, source } = extractOriginOrSource(originOrSource)

    const update = {
      doc: docId,
      op,
      v: version,
      meta: {
        user_id: userId,
      },
    }
    if (external) {
      update.meta.type = 'external'
    }
    if (origin) {
      update.meta.origin = origin
    } else if (source) {
      update.meta.source = source
    }
    // `meta.tc` is what the websocket path carries when a user edits with track
    // changes on: `RangesManager.applyUpdate` reads it, turns tracking on for
    // this update and seeds the ids of the changes it records.
    const idSeed = trackChanges ? RangesTracker.generateIdSeed() : null
    if (idSeed) {
      update.meta.tc = idSeed
    }
    // Keep track of external updates, whether they are for live documents
    // (flush) or unloaded documents (evict), and whether the update is a no-op.
    Metrics.inc('external-update', 1, {
      status: op.length > 0 ? 'diff' : 'noop',
      method: alreadyLoaded ? 'flush' : 'evict',
      path: source,
    })

    // Do not notify the frontend about a noop update.
    // We still want to execute the code below
    // to evict the doc if we loaded it into redis for
    // this update, otherwise the doc would never be
    // removed from redis.
    if (op.length > 0) {
      if (type === 'history-ot') {
        await HistoryOTUpdateManager.applyUpdate(projectId, docId, update)
      } else {
        await UpdateManager.promises.applyUpdate(projectId, docId, update)
      }
    }

    // Read the tracked changes back from the ranges rather than deriving them
    // from the ops we sent: the update is transformed against whatever was
    // queued ahead of it, and adjacent changes of the same user are merged.
    let changeIds = null
    if (idSeed && op.length === 0) {
      changeIds = []
    } else if (idSeed) {
      const { ranges: newRanges } = await DocumentManager.getDoc(
        projectId,
        docId
      )
      changeIds = findTrackedChangeIds(oldRanges, newRanges, idSeed, userId)
    }

    // If the document was loaded already, then someone has it open
    // in a project, and the usual flushing mechanism will happen.
    // Otherwise we should remove it immediately since nothing else
    // is using it.
    let result
    if (alreadyLoaded) {
      result = await DocumentManager.flushDocIfLoaded(projectId, docId)
    } else {
      try {
        result = await DocumentManager.flushAndDeleteDoc(projectId, docId, {})
      } finally {
        // There is no harm in flushing project history if the previous
        // call failed and sometimes it is required
        HistoryManager.flushProjectChangesAsync(projectId)
      }
    }
    if (changeIds == null) {
      return result
    }
    return { ...(result || {}), changeIds }
  },

  async flushDocIfLoaded(projectId, docId) {
    let {
      lines,
      version,
      ranges,
      unflushedTime,
      lastUpdatedAt,
      lastUpdatedBy,
    } = await RedisManager.promises.getDoc(projectId, docId)
    if (lines == null || version == null) {
      Metrics.inc('flush-doc-if-loaded', 1, { status: 'not-loaded' })
      logger.debug({ projectId, docId }, 'doc is not loaded so not flushing')
      // TODO: return a flag to bail out, as we go on to remove doc from memory?
      return
    } else if (unflushedTime == null) {
      Metrics.inc('flush-doc-if-loaded', 1, { status: 'unmodified' })
      logger.debug({ projectId, docId }, 'doc is not modified so not flushing')
      return
    }

    logger.debug({ projectId, docId, version }, 'flushing doc')
    Metrics.inc('flush-doc-if-loaded', 1, { status: 'modified' })
    if (!Array.isArray(lines)) {
      const file = StringFileData.fromRaw(lines)
      // TODO(24596): tc support for history-ot
      lines = file.getLines()
    }
    const result = await PersistenceManager.promises.setDoc(
      projectId,
      docId,
      lines,
      version,
      ranges,
      lastUpdatedAt,
      lastUpdatedBy || null
    )
    await RedisManager.promises.clearUnflushedTime(docId)
    return result
  },

  async flushAndDeleteDoc(projectId, docId, options) {
    let result
    try {
      result = await DocumentManager.flushDocIfLoaded(projectId, docId)
    } catch (error) {
      if (options.ignoreFlushErrors) {
        logger.warn(
          { projectId, docId, err: error },
          'ignoring flush error while deleting document'
        )
      } else {
        throw error
      }
    }

    await RedisManager.promises.removeDocFromMemory(projectId, docId)
    return result
  },

  async acceptChanges(projectId, docId, changeIds) {
    if (changeIds == null) {
      changeIds = []
    }
    let changeContributors = []

    const {
      lines,
      version,
      ranges,
      pathname,
      projectHistoryId,
      historyRangesSupport,
    } = await DocumentManager.getDoc(projectId, docId)
    if (lines == null || version == null) {
      throw new Errors.NotFoundError(`document not found: ${docId}`)
    }

    // TODO(24596): tc support for history-ot
    const newRanges = RangesManager.acceptChanges(
      projectId,
      docId,
      changeIds,
      ranges,
      lines
    )

    await RedisManager.promises.updateDocument(
      projectId,
      docId,
      lines,
      version,
      [],
      newRanges,
      {}
    )

    if (historyRangesSupport) {
      const historyUpdates = RangesManager.getHistoryUpdatesForAcceptedChanges({
        docId,
        acceptedChangeIds: changeIds,
        changes: ranges.changes || [],
        lines,
        pathname,
        projectHistoryId,
      })

      if (historyUpdates.length === 0) {
        return changeContributors
      }

      await ProjectHistoryRedisManager.promises.queueOps(
        projectId,
        ...historyUpdates.map(op => JSON.stringify(op))
      )
    }
    changeContributors = (ranges.changes || [])
      .filter(change => changeIds.includes(change.id))
      .map(change => change?.metadata?.user_id)
      .filter(userId => userId)
    return changeContributors
  },

  async rejectChanges(projectId, docId, changeIds, userId) {
    const UpdateManager = require('./UpdateManager')
    const HistoryOTUpdateManager = require('./HistoryOTUpdateManager')

    const { lines, version, ranges } = await DocumentManager.getDoc(
      projectId,
      docId
    )
    if (lines == null || version == null) {
      throw new Errors.NotFoundError(`document not found: ${docId}`)
    }

    const changesToReject = ranges.changes
      ? ranges.changes.filter(change => changeIds.includes(change.id))
      : []

    // Apply inverted operations for rejected changes (based on reject-changes.ts logic)
    // Sort changes in reverse order by position to avoid conflicts
    changesToReject.sort((a, b) => b.op.p - a.op.p)

    const ops = []
    for (const change of changesToReject) {
      if (change.op.i) {
        const deleteOp = {
          p: change.op.p,
          d: change.op.i,
          u: true,
        }
        ops.push(deleteOp)
      } else if (change.op.d) {
        const insertOp = {
          p: change.op.p,
          i: change.op.d,
          u: true,
        }
        ops.push(insertOp)
      }
    }

    const update = {
      doc: docId,
      op: ops,
      v: version,
      meta: {
        user_id: userId,
        ts: new Date().toISOString(),
      },
    }

    if (HistoryOTUpdateManager.isHistoryOTEditOperationUpdate(update)) {
      await HistoryOTUpdateManager.applyUpdate(projectId, docId, update)
    } else {
      await UpdateManager.promises.applyUpdate(projectId, docId, update)
    }

    return { rejectedChangeIds: changesToReject.map(c => c.id) }
  },

  /**
   * Anchor a comment thread to a range of the document.
   *
   * The editor does this over the websocket; this is the HTTP equivalent for
   * callers such as the review API. Submitting a thread id that is already
   * anchored moves the existing comment instead of creating a second one.
   *
   * @param {string} projectId
   * @param {string} docId
   * @param {{threadId: string, position: number, text: string}} comment
   * @param {string} userId
   * @return {Promise<{comment: Comment, version: number}>}
   */
  async addComment(projectId, docId, { threadId, position, text }, userId) {
    // Circular dependency. Import at runtime.
    const UpdateManager = require('./UpdateManager')

    const { lines, version, alreadyLoaded, type } =
      await DocumentManager.getDoc(projectId, docId)
    if (lines == null || version == null) {
      throw new Errors.NotFoundError(`document not found: ${docId}`)
    }
    if (type !== 'sharejs-text-ot') {
      throw new Errors.OTTypeMismatchError(type, 'sharejs-text-ot')
    }

    // The comment op is rejected by the ranges tracker unless it quotes the
    // document verbatim, so check it here and tell the caller what is actually
    // there, allowing them to retry against the current content.
    const currentText = lines.join('\n').slice(position, position + text.length)
    if (currentText !== text) {
      throw new Errors.CommentTextMismatchError('comment text mismatch', {
        docId,
        position,
        actualText: currentText,
      })
    }

    const update = {
      doc: docId,
      op: [{ c: text, p: position, t: threadId }],
      v: version,
      meta: {
        user_id: userId,
        ts: Date.now(),
        source: 'review-api',
      },
    }
    await UpdateManager.promises.applyUpdate(projectId, docId, update)

    // Read the comment back rather than echoing the request: the op may have
    // been transformed against updates that were pending when we took the lock.
    const { ranges, version: newVersion } = await DocumentManager.getDoc(
      projectId,
      docId
    )
    const comment = (ranges?.comments || []).find(
      comment => (comment.op?.t || comment.id) === threadId
    )
    if (comment == null) {
      throw new Errors.NotFoundError(`comment not found: ${threadId}`)
    }

    // Same flushing rules as setDoc: leave a doc that an editor has open to the
    // usual flush cycle, evict one we only loaded for this call.
    if (alreadyLoaded) {
      await DocumentManager.flushDocIfLoaded(projectId, docId)
    } else {
      try {
        await DocumentManager.flushAndDeleteDoc(projectId, docId, {})
      } finally {
        HistoryManager.flushProjectChangesAsync(projectId)
      }
    }

    return { comment, version: newVersion }
  },

  async updateCommentState(projectId, docId, commentId, userId, resolved) {
    const { lines, version, pathname, historyRangesSupport } =
      await DocumentManager.getDoc(projectId, docId)

    if (lines == null || version == null) {
      throw new Errors.NotFoundError(`document not found: ${docId}`)
    }

    if (historyRangesSupport) {
      await RedisManager.promises.updateCommentState(docId, commentId, resolved)

      await ProjectHistoryRedisManager.promises.queueOps(
        projectId,
        JSON.stringify({
          pathname,
          commentId,
          resolved,
          meta: {
            ts: new Date(),
            user_id: userId,
          },
        })
      )
    }
  },

  async getComment(projectId, docId, commentId) {
    // TODO(24596): tc support for history-ot
    const { ranges } = await DocumentManager.getDoc(projectId, docId)

    const comment = ranges?.comments?.find(comment => comment.id === commentId)

    if (!comment) {
      throw new Errors.NotFoundError({
        message: 'comment not found',
        info: { commentId },
      })
    }

    return comment
  },

  async deleteComment(projectId, docId, commentId, userId) {
    const { lines, version, ranges, pathname, historyRangesSupport } =
      await DocumentManager.getDoc(projectId, docId)
    if (lines == null || version == null) {
      throw new Errors.NotFoundError(`document not found: ${docId}`)
    }

    // TODO(24596): tc support for history-ot
    const newRanges = RangesManager.deleteComment(commentId, ranges)

    await RedisManager.promises.updateDocument(
      projectId,
      docId,
      lines,
      version,
      [],
      newRanges,
      {}
    )

    if (historyRangesSupport) {
      await RedisManager.promises.updateCommentState(docId, commentId, false)
      await ProjectHistoryRedisManager.promises.queueOps(
        projectId,
        JSON.stringify({
          pathname,
          deleteComment: commentId,
          meta: {
            ts: new Date(),
            user_id: userId,
          },
        })
      )
    }
  },

  async renameDoc(projectId, docId, userId, update, projectHistoryId) {
    await RedisManager.promises.renameDoc(
      projectId,
      docId,
      userId,
      update,
      projectHistoryId
    )
  },

  async getDocAndFlushIfOld(projectId, docId) {
    let { lines, version, unflushedTime, alreadyLoaded } =
      await DocumentManager.getDoc(projectId, docId)

    // if doc was already loaded see if it needs to be flushed
    if (
      alreadyLoaded &&
      unflushedTime != null &&
      Date.now() - unflushedTime > MAX_UNFLUSHED_AGE
    ) {
      await DocumentManager.flushDocIfLoaded(projectId, docId)
    }

    if (!Array.isArray(lines)) {
      const file = StringFileData.fromRaw(lines)
      // TODO(24596): tc support for history-ot
      lines = file.getLines()
    }

    return { lines, version }
  },

  async resyncDocContents(projectId, docId, path, opts = {}) {
    logger.debug({ projectId, docId, path }, 'start resyncing doc contents')
    let {
      lines,
      ranges,
      resolvedCommentIds,
      version,
      projectHistoryId,
      historyRangesSupport,
    } = await RedisManager.promises.getDoc(projectId, docId)

    // To avoid issues where the same docId appears with different paths,
    // we use the path from the resyncProjectStructure update.  If we used
    // the path from the getDoc call to web then the two occurences of the
    // docId would map to the same path, and this would be rejected by
    // project-history as an unexpected resyncDocContent update.
    if (lines == null || version == null) {
      logger.debug(
        { projectId, docId },
        'resyncing doc contents - not found in redis - retrieving from web'
      )
      ;({
        lines,
        ranges,
        resolvedCommentIds,
        version,
        projectHistoryId,
        historyRangesSupport,
      } = await PersistenceManager.promises.getDoc(projectId, docId, {
        peek: true,
      }))
    } else {
      logger.debug(
        { projectId, docId },
        'resyncing doc contents - doc in redis - will queue in redis'
      )
    }

    if (opts.historyRangesMigration) {
      historyRangesSupport = opts.historyRangesMigration === 'forwards'
    }

    await ProjectHistoryRedisManager.promises.queueResyncDocContent(
      projectId,
      projectHistoryId,
      docId,
      lines,
      ranges ?? {},
      resolvedCommentIds,
      version,
      // use the path from the resyncProjectStructure update
      path,
      historyRangesSupport
    )

    if (opts.historyRangesMigration) {
      await RedisManager.promises.setHistoryRangesSupportFlag(
        docId,
        historyRangesSupport
      )
    }
  },

  async getDocWithLock(projectId, docId) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.getDoc,
      projectId,
      docId
    )
  },

  async getCommentWithLock(projectId, docId, commentId) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.getComment,
      projectId,
      docId,
      commentId
    )
  },

  async getDocAndRecentOpsWithLock(projectId, docId, fromVersion) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.getDocAndRecentOps,
      projectId,
      docId,
      fromVersion
    )
  },

  async getDocAndFlushIfOldWithLock(projectId, docId) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.getDocAndFlushIfOld,
      projectId,
      docId
    )
  },

  async setDocWithLock(
    projectId,
    docId,
    lines,
    source,
    userId,
    undoing,
    external,
    trackChanges = false
  ) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.setDoc,
      projectId,
      docId,
      lines,
      source,
      userId,
      undoing,
      external,
      trackChanges
    )
  },

  async appendToDocWithLock(projectId, docId, lines, source, userId) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.appendToDoc,
      projectId,
      docId,
      lines,
      source,
      userId
    )
  },

  async flushDocIfLoadedWithLock(projectId, docId) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.flushDocIfLoaded,
      projectId,
      docId
    )
  },

  async flushAndDeleteDocWithLock(projectId, docId, options) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.flushAndDeleteDoc,
      projectId,
      docId,
      options
    )
  },

  async acceptChangesWithLock(projectId, docId, changeIds) {
    const UpdateManager = require('./UpdateManager')
    const changeContributors = await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.acceptChanges,
      projectId,
      docId,
      changeIds
    )
    return changeContributors
  },

  async rejectChangesWithLock(projectId, docId, changeIds, userId) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.rejectChanges,
      projectId,
      docId,
      changeIds,
      userId
    )
  },

  async addCommentWithLock(projectId, docId, comment, userId) {
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.addComment,
      projectId,
      docId,
      comment,
      userId
    )
  },

  async updateCommentStateWithLock(
    projectId,
    docId,
    threadId,
    userId,
    resolved
  ) {
    const UpdateManager = require('./UpdateManager')
    await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.updateCommentState,
      projectId,
      docId,
      threadId,
      userId,
      resolved
    )
  },

  async deleteCommentWithLock(projectId, docId, threadId, userId) {
    const UpdateManager = require('./UpdateManager')
    await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.deleteComment,
      projectId,
      docId,
      threadId,
      userId
    )
  },

  async renameDocWithLock(projectId, docId, userId, update, projectHistoryId) {
    const UpdateManager = require('./UpdateManager')
    await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.renameDoc,
      projectId,
      docId,
      userId,
      update,
      projectHistoryId
    )
  },

  async resyncDocContentsWithLock(projectId, docId, path, opts) {
    const UpdateManager = require('./UpdateManager')
    await UpdateManager.promises.lockUpdatesAndDo(
      DocumentManager.resyncDocContents,
      projectId,
      docId,
      path,
      opts
    )
  },
}

module.exports = {
  ...callbackifyAll(DocumentManager, {
    multiResult: {
      getDoc: [
        'lines',
        'version',
        'ranges',
        'pathname',
        'projectHistoryId',
        'unflushedTime',
        'alreadyLoaded',
        'historyRangesSupport',
      ],
      getDocWithLock: [
        'lines',
        'version',
        'ranges',
        'pathname',
        'projectHistoryId',
        'unflushedTime',
        'alreadyLoaded',
        'historyRangesSupport',
      ],
      getDocAndFlushIfOld: ['lines', 'version'],
      getDocAndFlushIfOldWithLock: ['lines', 'version'],
      getDocAndRecentOps: [
        'lines',
        'version',
        'ops',
        'ranges',
        'pathname',
        'projectHistoryId',
        'type',
      ],
      getDocAndRecentOpsWithLock: [
        'lines',
        'version',
        'ops',
        'ranges',
        'pathname',
        'projectHistoryId',
        'type',
      ],
    },
  }),
  promises: DocumentManager,
}
