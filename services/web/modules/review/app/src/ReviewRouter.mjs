import Settings from '@overleaf/settings'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import ChatApiHandler from '../../../../app/src/Features/Chat/ChatApiHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import { expressify } from '@overleaf/promise-utils'
import AsyncLocalStorage from '../../../../app/src/infrastructure/AsyncLocalStorage.mjs'
import ReviewController from './ReviewController.mjs'

async function ensureUserCanModifyMessage(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    return res.sendStatus(403)
  }
  const message = await ChatApiHandler.promises.getThreadMessage(
    req.params.project_id,
    req.params.thread_id,
    req.params.message_id
  )
  const project = await ProjectGetter.promises.getProject(
    req.params.project_id,
    { owner_ref: 1 }
  )
  if (
    message?.user_id === userId ||
    project?.owner_ref?.toString() === userId
  ) {
    req.reviewIsProjectOwner = project?.owner_ref?.toString() === userId
    return true
  }
  return false
}

const messageAuthorOrOwner = expressify(async (req, res, next) => {
  const allowed = await ensureUserCanModifyMessage(req, res)
  if (allowed === true) return next()
  if (res.headersSent) return
  res.sendStatus(403)
})

function apply(webRouter) {
  if (!Settings.enableReviewPanel) return
  const read = [
    AsyncLocalStorage.middleware,
    AuthorizationMiddleware.blockRestrictedUserFromProject,
    AuthorizationMiddleware.ensureUserCanReadProject,
  ]
  webRouter.get(
    '/project/:project_id/threads',
    ...read,
    ReviewController.getThreads
  )
  webRouter.get(
    '/project/:project_id/ranges',
    ...read,
    ReviewController.getRanges
  )
  const comment = [...read, ReviewController.sendComment]
  webRouter.post('/project/:project_id/thread/:thread_id/messages', ...comment)
  webRouter.post(
    '/project/:project_id/thread/:thread_id/messages/:message_id/edit',
    ...read,
    messageAuthorOrOwner,
    ReviewController.editMessage
  )
  webRouter.delete(
    '/project/:project_id/thread/:thread_id/messages/:message_id',
    ...read,
    messageAuthorOrOwner,
    ReviewController.deleteMessage
  )
  webRouter.delete(
    '/project/:project_id/thread/:thread_id/own-messages/:message_id',
    ...read,
    messageAuthorOrOwner,
    ReviewController.deleteOwnMessage
  )
  const threadWrite = [
    ...read,
    AuthorizationMiddleware.ensureUserCanDeleteOrResolveThread,
  ]
  webRouter.post(
    '/project/:project_id/doc/:doc_id/thread/:thread_id/resolve',
    ...threadWrite,
    ReviewController.resolveThread
  )
  webRouter.post(
    '/project/:project_id/doc/:doc_id/thread/:thread_id/reopen',
    ...threadWrite,
    ReviewController.reopenThread
  )
  webRouter.delete(
    '/project/:project_id/doc/:doc_id/thread/:thread_id',
    ...threadWrite,
    ReviewController.deleteThread
  )
  webRouter.post(
    '/project/:project_id/doc/:doc_id/changes/accept',
    ...read,
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    ReviewController.acceptChanges
  )
  webRouter.post(
    '/project/:project_id/track_changes',
    ...read,
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    ReviewController.trackChanges
  )
}

export default { apply }
