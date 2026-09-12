import { expressify } from '@overleaf/promise-utils'
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import DocstoreManager from '../../../../app/src/Features/Docstore/DocstoreManager.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import ProjectOptionsHandler from '../../../../app/src/Features/Project/ProjectOptionsHandler.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import { createReviewService } from './ReviewService.mjs'

function getUserId(req, sessionManager = SessionManager) {
  return sessionManager.getLoggedInUserId(req.session)
}

function requireLoggedInUser(req, res, sessionManager) {
  if (getUserId(req, sessionManager)) return true
  res.sendStatus(403)
  return false
}

function createHandlers(services = {}) {
  const chatApi = services.ChatApiHandler || ChatApiHandler
  const documentUpdater =
    services.DocumentUpdaterHandler || DocumentUpdaterHandler
  const docstore = services.DocstoreManager || DocstoreManager
  const realtime = services.EditorRealTimeController || EditorRealTimeController
  const projectOptions = services.ProjectOptionsHandler || ProjectOptionsHandler
  const sessionManager = services.SessionManager || SessionManager
  const reviewService = services.ReviewService || createReviewService(services)

  async function getThreads(req, res) {
    const threads = await reviewService.listThreads(req.params.project_id)
    res.json(threads)
  }

  async function getRanges(req, res) {
    const projectId = req.params.project_id
    await documentUpdater.promises.flushProjectToMongo(projectId)
    const ranges = await docstore.promises.getAllRanges(projectId)
    res.json(
      ranges.map(range => ({
        id: range.id || range._id?.toString(),
        ranges: range.ranges || {},
      }))
    )
  }

  async function sendComment(req, res) {
    if (!requireLoggedInUser(req, res, sessionManager)) return
    const projectId = req.params.project_id
    const userId = sessionManager.getLoggedInUserId(req.session)
    await reviewService.sendComment(
      projectId,
      req.params.thread_id,
      userId,
      req.body.content
    )
    res.sendStatus(204)
  }

  async function editMessage(req, res) {
    if (!requireLoggedInUser(req, res, sessionManager)) return
    const {
      project_id: projectId,
      thread_id: threadId,
      message_id: messageId,
    } = req.params
    const userId = sessionManager.getLoggedInUserId(req.session)
    await chatApi.promises.editMessage(
      projectId,
      threadId,
      messageId,
      userId,
      req.body.content
    )
    realtime.emitToRoom(
      projectId,
      'edit-message',
      threadId,
      messageId,
      req.body.content
    )
    res.sendStatus(204)
  }

  async function deleteMessage(req, res) {
    const {
      project_id: projectId,
      thread_id: threadId,
      message_id: messageId,
    } = req.params
    if (req.reviewIsProjectOwner) {
      await chatApi.promises.deleteMessage(projectId, threadId, messageId)
    } else {
      const userId = sessionManager.getLoggedInUserId(req.session)
      await chatApi.promises.deleteUserMessage(
        projectId,
        threadId,
        userId,
        messageId
      )
    }
    realtime.emitToRoom(projectId, 'delete-message', threadId, messageId)
    res.sendStatus(204)
  }

  async function deleteOwnMessage(req, res) {
    if (!requireLoggedInUser(req, res, sessionManager)) return
    const {
      project_id: projectId,
      thread_id: threadId,
      message_id: messageId,
    } = req.params
    const userId = sessionManager.getLoggedInUserId(req.session)
    await chatApi.promises.deleteUserMessage(
      projectId,
      threadId,
      userId,
      messageId
    )
    realtime.emitToRoom(projectId, 'delete-message', threadId, messageId)
    res.sendStatus(204)
  }

  async function resolveThread(req, res) {
    if (!requireLoggedInUser(req, res, sessionManager)) return
    const {
      project_id: projectId,
      doc_id: docId,
      thread_id: threadId,
    } = req.params
    const userId = sessionManager.getLoggedInUserId(req.session)
    await reviewService.resolveThread(projectId, docId, threadId, userId)
    res.sendStatus(204)
  }

  async function reopenThread(req, res) {
    if (!requireLoggedInUser(req, res, sessionManager)) return
    const {
      project_id: projectId,
      doc_id: docId,
      thread_id: threadId,
    } = req.params
    const userId = sessionManager.getLoggedInUserId(req.session)
    await reviewService.reopenThread(projectId, docId, threadId, userId)
    res.sendStatus(204)
  }

  async function deleteThread(req, res) {
    const {
      project_id: projectId,
      doc_id: docId,
      thread_id: threadId,
    } = req.params
    const userId = getUserId(req, sessionManager)
    await reviewService.deleteThread(projectId, docId, threadId, userId)
    res.sendStatus(204)
  }

  async function acceptChanges(req, res) {
    const { project_id: projectId, doc_id: docId } = req.params
    const userId = getUserId(req, sessionManager)
    await documentUpdater.promises.acceptChanges(
      projectId,
      docId,
      req.body.change_ids,
      userId
    )
    realtime.emitToRoom(projectId, 'accept-changes', docId, req.body.change_ids)
    res.sendStatus(204)
  }

  async function trackChanges(req, res) {
    const projectId = req.params.project_id
    await projectOptions.promises.setTrackChanges(projectId, req.body)
    const state =
      typeof req.body.on === 'boolean'
        ? req.body.on
        : {
            ...(req.body.on_for || {}),
            ...(typeof req.body.on_for_guests === 'boolean'
              ? { __guests__: req.body.on_for_guests }
              : {}),
          }
    realtime.emitToRoom(projectId, 'toggle-track-changes', state)
    res.sendStatus(204)
  }

  return {
    getThreads,
    getRanges,
    sendComment,
    editMessage,
    deleteMessage,
    deleteOwnMessage,
    resolveThread,
    reopenThread,
    deleteThread,
    acceptChanges,
    trackChanges,
  }
}

const handlers = createHandlers()

export { createHandlers }
export default Object.fromEntries(
  Object.entries(handlers).map(([name, handler]) => [name, expressify(handler)])
)
