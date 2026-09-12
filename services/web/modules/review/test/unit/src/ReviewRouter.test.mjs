import { beforeEach, describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

describe('review router', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('does not register routes when disabled', async () => {
    vi.doMock('@overleaf/settings', () => ({
      default: { enableReviewPanel: false },
    }))
    vi.doMock(
      '../../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs',
      () => ({
        default: {
          blockRestrictedUserFromProject: sinon.stub(),
          ensureUserCanReadProject: sinon.stub(),
          ensureUserCanWriteProjectContent: sinon.stub(),
          ensureUserCanDeleteOrResolveThread: sinon.stub(),
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/infrastructure/AsyncLocalStorage.mjs',
      () => ({ default: { middleware: sinon.stub() } })
    )
    vi.doMock(
      '../../../../../app/src/Features/Chat/ChatApiHandler.mjs',
      () => ({ default: { promises: { getThreadMessage: sinon.stub() } } })
    )
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectGetter.mjs',
      () => ({ default: { promises: { getProject: sinon.stub() } } })
    )
    vi.doMock(
      '../../../../../app/src/Features/Authentication/SessionManager.mjs',
      () => ({ default: { getLoggedInUserId: sinon.stub() } })
    )
    vi.doMock('../../../app/src/ReviewController.mjs', () => ({
      default: {
        getThreads: sinon.stub(),
        getRanges: sinon.stub(),
        sendComment: sinon.stub(),
        editMessage: sinon.stub(),
        deleteMessage: sinon.stub(),
        deleteOwnMessage: sinon.stub(),
        resolveThread: sinon.stub(),
        reopenThread: sinon.stub(),
        deleteThread: sinon.stub(),
        acceptChanges: sinon.stub(),
        trackChanges: sinon.stub(),
      },
    }))
    const router = (await import('../../../app/src/ReviewRouter.mjs')).default
    const webRouter = {
      get: sinon.stub(),
      post: sinon.stub(),
      delete: sinon.stub(),
    }
    router.apply(webRouter)
    sinon.assert.notCalled(webRouter.get)
    sinon.assert.notCalled(webRouter.post)
    sinon.assert.notCalled(webRouter.delete)
  })

  it('registers review routes when enabled', async () => {
    vi.doMock('@overleaf/settings', () => ({
      default: { enableReviewPanel: true },
    }))
    vi.doMock(
      '../../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs',
      () => ({
        default: {
          blockRestrictedUserFromProject: sinon.stub(),
          ensureUserCanReadProject: sinon.stub(),
          ensureUserCanWriteProjectContent: sinon.stub(),
          ensureUserCanDeleteOrResolveThread: sinon.stub(),
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/infrastructure/AsyncLocalStorage.mjs',
      () => ({ default: { middleware: sinon.stub() } })
    )
    vi.doMock(
      '../../../../../app/src/Features/Chat/ChatApiHandler.mjs',
      () => ({ default: { promises: { getThreadMessage: sinon.stub() } } })
    )
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectGetter.mjs',
      () => ({ default: { promises: { getProject: sinon.stub() } } })
    )
    vi.doMock(
      '../../../../../app/src/Features/Authentication/SessionManager.mjs',
      () => ({ default: { getLoggedInUserId: sinon.stub() } })
    )
    vi.doMock('../../../app/src/ReviewController.mjs', () => ({
      default: {
        getThreads: sinon.stub(),
        getRanges: sinon.stub(),
        sendComment: sinon.stub(),
        editMessage: sinon.stub(),
        deleteMessage: sinon.stub(),
        deleteOwnMessage: sinon.stub(),
        resolveThread: sinon.stub(),
        reopenThread: sinon.stub(),
        deleteThread: sinon.stub(),
        acceptChanges: sinon.stub(),
        trackChanges: sinon.stub(),
      },
    }))
    const router = (await import('../../../app/src/ReviewRouter.mjs')).default
    const webRouter = {
      get: sinon.stub(),
      post: sinon.stub(),
      delete: sinon.stub(),
    }
    router.apply(webRouter)
    expect(webRouter.get.callCount).toBe(2)
    expect(webRouter.post.callCount).toBe(6)
    expect(webRouter.delete.callCount).toBe(3)
    expect(webRouter.get.firstCall.args[1]).toBeDefined()
    expect(webRouter.get.firstCall.args[2]).toBeDefined()
    expect(webRouter.get.firstCall.args[0]).toBe('/project/:project_id/threads')
  })
})
