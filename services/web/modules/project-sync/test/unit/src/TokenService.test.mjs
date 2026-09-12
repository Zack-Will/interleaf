import { beforeEach, describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

const modulePath = '../../../app/src/TokenService.mjs'

async function expectRejection(promise, expected) {
  let error
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject(expected)
}

describe('project-sync TokenService', () => {
  beforeEach(async ctx => {
    vi.resetModules()
    ctx.PersonalAccessToken = {
      create: sinon.stub(),
      findOne: sinon.stub(),
      find: sinon.stub(),
      updateOne: sinon.stub().resolves(),
      deleteOne: sinon.stub().resolves(),
      deleteMany: sinon.stub().resolves(),
    }
    vi.doMock('../../../app/src/models/PersonalAccessToken.mjs', () => ({
      PersonalAccessToken: ctx.PersonalAccessToken,
    }))
    ctx.TokenService = (await import(modulePath)).default
  })

  it('generates an olp token and stores only its hash', async ctx => {
    const record = { _id: 'id-1' }
    ctx.PersonalAccessToken.create.resolves(record)
    const result = await ctx.TokenService.promises.createToken('user-1', {
      scopes: ['git_bridge'],
      label: 'CLI',
    })
    expect(result.token).toMatch(/^olp_[a-zA-Z0-9]{16}$/)
    expect(result.record).toBe(record)
    const attrs = ctx.PersonalAccessToken.create.firstCall.args[0]
    expect(attrs.user_id).toBe('user-1')
    expect(attrs.tokenPrefix).toBe(result.token.slice(0, 8))
    expect(attrs.hashedToken).toBe(ctx.TokenService.hashToken(result.token))
    expect(attrs.hashedToken).not.toBe(result.token)
  })

  it('rejects invalid creation options with invalid_request errors', async ctx => {
    const { InvalidTokenRequestError } = await import('../../../app/src/Errors.mjs')
    for (const options of [
      { scopes: [] },
      { scopes: ['unknown'] },
      { scopes: 'git_bridge' },
      { expiresInDays: 0 },
      { expiresInDays: Symbol('invalid') },
    ]) {
      try {
        await ctx.TokenService.promises.createToken('user-1', options)
        throw new Error('expected token creation to reject')
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidTokenRequestError)
        expect(error).toMatchObject({ code: 'invalid_request' })
      }
    }
    sinon.assert.notCalled(ctx.PersonalAccessToken.create)
  })

  it('verifies a token and records last use asynchronously', async ctx => {
    const rec = {
      _id: 'tok-1',
      user_id: 'user-1',
      scopes: ['git_bridge'],
      expiresAt: null,
    }
    ctx.PersonalAccessToken.findOne.resolves(rec)
    const token = 'olp_1234567890abcdef'
    const result = await ctx.TokenService.promises.verifyToken(token, 'git_bridge')
    expect(result).toEqual({ userId: 'user-1', scopes: ['git_bridge'], tokenId: 'tok-1' })
    sinon.assert.calledWith(ctx.PersonalAccessToken.findOne, {
      hashedToken: ctx.TokenService.hashToken(token),
    })
    sinon.assert.calledOnce(ctx.PersonalAccessToken.updateOne)
  })

  it('rejects unknown, malformed, expired, and insufficient-scope tokens', async ctx => {
    await expectRejection(ctx.TokenService.promises.verifyToken('bad', 'git_bridge'), { code: 'token_invalid' })
    const token = 'olp_1234567890abcdef'
    ctx.PersonalAccessToken.findOne.resolves(null)
    await expectRejection(ctx.TokenService.promises.verifyToken(token, 'git_bridge'), { code: 'token_invalid' })
    ctx.PersonalAccessToken.findOne.resolves({ _id: 'id', user_id: 'u', scopes: ['git_bridge'], expiresAt: new Date(Date.now() - 1000) })
    await expectRejection(ctx.TokenService.promises.verifyToken(token, 'git_bridge'), { code: 'token_expired' })
    ctx.PersonalAccessToken.findOne.resolves({ _id: 'id', user_id: 'u', scopes: ['mcp'], expiresAt: null })
    await expectRejection(ctx.TokenService.promises.verifyToken(token, 'git_bridge'), { code: 'insufficient_scope' })
  })

  it('lists safe token fields and supports revocation', async ctx => {
    const rec = {
      _id: 'id', tokenPrefix: 'olp_1234', scopes: ['git_bridge'], label: 'x',
      createdAt: new Date(1), expiresAt: null, lastUsedAt: null,
    }
    ctx.PersonalAccessToken.find.returns({ sort: sinon.stub().returns({ lean: sinon.stub().resolves([rec]) }) })
    const listed = await ctx.TokenService.promises.listTokens('u')
    expect(listed).toEqual([{ id: 'id', tokenPrefix: 'olp_1234', scopes: ['git_bridge'], label: 'x', createdAt: rec.createdAt, expiresAt: null, lastUsedAt: null }])
    expect(listed[0]).not.toHaveProperty('hashedToken')
    await ctx.TokenService.promises.revokeToken('u', 'id')
    sinon.assert.calledWith(ctx.PersonalAccessToken.deleteOne, { _id: 'id', user_id: 'u' })
    await ctx.TokenService.promises.revokeAllForUser('u')
    sinon.assert.calledWith(ctx.PersonalAccessToken.deleteMany, { user_id: 'u' })
  })
})
