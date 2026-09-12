// Comment collaboration primitives shared by the review HTTP routes and the
// MCP comment tools.  Everything that talks to chat, document-updater or the
// realtime service is injectable so that unit tests and the MCP smoke script
// can run without any of those services.
import RangesTracker from '@overleaf/ranges-tracker'
import logger from '@overleaf/logger'
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import ChatManager from '../../../../app/src/Features/Chat/ChatManager.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import UserInfoController from '../../../../app/src/Features/User/UserInfoController.mjs'
import UserInfoManager from '../../../../app/src/Features/User/UserInfoManager.mjs'
import DocumentUpdaterClient from './DocumentUpdaterClient.mjs'
import { ThreadNotFoundError } from './Errors.mjs'
import {
  describeRequestFailure,
  serviceRequestError,
} from './ServiceErrors.mjs'

function toLines(rawLines) {
  if (Array.isArray(rawLines)) return rawLines
  return String(rawLines || '').split(/\r\n|\n|\r/)
}

// chat answers a thread it does not know with a 404 and every other refusal
// with a status; `RequestFailedError` would flatten both into "request failed",
// which tells an agent nothing about whether to retry or to look the thread up.
function translateChatError(error, threadId) {
  const { status } = describeRequestFailure(error)
  if (status === 404)
    return new ThreadNotFoundError('comment thread not found', {
      threadId,
      status,
    })
  return serviceRequestError(error, 'chat_request_failed')
}

async function onChat(threadId, run) {
  try {
    return await run()
  } catch (error) {
    throw translateChatError(error, threadId)
  }
}

export function createReviewService(services = {}) {
  const chatApi = services.ChatApiHandler || ChatApiHandler
  const chatManager = services.ChatManager || ChatManager
  const documentUpdater =
    services.DocumentUpdaterHandler || DocumentUpdaterHandler
  const realtime = services.EditorRealTimeController || EditorRealTimeController
  const projectGetter = services.ProjectGetter || ProjectGetter
  const userInfoManager = services.UserInfoManager || UserInfoManager
  const userInfoController = services.UserInfoController || UserInfoController
  const documentUpdaterClient =
    services.DocumentUpdaterClient || DocumentUpdaterClient
  const generateThreadId =
    services.generateThreadId || (() => RangesTracker.generateId())

  // The document-updater resolve / reopen endpoints only mirror to history when
  // the project stores ranges there.  Everything else lives in chat.
  async function rangesSupportEnabled(projectId) {
    const project = await projectGetter.promises.getProject(projectId, {
      'overleaf.history.rangesSupportEnabled': 1,
    })
    return Boolean(project?.overleaf?.history?.rangesSupportEnabled)
  }

  async function listThreads(projectId) {
    const threads = await onChat(undefined, () =>
      chatApi.promises.getThreads(projectId)
    )
    await chatManager.promises.injectUserInfoIntoThreads(threads)
    return threads
  }

  async function sendComment(projectId, threadId, userId, content) {
    const message = await onChat(threadId, () =>
      chatApi.promises.sendComment(projectId, threadId, userId, content)
    )
    const user = await userInfoManager.promises.getPersonalInfo(message.user_id)
    message.user = userInfoController.formatPersonalInfo(user)
    realtime.emitToRoom(projectId, 'new-comment', threadId, message)
    return message
  }

  async function resolveThread(projectId, docId, threadId, userId) {
    await onChat(threadId, () =>
      chatApi.promises.resolveThread(projectId, threadId, userId)
    )
    if (await rangesSupportEnabled(projectId)) {
      await documentUpdater.promises.resolveThread(
        projectId,
        docId,
        threadId,
        userId
      )
    }
    const user = await userInfoManager.promises.getPersonalInfo(userId)
    realtime.emitToRoom(
      projectId,
      'resolve-thread',
      threadId,
      userInfoController.formatPersonalInfo(user)
    )
  }

  async function reopenThread(projectId, docId, threadId, userId) {
    await onChat(threadId, () =>
      chatApi.promises.reopenThread(projectId, threadId)
    )
    if (await rangesSupportEnabled(projectId)) {
      await documentUpdater.promises.reopenThread(
        projectId,
        docId,
        threadId,
        userId
      )
    }
    realtime.emitToRoom(projectId, 'reopen-thread', threadId)
  }

  async function deleteThread(projectId, docId, threadId, userId) {
    await documentUpdater.promises.deleteThread(
      projectId,
      docId,
      threadId,
      userId
    )
    await onChat(threadId, () =>
      chatApi.promises.deleteThread(projectId, threadId)
    )
    realtime.emitToRoom(projectId, 'delete-thread', threadId)
  }

  // A comment is two things: a chat thread that holds the messages, and a
  // range in the document that points at the text.  The editor creates them in
  // that order with a client-generated thread id, and so do we.
  async function createComment(
    projectId,
    docId,
    userId,
    { position, text, content }
  ) {
    const threadId = generateThreadId()
    const message = await sendComment(projectId, threadId, userId, content)
    try {
      const { comment, version } =
        await documentUpdaterClient.promises.addCommentRange(
          projectId,
          docId,
          userId,
          { threadId, position, text }
        )
      return { threadId, comment, version, message }
    } catch (error) {
      // The thread exists but points at nothing, and the review panel would
      // show it forever.  Take it back out before reporting the failure.
      await rollbackThread(projectId, threadId)
      throw error
    }
  }

  async function rollbackThread(projectId, threadId) {
    try {
      await chatApi.promises.deleteThread(projectId, threadId)
      realtime.emitToRoom(projectId, 'delete-thread', threadId)
    } catch (error) {
      logger.warn(
        { err: error, projectId, threadId },
        'failed to roll back a comment thread whose range could not be created'
      )
    }
  }

  // Submitting a comment op with a thread id that already exists moves the
  // range, which is how a detached or drifted comment gets a new home.
  async function reanchorComment(
    projectId,
    docId,
    userId,
    threadId,
    { position, text }
  ) {
    const threads = await onChat(threadId, () =>
      chatApi.promises.getThreads(projectId)
    )
    if (!threads?.[threadId]) {
      throw new ThreadNotFoundError('comment thread not found', {
        projectId,
        threadId,
      })
    }
    const { comment, version } =
      await documentUpdaterClient.promises.addCommentRange(
        projectId,
        docId,
        userId,
        { threadId, position, text }
      )
    return { threadId, comment, version }
  }

  // Live document state: the lines and the ranges as document-updater currently
  // holds them, so comment offsets line up with the text the agent reads.
  async function getDocRanges(projectId, docId) {
    const document = await documentUpdater.promises.getDocument(
      projectId,
      docId,
      -1
    )
    return {
      lines: toLines(document?.lines),
      ranges: document?.ranges || {},
      version: document?.version,
    }
  }

  return {
    listThreads,
    sendComment,
    resolveThread,
    reopenThread,
    deleteThread,
    createComment,
    reanchorComment,
    getDocRanges,
  }
}

const ReviewService = createReviewService()

export default ReviewService
