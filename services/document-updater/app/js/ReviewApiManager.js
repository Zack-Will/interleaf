// Interleaf: document operations the review API in web needs and upstream does
// not expose over HTTP. Kept out of DocumentManager so that file stays as
// upstream ships it; everything here is built on its public methods.

const OError = require('@overleaf/o-error')
const DocumentManager = require('./DocumentManager')
const HistoryManager = require('./HistoryManager')
const Errors = require('./Errors')

/**
 * @import { Ranges, TrackedChange } from './types'
 */

// when the text a caller wants to comment on is not the text the document
// currently holds at that position
class CommentTextMismatchError extends OError {}

/**
 * The text a tracked change covers, which is the inserted text for a tracked
 * insert and the deleted text for a tracked delete.
 *
 * @param {TrackedChange} change
 * @return {string}
 */
function getTrackedChangeText(change) {
  const op = /** @type {any} */ (change.op || {})
  if (typeof op.i === 'string') {
    return `i:${op.i}`
  }
  if (typeof op.d === 'string') {
    return `d:${op.d}`
  }
  return ''
}

/**
 * The tracked changes a single update produced, given the ranges before and
 * after it was applied under the doc lock.
 *
 * A change the update created has an id the document did not have before. An
 * update can also grow a tracked change that was already there, when it edits
 * right up against an existing tracked change of the same user: those are
 * merged into the old change and keep its id, so they are recognised by their
 * text having changed. Position alone is not enough -- every change after an
 * edit is shifted along without being part of it -- and the timestamp is not
 * enough either, because a merge keeps the *older* of the two (`pickTimestamp`
 * in `libraries/ranges-tracker/index.cjs`). Server-side change metadata only
 * carries `user_id`, so the ownership test is on that alone.
 *
 * @param {Ranges | undefined} rangesBefore
 * @param {Ranges | undefined} rangesAfter
 * @param {string} userId
 * @return {string[]}
 */
function findTrackedChangeIds(rangesBefore, rangesAfter, userId) {
  const textBefore = new Map(
    (rangesBefore?.changes || []).map(change => [
      change.id,
      getTrackedChangeText(change),
    ])
  )
  const ids = []
  for (const change of rangesAfter?.changes || []) {
    const before = textBefore.get(change.id)
    if (before == null) {
      ids.push(change.id)
      continue
    }
    if (String(change.metadata?.user_id ?? '') !== String(userId ?? '')) {
      continue
    }
    if (before !== getTrackedChangeText(change)) {
      ids.push(change.id)
    }
  }
  return ids
}

/**
 * Leave a doc that an editor has open to the usual flush cycle, and evict one
 * that was only loaded for this call -- the same rule as DocumentManager.setDoc.
 *
 * @param {string} projectId
 * @param {string} docId
 * @param {boolean} alreadyLoaded
 */
async function flushOrEvict(projectId, docId, alreadyLoaded) {
  if (alreadyLoaded) {
    await DocumentManager.promises.flushDocIfLoaded(projectId, docId)
    return
  }
  try {
    await DocumentManager.promises.flushAndDeleteDoc(projectId, docId, {})
  } finally {
    // There is no harm in flushing project history if the previous call
    // failed and sometimes it is required
    HistoryManager.flushProjectChangesAsync(projectId)
  }
}

/**
 * @param {string} projectId
 * @param {string} docId
 */
async function getSharejsDoc(projectId, docId) {
  const doc = await DocumentManager.promises.getDoc(projectId, docId)
  if (doc.lines == null || doc.version == null) {
    throw new Errors.NotFoundError(`document not found: ${docId}`)
  }
  // Tracked changes and comment ops are only implemented here for sharejs
  // documents; upstream's acceptChanges has the same restriction.
  if (doc.type !== 'sharejs-text-ot') {
    throw new Errors.OTTypeMismatchError(doc.type, 'sharejs-text-ot')
  }
  return doc
}

const ReviewApiManager = {
  /**
   * Replace a document's content with the diff recorded as tracked changes
   * ("suggestions"), and report the ids of the changes that made.
   *
   * Upstream's setDoc does the tracking; this wraps it to read the ranges on
   * either side. The first read loads the doc, so setDoc sees it as loaded and
   * leaves it in redis for the second read; the doc is evicted afterwards if
   * it was not loaded to begin with.
   *
   * @param {string} projectId
   * @param {string} docId
   * @param {string[]} lines
   * @param {any} source an origin object or a source string
   * @param {string} userId
   * @return {Promise<{changeIds: string[], rev?: string}>}
   */
  async suggestDoc(projectId, docId, lines, source, userId) {
    const { ranges: rangesBefore, alreadyLoaded } = await getSharejsDoc(
      projectId,
      docId
    )
    const result = await DocumentManager.promises.setDoc(
      projectId,
      docId,
      lines,
      source,
      userId,
      false,
      true,
      true
    )
    const { ranges: rangesAfter } = await DocumentManager.promises.getDoc(
      projectId,
      docId
    )
    await flushOrEvict(projectId, docId, alreadyLoaded)
    return {
      ...(result || {}),
      changeIds: findTrackedChangeIds(rangesBefore, rangesAfter, userId),
    }
  },

  /**
   * Reject tracked changes by applying their inverse: delete what a tracked
   * insert added and put back what a tracked delete removed. Upstream moved
   * this to the editor (reject-changes.ts) and dropped the HTTP route; the
   * review API needs it server side.
   *
   * @param {string} projectId
   * @param {string} docId
   * @param {string[]} changeIds
   * @param {string} userId
   * @return {Promise<{rejectedChangeIds: string[]}>}
   */
  async rejectChanges(projectId, docId, changeIds, userId) {
    // Circular dependency. Import at runtime.
    const UpdateManager = require('./UpdateManager')

    const { version, ranges } = await getSharejsDoc(projectId, docId)
    const changesToReject = (ranges.changes || []).filter(change =>
      changeIds.includes(change.id)
    )

    // Reverse order by position, so undoing one change does not move the
    // others: see reject-changes.ts in web for the worked example.
    changesToReject.sort((a, b) => b.op.p - a.op.p)

    const ops = []
    for (const change of changesToReject) {
      const op = /** @type {any} */ (change.op)
      if (op.i) {
        ops.push({ p: op.p, d: op.i, u: true })
      } else if (op.d) {
        ops.push({ p: op.p, i: op.d, u: true })
      }
    }

    if (ops.length > 0) {
      await UpdateManager.promises.applyUpdate(projectId, docId, {
        doc: docId,
        op: ops,
        v: version,
        meta: {
          user_id: userId,
          ts: new Date().toISOString(),
        },
      })
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
   * @return {Promise<{comment: any, version: number}>}
   */
  async addComment(projectId, docId, { threadId, position, text }, userId) {
    // Circular dependency. Import at runtime.
    const UpdateManager = require('./UpdateManager')

    const { lines, version, alreadyLoaded } = await getSharejsDoc(
      projectId,
      docId
    )

    // The comment op is rejected by the ranges tracker unless it quotes the
    // document verbatim, so check it here and tell the caller what is actually
    // there, allowing them to retry against the current content.
    const currentText = /** @type {string[]} */ (lines)
      .join('\n')
      .slice(position, position + text.length)
    if (currentText !== text) {
      throw new CommentTextMismatchError('comment text mismatch', {
        docId,
        position,
        actualText: currentText,
      })
    }

    await UpdateManager.promises.applyUpdate(projectId, docId, {
      doc: docId,
      op: [{ c: text, p: position, t: threadId }],
      v: version,
      meta: {
        user_id: userId,
        ts: Date.now(),
        source: 'review-api',
      },
    })

    // Read the comment back rather than echoing the request: the op may have
    // been transformed against updates that were pending when we took the lock.
    const { ranges, version: newVersion } =
      await DocumentManager.promises.getDoc(projectId, docId)
    const comment = (ranges?.comments || []).find(
      comment => (comment.op?.t || comment.id) === threadId
    )
    if (comment == null) {
      throw new Errors.NotFoundError(`comment not found: ${threadId}`)
    }

    await flushOrEvict(projectId, docId, alreadyLoaded)
    return { comment, version: newVersion }
  },
}

/**
 * @param {Function} method
 */
function withLock(method) {
  return async (
    /** @type {string} */ projectId,
    /** @type {string} */ docId,
    /** @type {any[]} */ ...args
  ) => {
    // Circular dependency. Import at runtime.
    const UpdateManager = require('./UpdateManager')
    return await UpdateManager.promises.lockUpdatesAndDo(
      method,
      projectId,
      docId,
      ...args
    )
  }
}

module.exports = {
  CommentTextMismatchError,
  findTrackedChangeIds,
  promises: {
    ...ReviewApiManager,
    suggestDocWithLock: withLock(ReviewApiManager.suggestDoc),
    rejectChangesWithLock: withLock(ReviewApiManager.rejectChanges),
    addCommentWithLock: withLock(ReviewApiManager.addComment),
  },
}
