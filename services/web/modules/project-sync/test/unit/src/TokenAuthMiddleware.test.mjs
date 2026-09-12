import { beforeEach, describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

const modulePath = '../../../app/src/TokenAuthMiddleware.mjs'

describe('project-sync token authentication middleware', () => {
  beforeEach(async ctx => {
    vi.resetModules()
    ctx.verifyToken = sinon.stub()
    vi.doMock('../../../app/src/TokenService.mjs', () => ({
      default: { promises: { verifyToken: ctx.verifyToken } },
    }))
    const mod = await import(modulePath)
    ctx.requireAccessToken = mod.requireAccessToken
    ctx.next = sinon.stub()
    ctx.res = {
      setHeader: sinon.stub(),
      status: sinon.stub().returnsThis(),
      json: sinon.stub().returnsThis(),
    }
  })

  function reqWithAuthorization(value) {
    return {
      headers: { authorization: value },
      get: name => (name.toLowerCase() === 'authorization' ? value : undefined),
    }
  }

  it('accepts Bearer tokens and sets syncUser', async ctx => {
    ctx.verifyToken.resolves({ userId: 'u', scopes: ['git_bridge'], tokenId: 't' })
    const req = reqWithAuthorization('Bearer olp_1234567890abcdef')
    await ctx.requireAccessToken('git_bridge')(req, ctx.res, ctx.next)
    expect(ctx.verifyToken).toHaveBeenCalledWith('olp_1234567890abcdef', 'git_bridge')
    expect(req.syncUser).toEqual({ userId: 'u', scopes: ['git_bridge'], tokenId: 't' })
    expect(ctx.next).toHaveBeenCalled()
  })

  it('accepts Basic git credentials', async ctx => {
    ctx.verifyToken.resolves({ userId: 'u', scopes: ['git_bridge'], tokenId: 't' })
    const encoded = Buffer.from('git:olp_1234567890abcdef').toString('base64')
    const req = reqWithAuthorization(`Basic ${encoded}`)
    await ctx.requireAccessToken('git_bridge')(req, ctx.res, ctx.next)
    expect(ctx.verifyToken).toHaveBeenCalledWith('olp_1234567890abcdef', 'git_bridge')
    expect(ctx.next).toHaveBeenCalled()
  })

  it('returns token_malformed for malformed authorization headers', async ctx => {
    for (const value of [undefined, '', 'Bearer', 'Basic !!!', 'Basic ' + Buffer.from('joe:secret').toString('base64')]) {
      ctx.verifyToken.resetHistory()
      ctx.next.resetHistory()
      const req = reqWithAuthorization(value)
      await ctx.requireAccessToken('git_bridge')(req, ctx.res, ctx.next)
      expect(ctx.res.status).toHaveBeenCalledWith(401)
      expect(ctx.res.json).toHaveBeenCalledWith({ error: 'invalid_token', error_code: 'token_malformed' })
      expect(ctx.verifyToken).not.toHaveBeenCalled()
    }
  })

  it('maps typed token errors to expected responses', async ctx => {
    const { TokenInvalidError, TokenExpiredError, InsufficientScopeError } =
      await import('../../../app/src/Errors.mjs')
    for (const [ErrorType, status, body] of [
      [TokenInvalidError, 401, { error: 'invalid_token', error_code: 'token_invalid' }],
      [TokenExpiredError, 401, { error: 'invalid_token', error_code: 'token_expired' }],
      [InsufficientScopeError, 403, { error: 'insufficient_scope', error_code: 'insufficient_scope' }],
    ]) {
      ctx.res.status.resetHistory()
      ctx.res.json.resetHistory()
      ctx.next.resetHistory()
      ctx.verifyToken.rejects(new ErrorType())
      await ctx.requireAccessToken('git_bridge')(reqWithAuthorization('Bearer olp_1234567890abcdef'), ctx.res, ctx.next)
      expect(ctx.res.status).toHaveBeenCalledWith(status)
      expect(ctx.res.json).toHaveBeenCalledWith(body)
      expect(ctx.next).not.toHaveBeenCalled()
      ctx.verifyToken.resetBehavior()
    }
  })
})
