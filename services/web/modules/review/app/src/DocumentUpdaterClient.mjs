// The document-updater calls that `DocumentUpdaterHandler` does not make:
// anchoring a comment thread to a range of a document, and replacing a
// document's content so that the diff lands as tracked changes.  Both
// endpoints are our own (`services/document-updater/app/js/HttpController.js`),
// so the client lives with the review module rather than in the upstream
// handler.
import Settings from '@overleaf/settings'
import { fetchJson } from '@overleaf/fetch-utils'
import {
  CommentRangeError,
  CommentTextMismatchError,
  TrackedWriteError,
} from './Errors.mjs'
import {
  describeRequestFailure,
  detailsOf,
  serviceRequestError,
} from './ServiceErrors.mjs'

const REQUEST_TIMEOUT_MS = 30 * 1000

function docUrl(projectId, docId) {
  const baseUrl = Settings.apis.documentupdater.url
  return `${baseUrl}/project/${projectId}/doc/${docId}`
}

function commentUrl(projectId, docId) {
  return `${docUrl(projectId, docId)}/comment`
}

// document-updater answers its refusals with a JSON body carrying a stable
// code; `fetchJson` only hands us the raw text of it.  A refusal that carries
// no code still has a status worth reporting, so it becomes a typed error too
// rather than reaching the agent as "request failed".
const REQUEST_FAILED = 'document_updater_request_failed'

function translateError(error, { threadId, position }) {
  const { status, body } = describeRequestFailure(error)
  const details = detailsOf(body)
  if (body?.code === 'text_mismatch') {
    return new CommentTextMismatchError(body.message, {
      threadId,
      position,
      status,
      details,
      actualText: body.actual_text ?? '',
    })
  }
  if (body?.code) {
    return new CommentRangeError(body.message, {
      code: body.code,
      threadId,
      position,
      status,
      details,
    })
  }
  return serviceRequestError(error, REQUEST_FAILED)
}

/**
 * Anchor `threadId` to `text` at `position` in the document, or move it there
 * if it is already anchored somewhere else.
 *
 * @param {string} projectId
 * @param {string} docId
 * @param {string} userId
 * @param {{threadId: string, position: number, text: string}} range
 * @return {Promise<{comment: object, version: number}>}
 */
async function addCommentRange(projectId, docId, userId, range) {
  const { threadId, position, text } = range
  try {
    return await fetchJson(commentUrl(projectId, docId), {
      method: 'POST',
      json: {
        user_id: userId,
        thread_id: threadId,
        position,
        text,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw translateError(error, { threadId, position })
  }
}

function translateSetDocError(error, { projectId, docId }) {
  const { status, body } = describeRequestFailure(error)
  if (body?.code) {
    return new TrackedWriteError(body.message, {
      code: body.code,
      projectId,
      docId,
      status,
      details: detailsOf(body),
    })
  }
  return serviceRequestError(error, REQUEST_FAILED)
}

/**
 * Replace the content of a document and ask document-updater to record the
 * diff as tracked changes ("suggestions") instead of plain edits, so a human
 * accepts or rejects them in the review panel.
 *
 * @param {string} projectId
 * @param {string} docId
 * @param {string} userId the user the tracked changes are attributed to
 * @param {string[]} lines the full new content of the document
 * @param {object|string} source origin of the write, e.g.
 *   `{ kind: 'mcp', agent, message, suggestion: true }`
 * @return {Promise<{change_ids: string[], rev?: string}>}
 */
async function setDocumentTracked(projectId, docId, userId, lines, source) {
  try {
    const result = await fetchJson(docUrl(projectId, docId), {
      method: 'POST',
      json: {
        lines,
        source,
        user_id: userId,
        track_changes: true,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return { ...(result || {}), change_ids: result?.change_ids || [] }
  } catch (error) {
    throw translateSetDocError(error, { projectId, docId })
  }
}

export { addCommentRange, setDocumentTracked }

export default {
  addCommentRange,
  setDocumentTracked,
  promises: { addCommentRange, setDocumentTracked },
}
