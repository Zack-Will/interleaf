import { beforeEach, describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

const modulePath = '../../../app/src/OAuthRouter.mjs'

function makeRouter() {
  return {
    get: sinon.stub(),
    post: sinon.stub(),
    delete: sinon.stub(),
    options: sinon.stub(),
  }
}

function paths(stub) {
  return stub.getCalls().map(call => call.args[0])
}

describe('oauth router', () => {
  beforeEach(async ctx => {
    vi.resetModules()
    ctx.requireLogin = sinon.stub()
    vi.doMock(
      '../../../../../app/src/Features/Authentication/AuthenticationController.mjs',
      () => ({
        default: { requireLogin: sinon.stub().returns(ctx.requireLogin) },
      })
    )
    vi.doMock('../../../../../app/src/infrastructure/RateLimiter.mjs', () => ({
      RateLimiter: class {},
    }))
    vi.doMock(
      '../../../../../app/src/Features/Security/RateLimiterMiddleware.mjs',
      () => ({
        default: { rateLimit: sinon.stub().returns(sinon.stub()) },
      })
    )
    vi.doMock('../../../app/src/OAuthController.mjs', () => ({
      default: {},
    }))
    ctx.OAuthRouter = (await import(modulePath)).default
  })

  it('puts authorization and client management behind login', async ctx => {
    const webRouter = makeRouter()
    ctx.OAuthRouter.apply(webRouter)
    expect(paths(webRouter.get)).toEqual([
      '/oauth/authorize',
      '/user/oauth-clients',
    ])
    expect(paths(webRouter.post)).toEqual([
      '/oauth/authorize',
      '/user/oauth-clients',
    ])
    expect(paths(webRouter.delete)).toEqual(['/user/oauth-clients/:clientId'])
    for (const call of [
      ...webRouter.get.getCalls(),
      ...webRouter.post.getCalls(),
      ...webRouter.delete.getCalls(),
    ]) {
      expect(call.args[1]).toBe(ctx.requireLogin)
    }
  })

  it('serves discovery and token endpoints without CSRF, apart from git-bridge', async ctx => {
    const publicApiRouter = makeRouter()
    ctx.OAuthRouter.applyNonCsrfRouter(
      makeRouter(),
      makeRouter(),
      publicApiRouter
    )
    expect(paths(publicApiRouter.get)).toEqual([
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ])
    expect(paths(publicApiRouter.post)).toEqual([
      '/oauth/token',
      '/oauth/revoke',
    ])
    expect(paths(publicApiRouter.get)).not.toContain('/oauth/token/info')
  })
})
