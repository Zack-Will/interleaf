import { beforeEach, describe, it, vi } from 'vitest'
import sinon from 'sinon'
import { handleValidationError } from '@overleaf/validation-tools'

const modulePath = '../../../app/src/ProjectSyncRouter.mjs'

describe('project-sync router', () => {
  beforeEach(async ctx => {
    vi.resetModules()
    ctx.authMiddleware = sinon.stub()
    ctx.AuthenticationController = {
      requireLogin: sinon.stub().returns(ctx.authMiddleware),
    }
    vi.doMock(
      '../../../../../app/src/Features/Authentication/AuthenticationController.mjs',
      () => ({ default: ctx.AuthenticationController })
    )
    vi.doMock(
      '../../../../../app/src/Features/Authentication/SessionManager.mjs',
      () => ({ default: { getLoggedInUserId: sinon.stub().returns('user-1') } })
    )
    vi.doMock('../../../app/src/TokenService.mjs', () => ({
      default: {
        promises: {
          createToken: sinon.stub(),
          revokeToken: sinon.stub(),
        },
      },
    }))
    vi.doMock('../../../../../app/src/infrastructure/RateLimiter.mjs', () => ({
      RateLimiter: class {},
    }))
    vi.doMock('../../../../../app/src/Features/Security/RateLimiterMiddleware.mjs', () => ({
      default: { rateLimit: sinon.stub().returns(sinon.stub()) },
    }))
    vi.doMock('../../../app/src/TokenAuthMiddleware.mjs', () => ({
      requireAccessToken: sinon.stub().returns(sinon.stub()),
    }))

    ctx.ProjectSyncRouter = (await import(modulePath)).default
    ctx.webRouter = {
      get: sinon.stub(),
      post: sinon.stub(),
      delete: sinon.stub(),
    }
    ctx.ProjectSyncRouter.apply(ctx.webRouter)
  })

  it('passes invalid POST bodies to validation middleware for a 400 response', async ctx => {
    const postHandler = ctx.webRouter.post.firstCall.args[2]
    const req = { body: { scopes: ['unsupported'] }, session: {} }
    const next = sinon.stub()
    await postHandler(req, {}, next)

    sinon.assert.calledOnce(next)
    const error = next.firstCall.args[0]
    const res = { status: sinon.stub().returnsThis(), json: sinon.stub() }
    handleValidationError(error, req, res, sinon.stub())
    sinon.assert.calledWith(res.status, 400)
    sinon.assert.calledWithMatch(res.json, { statusCode: 400 })
  })

  it('returns 404 when revoking an unknown token', async ctx => {
    const deleteHandler = ctx.webRouter.delete.firstCall.args[2]
    const revokeToken = (await import('../../../app/src/TokenService.mjs')).default.promises.revokeToken
    revokeToken.resolves({ deletedCount: 0 })
    const res = { sendStatus: sinon.stub() }
    await deleteHandler({ params: { tokenId: 'missing' }, session: {} }, res, sinon.stub())

    sinon.assert.calledWith(res.sendStatus, 404)
  })

})
