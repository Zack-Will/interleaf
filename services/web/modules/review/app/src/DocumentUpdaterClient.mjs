// The one document-updater call that `DocumentUpdaterHandler` does not make:
// anchoring a comment thread to a range of a document.  The endpoint is our
// own (`services/document-updater/app/js/HttpController.js`), so the client
// lives with the review module rather than in the upstream handler.
import Settings from '@overleaf/settings'
import { fetchJson } from '@overleaf/fetch-utils'
import { CommentRangeError, CommentTextMismatchError } from './Errors.mjs'

const REQUEST_TIMEOUT_MS = 30 * 1000

function commentUrl(projectId, docId) {
  const baseUrl = Settings.apis.documentupdater.url
  return `${baseUrl}/project/${projectId}/doc/${docId}/comment`
}

// document-updater answers its refusals with a JSON body carrying a stable
// code; `fetchJson` only hands us the raw text of it.
function parseErrorBody(error) {
  try {
    return JSON.parse(error.body)
  } catch {
    return null
  }
}

function translateError(error, { threadId, position }) {
  const body = parseErrorBody(error)
  if (body?.code === 'text_mismatch') {
    return new CommentTextMismatchError(body.message, {
      threadId,
      position,
      actualText: body.actual_text ?? '',
    })
  }
  if (body?.code) {
    return new CommentRangeError(body.message, {
      code: body.code,
      threadId,
      position,
    })
  }
  return error
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

export { addCommentRange }

export default { addCommentRange, promises: { addCommentRange } }
