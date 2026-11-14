import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FakeModel from './helpers/FakeModel.mjs'

const SITE_URL = 'https://overleaf.example'
const OWNER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_USER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const HOUR = 60 * 60 * 1000

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url')
  return { verifier, challenge }
}

async function expectRejection(promise, expected) {
  let error
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject(expected)
  return error
}

// Runs the real OAuthService and project-sync TokenService against in-memory
// collections, so the tests follow a grant from code to expiry.
describe('oauth OAuthService', () => {
  beforeEach(async ctx => {
    vi.resetModules()
    ctx.tokens = new FakeModel()
    ctx.clients = new FakeModel()
    ctx.codes = new FakeModel()
    ctx.grants = new FakeModel()
    vi.doMock(
      '../../../../project-sync/app/src/models/PersonalAccessToken.mjs',
      () => ({ PersonalAccessToken: ctx.tokens })
    )
    vi.doMock('../../../app/src/models/OAuthClient.mjs', () => ({
      OAuthClient: ctx.clients,
    }))
    vi.doMock('../../../app/src/models/OAuthAuthorizationCode.mjs', () => ({
      OAuthAuthorizationCode: ctx.codes,
    }))
    vi.doMock('../../../app/src/models/OAuthGrant.mjs', () => ({
      OAuthGrant: ctx.grants,
    }))
    ctx.OAuthService = (
      await import('../../../app/src/OAuthService.mjs')
    ).default.promises
    ctx.TokenService = (
      await import('../../../../project-sync/app/src/TokenService.mjs')
    ).default.promises

    const { clientSecret, client } = await ctx.OAuthService.createClient(
      OWNER_ID,
      { name: 'Claude', redirectUris: [CALLBACK] }
    )
    ctx.clientSecret = clientSecret
    ctx.clientId = client.clientId
    ctx.client = await ctx.OAuthService.authenticateClient({
      clientId: client.clientId,
      clientSecret,
    })

    ctx.authorize = async (overrides = {}) => {
      const { verifier, challenge } = pkcePair()
      const params = {
        client_id: ctx.clientId,
        redirect_uri: CALLBACK,
        response_type: 'code',
        state: 'xyz',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...overrides,
      }
      const request = await ctx.OAuthService.validateAuthorizeRequest(params, {
        userId: OWNER_ID,
        siteUrl: SITE_URL,
      })
      return { request, verifier }
    }

    ctx.issueTokens = async (client = ctx.client) => {
      const { request, verifier } = await ctx.authorize({
        client_id: client.clientId,
      })
      const code = await ctx.OAuthService.createAuthorizationCode({
        ...request,
        userId: OWNER_ID,
      })
      return ctx.OAuthService.exchangeAuthorizationCode(client, {
        code,
        redirectUri: CALLBACK,
        codeVerifier: verifier,
      })
    }

    ctx.createAuthenticatedClient = async options => {
      const { clientSecret, client } = await ctx.OAuthService.createClient(
        OWNER_ID,
        { name: 'Other', redirectUris: [CALLBACK], ...options }
      )
      return ctx.OAuthService.authenticateClient({
        clientId: client.clientId,
        clientSecret,
      })
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('clients', () => {
    it('stores only the hash of the client secret', async ctx => {
      expect(ctx.clientId).toMatch(/^olo_[0-9a-f]{24}$/)
      expect(ctx.clientSecret).toMatch(/^ols_/)
      const [stored] = ctx.clients.docs
      expect(stored.hashedSecret).toBe(
        crypto.createHash('sha256').update(ctx.clientSecret).digest('hex')
      )
      expect(JSON.stringify(stored)).not.toContain(ctx.clientSecret)
    })

    it('rejects redirect URIs that are not absolute https URLs', async ctx => {
      for (const uri of [
        'http://claude.ai/callback',
        'https://claude.ai/callback#fragment',
        'not a url',
        'javascript:alert(1)',
      ]) {
        await expectRejection(
          ctx.OAuthService.createClient(OWNER_ID, {
            name: 'x',
            redirectUris: [uri],
          }),
          { code: 'invalid_request' }
        )
      }
      await ctx.OAuthService.createClient(OWNER_ID, {
        name: 'local',
        redirectUris: ['http://localhost:6274/oauth/callback'],
      })
    })

    it('authenticates only with the right secret', async ctx => {
      await expectRejection(
        ctx.OAuthService.authenticateClient({
          clientId: ctx.clientId,
          clientSecret: 'ols_wrong',
        }),
        { code: 'invalid_client', status: 401 }
      )
      await expectRejection(
        ctx.OAuthService.authenticateClient({
          clientId: 'olo_000000000000000000000000',
          clientSecret: ctx.clientSecret,
        }),
        { code: 'invalid_client' }
      )
    })

    it('lists clients without their secrets', async ctx => {
      const [listed] = await ctx.OAuthService.listClients(OWNER_ID)
      expect(listed).toEqual({
        clientId: ctx.clientId,
        name: 'Claude',
        redirectUris: [CALLBACK],
        rotateRefreshTokens: true,
        createdAt: expect.any(Date),
        lastUsedAt: null,
      })
    })
  })

  describe('authorize validation', () => {
    it('accepts a valid request and defaults the scope to mcp', async ctx => {
      const { request } = await ctx.authorize({
        resource: `${SITE_URL}/mcp`,
      })
      expect(request.error).toBeNull()
      expect(request).toMatchObject({
        redirectUri: CALLBACK,
        state: 'xyz',
        scope: 'mcp',
      })
    })

    it('uses the only registered redirect URI when none is given', async ctx => {
      const { request } = await ctx.authorize({ redirect_uri: undefined })
      expect(request.redirectUri).toBe(CALLBACK)
    })

    it('shows an error page for an unknown client', async ctx => {
      await expectRejection(
        ctx.authorize({ client_id: 'olo_000000000000000000000000' }),
        { messageKey: 'oauth_error_unknown_client', status: 400 }
      )
    })

    it('shows an error page for an unregistered redirect URI', async ctx => {
      await expectRejection(
        ctx.authorize({ redirect_uri: 'https://evil.example/callback' }),
        { messageKey: 'oauth_error_redirect_uri_mismatch' }
      )
      await expectRejection(ctx.authorize({ redirect_uri: `${CALLBACK}/` }), {
        messageKey: 'oauth_error_redirect_uri_mismatch',
      })
    })

    it('shows an error page to a user who does not own the client', async ctx => {
      await expectRejection(
        ctx.OAuthService.validateAuthorizeRequest(
          {
            client_id: ctx.clientId,
            redirect_uri: CALLBACK,
            response_type: 'code',
            code_challenge: pkcePair().challenge,
            code_challenge_method: 'S256',
          },
          { userId: OTHER_USER_ID, siteUrl: SITE_URL }
        ),
        { messageKey: 'oauth_error_not_client_owner', status: 403 }
      )
    })

    it('reports protocol errors for the redirect URI', async ctx => {
      const cases = [
        [{ code_challenge: undefined }, 'invalid_request'],
        [{ code_challenge_method: undefined }, 'invalid_request'],
        [{ code_challenge_method: 'plain' }, 'invalid_request'],
        [{ code_challenge: 'too-short' }, 'invalid_request'],
        [{ response_type: 'token' }, 'unsupported_response_type'],
        [{ resource: 'https://elsewhere.example/mcp' }, 'invalid_target'],
        [{ scope: 'mcp admin' }, 'invalid_scope'],
      ]
      for (const [overrides, code] of cases) {
        const { request } = await ctx.authorize(overrides)
        expect(request.error, JSON.stringify(overrides)).toMatchObject({
          code,
        })
        expect(request.redirectUri).toBe(CALLBACK)
      }
    })
  })

  describe('authorization code exchange', () => {
    it('issues an mcp access token that the MCP endpoint accepts', async ctx => {
      const response = await ctx.issueTokens()
      expect(response).toEqual({
        access_token: expect.stringMatching(/^olp_[A-Za-z0-9]{16}$/),
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: expect.stringMatching(/^olr_/),
        scope: 'mcp',
      })
      const verified = await ctx.TokenService.verifyToken(
        response.access_token,
        'mcp'
      )
      expect(verified.userId).toBe(OWNER_ID)

      const [listed] = await ctx.TokenService.listTokens(OWNER_ID)
      expect(listed).toMatchObject({
        label: 'Claude (OAuth)',
        scopes: ['mcp'],
        source: 'oauth',
      })
      expect(ctx.codes.docs).toHaveLength(0)
    })

    it('rejects a code_verifier that does not match the challenge', async ctx => {
      const { request } = await ctx.authorize()
      const code = await ctx.OAuthService.createAuthorizationCode({
        ...request,
        userId: OWNER_ID,
      })
      await expectRejection(
        ctx.OAuthService.exchangeAuthorizationCode(ctx.client, {
          code,
          redirectUri: CALLBACK,
          codeVerifier: pkcePair().verifier,
        }),
        { code: 'invalid_grant' }
      )
      expect(ctx.tokens.docs).toHaveLength(0)
    })

    it('accepts a code only once', async ctx => {
      const { request, verifier } = await ctx.authorize()
      const code = await ctx.OAuthService.createAuthorizationCode({
        ...request,
        userId: OWNER_ID,
      })
      const exchange = () =>
        ctx.OAuthService.exchangeAuthorizationCode(ctx.client, {
          code,
          redirectUri: CALLBACK,
          codeVerifier: verifier,
        })
      await exchange()
      await expectRejection(exchange(), { code: 'invalid_grant' })
      expect(ctx.grants.docs).toHaveLength(1)
    })

    it('rejects a different redirect_uri, another client and expired codes', async ctx => {
      const { request, verifier } = await ctx.authorize()
      const createCode = () =>
        ctx.OAuthService.createAuthorizationCode({
          ...request,
          userId: OWNER_ID,
        })

      await expectRejection(
        ctx.OAuthService.exchangeAuthorizationCode(ctx.client, {
          code: await createCode(),
          redirectUri: 'https://claude.com/api/mcp/auth_callback',
          codeVerifier: verifier,
        }),
        { code: 'invalid_grant' }
      )

      const { clientSecret, client } = await ctx.OAuthService.createClient(
        OWNER_ID,
        { name: 'Other', redirectUris: [CALLBACK] }
      )
      const otherClient = await ctx.OAuthService.authenticateClient({
        clientId: client.clientId,
        clientSecret,
      })
      await expectRejection(
        ctx.OAuthService.exchangeAuthorizationCode(otherClient, {
          code: await createCode(),
          redirectUri: CALLBACK,
          codeVerifier: verifier,
        }),
        { code: 'invalid_grant' }
      )

      const expired = await createCode()
      vi.useFakeTimers({ now: Date.now() + 11 * 60 * 1000 })
      await expectRejection(
        ctx.OAuthService.exchangeAuthorizationCode(ctx.client, {
          code: expired,
          redirectUri: CALLBACK,
          codeVerifier: verifier,
        }),
        { code: 'invalid_grant' }
      )
    })
  })

  describe('access token lifetime', () => {
    it('maps an expired OAuth access token to token_expired', async ctx => {
      const { access_token: accessToken } = await ctx.issueTokens()
      vi.useFakeTimers({ now: Date.now() + HOUR + 1000 })
      await expectRejection(ctx.TokenService.verifyToken(accessToken, 'mcp'), {
        code: 'token_expired',
      })
    })
  })

  describe('refresh', () => {
    it('rotates both tokens and keeps one row per grant', async ctx => {
      const first = await ctx.issueTokens()
      vi.useFakeTimers({ now: Date.now() + HOUR + 1000 })
      const second = await ctx.OAuthService.refreshAccessToken(ctx.client, {
        refreshToken: first.refresh_token,
      })
      expect(second.refresh_token).not.toBe(first.refresh_token)
      expect(second.access_token).not.toBe(first.access_token)
      expect(
        (await ctx.TokenService.verifyToken(second.access_token, 'mcp')).userId
      ).toBe(OWNER_ID)
      await expectRejection(
        ctx.TokenService.verifyToken(first.access_token, 'mcp'),
        { code: 'token_invalid' }
      )
      expect(ctx.tokens.docs).toHaveLength(1)
      expect(ctx.grants.docs).toHaveLength(1)
    })

    it('revokes the grant when a rotated refresh token is reused', async ctx => {
      const first = await ctx.issueTokens()
      const second = await ctx.OAuthService.refreshAccessToken(ctx.client, {
        refreshToken: first.refresh_token,
      })
      await expectRejection(
        ctx.OAuthService.refreshAccessToken(ctx.client, {
          refreshToken: first.refresh_token,
        }),
        { code: 'invalid_grant' }
      )
      expect(ctx.grants.docs).toHaveLength(0)
      expect(ctx.tokens.docs).toHaveLength(0)
      await expectRejection(
        ctx.OAuthService.refreshAccessToken(ctx.client, {
          refreshToken: second.refresh_token,
        }),
        { code: 'invalid_grant' }
      )
    })

    it('treats clients stored without the option as rotating', async ctx => {
      delete ctx.clients.docs[0].rotateRefreshTokens
      const client = await ctx.OAuthService.authenticateClient({
        clientId: ctx.clientId,
        clientSecret: ctx.clientSecret,
      })
      const first = await ctx.issueTokens(client)
      const second = await ctx.OAuthService.refreshAccessToken(client, {
        refreshToken: first.refresh_token,
      })
      expect(second.refresh_token).toMatch(/^olr_/)
      expect(second.refresh_token).not.toBe(first.refresh_token)
      const [listed] = await ctx.OAuthService.listClients(OWNER_ID)
      expect(listed.rotateRefreshTokens).toBe(true)
    })

    it('keeps the refresh token of a client that does not rotate', async ctx => {
      const client = await ctx.createAuthenticatedClient({
        name: 'Gemini',
        rotateRefreshTokens: false,
      })
      const [stored] = ctx.clients.docs.filter(
        doc => doc.clientId === client.clientId
      )
      expect(stored.rotateRefreshTokens).toBe(false)

      const first = await ctx.issueTokens(client)
      expect(first.refresh_token).toMatch(/^olr_/)
      const start = Date.now()
      let previousAccessToken = first.access_token
      for (const days of [30, 60, 120]) {
        vi.useFakeTimers({ now: start + days * 24 * HOUR })
        const next = await ctx.OAuthService.refreshAccessToken(client, {
          refreshToken: first.refresh_token,
        })
        expect(next).toEqual({
          access_token: expect.stringMatching(/^olp_/),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp',
        })
        expect(next).not.toHaveProperty('refresh_token')
        expect(next.access_token).not.toBe(previousAccessToken)
        await expectRejection(
          ctx.TokenService.verifyToken(previousAccessToken, 'mcp'),
          { code: 'token_invalid' }
        )
        previousAccessToken = next.access_token
        const [grant] = ctx.grants.docs
        expect(grant.refreshExpiresAt.getTime()).toBe(
          Date.now() + 90 * 24 * HOUR
        )
        expect(grant.rotatedRefreshTokenHashes).toEqual([])
      }
      expect(ctx.grants.docs).toHaveLength(1)
      expect(ctx.tokens.docs).toHaveLength(1)

      vi.useFakeTimers({ now: start + 211 * 24 * HOUR })
      await expectRejection(
        ctx.OAuthService.refreshAccessToken(client, {
          refreshToken: first.refresh_token,
        }),
        { code: 'invalid_grant' }
      )
    })

    it('still revokes a non-rotating grant and its refresh token', async ctx => {
      const client = await ctx.createAuthenticatedClient({
        rotateRefreshTokens: false,
      })
      const first = await ctx.issueTokens(client)
      await ctx.OAuthService.refreshAccessToken(client, {
        refreshToken: first.refresh_token,
      })
      await ctx.OAuthService.revokeToken(client, first.refresh_token)
      expect(ctx.grants.docs).toHaveLength(0)
      expect(ctx.tokens.docs).toHaveLength(0)
      await expectRejection(
        ctx.OAuthService.refreshAccessToken(client, {
          refreshToken: first.refresh_token,
        }),
        { code: 'invalid_grant' }
      )
      await expectRejection(
        ctx.OAuthService.refreshAccessToken(ctx.client, {
          refreshToken: first.refresh_token,
        }),
        { code: 'invalid_grant' }
      )
    })

    it('stops refreshing once the user revokes the token in settings', async ctx => {
      const first = await ctx.issueTokens()
      const [listed] = await ctx.TokenService.listTokens(OWNER_ID)
      await ctx.TokenService.revokeToken(OWNER_ID, listed.id)
      await expectRejection(
        ctx.OAuthService.refreshAccessToken(ctx.client, {
          refreshToken: first.refresh_token,
        }),
        { code: 'invalid_grant' }
      )
      expect(ctx.grants.docs).toHaveLength(0)
    })

    it('rejects expired refresh tokens and other scopes', async ctx => {
      const first = await ctx.issueTokens()
      await expectRejection(
        ctx.OAuthService.refreshAccessToken(ctx.client, {
          refreshToken: first.refresh_token,
          scope: 'admin',
        }),
        { code: 'invalid_scope' }
      )
      vi.useFakeTimers({ now: Date.now() + 91 * 24 * HOUR })
      await expectRejection(
        ctx.OAuthService.refreshAccessToken(ctx.client, {
          refreshToken: first.refresh_token,
        }),
        { code: 'invalid_grant' }
      )
    })
  })

  describe('revocation', () => {
    it('deleting a client revokes its tokens, grants and codes', async ctx => {
      const issued = await ctx.issueTokens()
      const { request } = await ctx.authorize()
      await ctx.OAuthService.createAuthorizationCode({
        ...request,
        userId: OWNER_ID,
      })

      expect(
        await ctx.OAuthService.deleteClient(OTHER_USER_ID, ctx.clientId)
      ).toBe(false)
      expect(ctx.tokens.docs).toHaveLength(1)

      expect(await ctx.OAuthService.deleteClient(OWNER_ID, ctx.clientId)).toBe(
        true
      )
      expect(ctx.clients.docs).toHaveLength(0)
      expect(ctx.codes.docs).toHaveLength(0)
      expect(ctx.grants.docs).toHaveLength(0)
      await expectRejection(
        ctx.TokenService.verifyToken(issued.access_token, 'mcp'),
        { code: 'token_invalid' }
      )
    })

    it('revokes a grant by its refresh token or its access token', async ctx => {
      const first = await ctx.issueTokens()
      await ctx.OAuthService.revokeToken(ctx.client, first.refresh_token)
      expect(ctx.grants.docs).toHaveLength(0)
      expect(ctx.tokens.docs).toHaveLength(0)

      const second = await ctx.issueTokens()
      await ctx.OAuthService.revokeToken(ctx.client, second.access_token)
      expect(ctx.grants.docs).toHaveLength(0)
      expect(ctx.tokens.docs).toHaveLength(0)

      await ctx.OAuthService.revokeToken(ctx.client, 'olr_unknown')
    })

    it('does not touch personal access tokens the user created', async ctx => {
      await ctx.TokenService.createToken(OWNER_ID, { scopes: ['mcp'] })
      await ctx.issueTokens()
      await ctx.OAuthService.deleteClient(OWNER_ID, ctx.clientId)
      expect(ctx.tokens.docs).toHaveLength(1)
      expect(ctx.tokens.docs[0].source).toBeUndefined()
    })

    it('cleans up everything for a deleted user', async ctx => {
      await ctx.issueTokens()
      await ctx.OAuthService.cleanupForUser(OWNER_ID)
      expect(ctx.clients.docs).toHaveLength(0)
      expect(ctx.grants.docs).toHaveLength(0)
      expect(ctx.tokens.docs).toHaveLength(0)
    })
  })
})
