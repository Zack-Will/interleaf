// Comment collaboration primitives shared by the review HTTP routes and the
// MCP comment tools.  Everything that talks to chat, document-updater or the
// realtime service is injectable so that unit tests and the MCP smoke script
// can run without any of those services.
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import ChatManager from '../../../../app/src/Features/Chat/ChatManager.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorRealTimeController from '../../../../app/src/Features/Editor/EditorRealTimeController.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import UserInfoController from '../../../../app/src/Features/User/UserInfoController.mjs'
import UserInfoManager from '../../../../app/src/Features/User/UserInfoManager.mjs'

function toLines(rawLines) {
  if (Array.isArray(rawLines)) return rawLines
  return String(rawLines || '').split(/\r\n|\n|\r/)
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

  // The document-updater resolve / reopen endpoints only mirror to history when
  // the project stores ranges there.  Everything else lives in chat.
  async function rangesSupportEnabled(projectId) {
    const project = await projectGetter.promises.getProject(projectId, {
      'overleaf.history.rangesSupportEnabled': 1,
    })
    return Boolean(project?.overleaf?.history?.rangesSupportEnabled)
  }

  async function listThreads(projectId) {
    const threads = await chatApi.promises.getThreads(projectId)
    await chatManager.promises.injectUserInfoIntoThreads(threads)
    return threads
  }

  async function sendComment(projectId, threadId, userId, content) {
    const message = await chatApi.promises.sendComment(
      projectId,
      threadId,
      userId,
      content
    )
    const user = await userInfoManager.promises.getPersonalInfo(message.user_id)
    message.user = userInfoController.formatPersonalInfo(user)
    realtime.emitToRoom(projectId, 'new-comment', threadId, message)
    return message
  }

  async function resolveThread(projectId, docId, threadId, userId) {
    await chatApi.promises.resolveThread(projectId, threadId, userId)
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
    await chatApi.promises.reopenThread(projectId, threadId)
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
    await chatApi.promises.deleteThread(projectId, threadId)
    realtime.emitToRoom(projectId, 'delete-thread', threadId)
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
    getDocRanges,
  }
}

const ReviewService = createReviewService()

export default ReviewService
