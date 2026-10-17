// Interleaf: HTTP routes for ReviewApiManager, registered from app.js with a
// single call so that upstream's route table and HttpController stay as
// shipped.

const { expressify } = require('@overleaf/promise-utils')
const { parseReq, z, zz } = require('@overleaf/validation-tools')
const editorCoreSchemas = require('overleaf-editor-core/lib/schemas')
const logger = require('@overleaf/logger')
const Settings = require('@overleaf/settings')
const Errors = require('./Errors')
const Metrics = require('./Metrics')
const { getTotalSizeOfLines } = require('./Limits')
const ReviewApiManager = require('./ReviewApiManager')

const docParamsSchema = z.strictObject({
  project_id: zz.objectId(),
  doc_id: zz.objectId(),
})

/**
 * @param {any} res
 * @param {string} message
 */
function sendOtTypeUnsupported(res, message) {
  return res.status(422).json({ code: 'ot_type_unsupported', message })
}

const suggestDocSchema = z.object({
  params: docParamsSchema,
  body: z.strictObject({
    lines: z.array(z.string()),
    // the web module sends the origin it wants recorded, e.g.
    // { kind: 'mcp', agent, message, suggestion: true }
    source: editorCoreSchemas.rawOrigin.or(z.string()),
    user_id: zz.objectId(),
  }),
})

async function suggestDoc(req, res) {
  const { params, body } = parseReq(req, suggestDocSchema)
  const { project_id: projectId, doc_id: docId } = params
  const { lines, source, user_id: userId } = body
  const lineSize = getTotalSizeOfLines(lines)
  if (lineSize > Settings.max_doc_length) {
    logger.warn(
      { projectId, docId, lineSize, userId },
      'document too large, returning 406 response'
    )
    return res.sendStatus(406)
  }
  const timer = new Metrics.Timer('http.suggestDoc')
  let result
  try {
    result = await ReviewApiManager.promises.suggestDocWithLock(
      projectId,
      docId,
      lines,
      source,
      userId
    )
  } catch (error) {
    if (error instanceof Errors.OTTypeMismatchError) {
      return sendOtTypeUnsupported(
        res,
        'tracked changes are only supported on sharejs documents'
      )
    }
    throw error
  }
  timer.done()
  const { changeIds, ...rest } = result
  // The ids of the tracked changes this call created, so the caller can point
  // a human at them without diffing the ranges itself.
  res.json({ ...rest, change_ids: changeIds })
}

const rejectChangesSchema = z.object({
  params: docParamsSchema,
  body: z.strictObject({
    change_ids: z.array(z.string()),
    user_id: zz.objectId().nullish(),
  }),
})

async function rejectChanges(req, res) {
  const { params, body } = parseReq(req, rejectChangesSchema)
  const { project_id: projectId, doc_id: docId } = params
  const { change_ids: changeIds, user_id: userId } = body
  logger.debug(
    { projectId, docId },
    `rejecting ${changeIds.length} changes via http`
  )
  let response
  try {
    response = await ReviewApiManager.promises.rejectChangesWithLock(
      projectId,
      docId,
      changeIds,
      userId
    )
  } catch (error) {
    if (error instanceof Errors.OTTypeMismatchError) {
      return sendOtTypeUnsupported(
        res,
        'rejecting changes is only supported on sharejs documents'
      )
    }
    throw error
  }
  res.json(response)
}

const addCommentSchema = z.object({
  params: docParamsSchema,
  body: z.strictObject({
    thread_id: zz.objectId(),
    position: z.number().int().nonnegative(),
    text: z.string().min(1),
    user_id: z.string().min(1),
  }),
})

async function addComment(req, res) {
  const { params, body } = parseReq(req, addCommentSchema)
  const { project_id: projectId, doc_id: docId } = params
  const { user_id: userId, thread_id: threadId, position, text } = body
  logger.debug(
    { projectId, docId, threadId, position, userId },
    'adding comment via http'
  )
  const timer = new Metrics.Timer('http.addComment')
  let result
  try {
    result = await ReviewApiManager.promises.addCommentWithLock(
      projectId,
      docId,
      { threadId, position, text },
      userId
    )
  } catch (error) {
    if (error instanceof ReviewApiManager.CommentTextMismatchError) {
      return res.status(400).json({
        code: 'text_mismatch',
        message: 'text does not match the document at this position',
        position,
        actual_text: /** @type {any} */ (error).info?.actualText ?? '',
      })
    }
    if (error instanceof Errors.OTTypeMismatchError) {
      return sendOtTypeUnsupported(
        res,
        'adding comments is only supported on sharejs documents'
      )
    }
    throw error
  }
  timer.done()
  res.json({ comment: result.comment, version: result.version })
}

/**
 * @param {import('express').Express} app
 */
function registerRoutes(app) {
  app.post('/project/:project_id/doc/:doc_id/suggest', expressify(suggestDoc))
  app.post(
    '/project/:project_id/doc/:doc_id/change/reject',
    expressify(rejectChanges)
  )
  app.post('/project/:project_id/doc/:doc_id/comment', expressify(addComment))
}

module.exports = {
  registerRoutes,
  suggestDoc: expressify(suggestDoc),
  rejectChanges: expressify(rejectChanges),
  addComment: expressify(addComment),
}
