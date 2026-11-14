import { beforeEach, describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

const modulePath = '../../../app/src/OAuthController.mjs'
const SITE_URL = 'https://overleaf.example'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const CLIENT_ID = 'olo_0123456789abcdef01234567'

function makeRes() {
  const res = {
    headers: {},
    set: sinon.spy((name, value) => {
      res.headers[name] = value
      return res
    }),
    status: sinon.stub().returnsThis(),
    json: sinon.stub().returnsThis(),
    sendStatus: sinon.stub().returnsThis(),
    redirect: sinon.stub(),
    render: sinon.stub(),
  }
  return res
}

function makeReq({ query = {}, body = {}, params = {}, authorization } = {}) {
  const headers = authorization ? { authorization } : {}
  return {
    query,
    body,
    params,
    headers,
    session: {},
    get: name => headers[name.toLowerCase()],
  }
}

function basic(id, secret) {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
}

function redirectedUrl(res) {
  const [status, location] = res.redirect.firstCall.args
  return { status, url: new URL(location) }
}

describe('oauth OAuthController', () => {
  beforeEach(async ctx => {
    vi.resetModules()
    ctx.client = { clientId: CLIENT_ID, name: 'Claude' }
    ctx.OAuthService = {
      authenticateClient: sinon.stub().resolves(ctx.client),
      exchangeAuthorizationCode: sinon.stub().resolves({ access_token: 'a' }),
      refreshAccessToken: sinon.stub().resolves({ access_token: 'b' }),
      revokeToken: sinon.stub().resolves(),
      validateAuthorizeRequest: sinon.stub(),
      createAuthorizationCode: sinon.stub().resolves('olc_code'),
      createClient: sinon.stub(),
      listClients: sinon.stub().resolves([]),
      deleteClient: sinon.stub(),
    }
    vi.doMock('../../../app/src/OAuthService.mjs', () => ({
      default: { promises: ctx.OAuthService },
    }))
    ctx.logger = { info: sinon.stub(), err: sinon.stub() }
    vi.doMock('@overleaf/logger', () => ({ default: ctx.logger }))
    vi.doMock('@overleaf/settings', () => ({
      default: { siteUrl: `${SITE_URL}/` },
    }))
    vi.doMock(
      '../../../../../app/src/Features/Authentication/SessionManager.mjs',
      () => ({
        default: {
          getLoggedInUserId: sinon.stub().returns('user-1'),
          getSessionUser: sinon.stub().returns({ email: 'owner@example.com' }),
        },
      })
    )
    ctx.Controller = (await import(modulePath)).default
    ctx.Errors = await import('../../../app/src/OAuthErrors.mjs')
    ctx.res = makeRes()
  })

  describe('metadata', () => {
    it('serves protected resource metadata with CORS', async ctx => {
      ctx.Controller.protectedResourceMetadata(makeReq(), ctx.res)
      expect(ctx.res.json.firstCall.args[0]).toMatchObject({
        resource: `${SITE_URL}/mcp`,
        authorization_servers: [SITE_URL],
      })
      expect(ctx.res.headers['Access-Control-Allow-Origin']).toBe('*')
    })

    it('serves authorization server metadata', async ctx => {
      ctx.Controller.authorizationServerMetadata(makeReq(), ctx.res)
      expect(ctx.res.json.firstCall.args[0]).toMatchObject({
        issuer: SITE_URL,
        token_endpoint: `${SITE_URL}/oauth/token`,
      })
    })
  })

  describe('token endpoint', () => {
    it('accepts client_secret_basic and exchanges a code', async ctx => {
      const req = makeReq({
        authorization: basic(CLIENT_ID, 'ols_secret'),
        body: {
          grant_type: 'authorization_code',
          code: 'olc_code',
          redirect_uri: CALLBACK,
          code_verifier: 'v',
        },
      })
      await ctx.Controller.token(req, ctx.res)
      sinon.assert.calledWith(ctx.OAuthService.authenticateClient, {
        basic: true,
        clientId: CLIENT_ID,
        clientSecret: 'ols_secret',
      })
      sinon.assert.calledWith(
        ctx.OAuthService.exchangeAuthorizationCode,
        ctx.client,
        { code: 'olc_code', redirectUri: CALLBACK, codeVerifier: 'v' }
      )
      sinon.assert.calledWith(ctx.res.json, { access_token: 'a' })
      expect(ctx.res.headers['Cache-Control']).toBe('no-store')
    })

    it('url-decodes client_secret_basic credentials', async ctx => {
      const req = makeReq({
        authorization: basic(CLIENT_ID, 'ols_a%2Bb'),
        body: { grant_type: 'refresh_token', refresh_token: 'olr_x' },
      })
      await ctx.Controller.token(req, ctx.res)
      expect(
        ctx.OAuthService.authenticateClient.firstCall.args[0].clientSecret
      ).toBe('ols_a+b')
    })

    it('accepts client_secret_post and refreshes', async ctx => {
      const req = makeReq({
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'olr_x',
          client_id: CLIENT_ID,
          client_secret: 'ols_secret',
        },
      })
      await ctx.Controller.token(req, ctx.res)
      sinon.assert.calledWith(ctx.OAuthService.refreshAccessToken, ctx.client, {
        refreshToken: 'olr_x',
        scope: undefined,
      })
      sinon.assert.calledWith(ctx.res.json, { access_token: 'b' })
    })

    it('rejects two client authentication methods at once', async ctx => {
      const req = makeReq({
        authorization: basic(CLIENT_ID, 'ols_secret'),
        body: { grant_type: 'refresh_token', client_secret: 'ols_secret' },
      })
      await ctx.Controller.token(req, ctx.res)
      sinon.assert.calledWith(ctx.res.status, 400)
      expect(ctx.res.json.firstCall.args[0].error).toBe('invalid_request')
    })

    it('answers bad client credentials with 401 invalid_client', async ctx => {
      ctx.OAuthService.authenticateClient.rejects(
        new ctx.Errors.InvalidClientError()
      )
      await ctx.Controller.token(
        makeReq({
          authorization: basic(CLIENT_ID, 'wrong'),
          body: { grant_type: 'refresh_token' },
        }),
        ctx.res
      )
      sinon.assert.calledWith(ctx.res.status, 401)
      expect(ctx.res.json.firstCall.args[0].error).toBe('invalid_client')
      expect(ctx.res.headers['WWW-Authenticate']).toBe('Basic realm="Overleaf"')
    })

    it('reports missing and unsupported grant types', async ctx => {
      const post = { client_id: CLIENT_ID, client_secret: 's' }
      await ctx.Controller.token(makeReq({ body: post }), ctx.res)
      expect(ctx.res.json.lastCall.args[0].error).toBe('invalid_request')
      await ctx.Controller.token(
        makeReq({ body: { ...post, grant_type: 'client_credentials' } }),
        ctx.res
      )
      expect(ctx.res.json.lastCall.args[0].error).toBe('unsupported_grant_type')
    })

    it('passes grant errors through as RFC 6749 bodies', async ctx => {
      ctx.OAuthService.exchangeAuthorizationCode.rejects(
        new ctx.Errors.InvalidGrantError('code_verifier does not match')
      )
      await ctx.Controller.token(
        makeReq({
          body: {
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            client_secret: 's',
          },
        }),
        ctx.res
      )
      sinon.assert.calledWith(ctx.res.status, 400)
      sinon.assert.calledWith(ctx.res.json, {
        error: 'invalid_grant',
        error_description: 'code_verifier does not match',
      })
    })

    it('hides unexpected failures behind server_error', async ctx => {
      ctx.OAuthService.refreshAccessToken.rejects(new Error('mongo down'))
      await ctx.Controller.token(
        makeReq({
          body: {
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            client_secret: 's',
          },
        }),
        ctx.res
      )
      sinon.assert.calledWith(ctx.res.status, 500)
      expect(ctx.res.json.firstCall.args[0].error).toBe('server_error')
    })
  })

  describe('revocation endpoint', () => {
    it('revokes for the authenticated client and answers 200', async ctx => {
      await ctx.Controller.revoke(
        makeReq({
          body: { token: 'olr_x', client_id: CLIENT_ID, client_secret: 's' },
        }),
        ctx.res
      )
      sinon.assert.calledWith(ctx.OAuthService.revokeToken, ctx.client, 'olr_x')
      sinon.assert.calledWith(ctx.res.sendStatus, 200)
    })
  })

  describe('authorize', () => {
    beforeEach(ctx => {
      ctx.request = {
        client: ctx.client,
        redirectUri: CALLBACK,
        state: 'st',
        codeChallenge: 'c'.repeat(43),
        scope: 'mcp',
        error: null,
      }
      ctx.query = {
        client_id: CLIENT_ID,
        redirect_uri: CALLBACK,
        response_type: 'code',
        state: 'st',
        code_challenge: 'c'.repeat(43),
        code_challenge_method: 'S256',
      }
    })

    it('renders the consent page with the client and account', async ctx => {
      ctx.OAuthService.validateAuthorizeRequest.resolves(ctx.request)
      await ctx.Controller.showAuthorize(makeReq({ query: ctx.query }), ctx.res)
      sinon.assert.calledWith(
        ctx.OAuthService.validateAuthorizeRequest,
        sinon.match(ctx.query),
        { userId: 'user-1', siteUrl: `${SITE_URL}/` }
      )
      const [viewPath, locals] = ctx.res.render.firstCall.args
      expect(viewPath).toMatch(/views\/authorize$/)
      expect(locals).toMatchObject({
        clientName: 'Claude',
        userEmail: 'owner@example.com',
        redirectHost: 'claude.ai',
        hiddenFields: { client_id: CLIENT_ID, state: 'st' },
      })
    })

    it('renders an error page instead of redirecting for unusable clients', async ctx => {
      ctx.OAuthService.validateAuthorizeRequest.rejects(
        new ctx.Errors.AuthorizePageError('oauth_error_not_client_owner', 403)
      )
      await ctx.Controller.showAuthorize(makeReq({ query: ctx.query }), ctx.res)
      sinon.assert.calledWith(ctx.res.status, 403)
      const [viewPath, locals] = ctx.res.render.firstCall.args
      expect(viewPath).toMatch(/views\/authorize-error$/)
      expect(locals.messageKey).toBe('oauth_error_not_client_owner')
      sinon.assert.notCalled(ctx.res.redirect)
    })

    it('redirects protocol errors back with the state', async ctx => {
      ctx.OAuthService.validateAuthorizeRequest.resolves({
        ...ctx.request,
        error: new ctx.Errors.InvalidRequestError(
          'code_challenge is required (PKCE)'
        ),
      })
      await ctx.Controller.showAuthorize(makeReq({ query: ctx.query }), ctx.res)
      const { status, url } = redirectedUrl(ctx.res)
      expect(status).toBe(302)
      expect(url.origin + url.pathname).toBe(CALLBACK)
      expect(url.searchParams.get('error')).toBe('invalid_request')
      expect(url.searchParams.get('state')).toBe('st')
      expect(url.searchParams.get('iss')).toBe(SITE_URL)
    })

    it('redirects access_denied when the user denies', async ctx => {
      ctx.OAuthService.validateAuthorizeRequest.resolves(ctx.request)
      await ctx.Controller.decideAuthorize(
        makeReq({ body: { ...ctx.query, decision: 'deny' } }),
        ctx.res
      )
      const { status, url } = redirectedUrl(ctx.res)
      expect(status).toBe(303)
      expect(url.searchParams.get('error')).toBe('access_denied')
      expect(url.searchParams.get('state')).toBe('st')
      sinon.assert.notCalled(ctx.OAuthService.createAuthorizationCode)
    })

    it('redirects with a code when the user approves', async ctx => {
      ctx.OAuthService.validateAuthorizeRequest.resolves(ctx.request)
      await ctx.Controller.decideAuthorize(
        makeReq({ body: { ...ctx.query, decision: 'approve' } }),
        ctx.res
      )
      sinon.assert.calledWith(ctx.OAuthService.createAuthorizationCode, {
        client: ctx.client,
        userId: 'user-1',
        redirectUri: CALLBACK,
        codeChallenge: 'c'.repeat(43),
        scope: 'mcp',
      })
      const { url } = redirectedUrl(ctx.res)
      expect(url.searchParams.get('code')).toBe('olc_code')
      expect(url.searchParams.get('state')).toBe('st')
      expect(url.searchParams.has('error')).toBe(false)
    })

    it('checks the posted decision again before issuing a code', async ctx => {
      ctx.OAuthService.validateAuthorizeRequest.rejects(
        new ctx.Errors.AuthorizePageError('oauth_error_redirect_uri_mismatch')
      )
      await ctx.Controller.decideAuthorize(
        makeReq({ body: { ...ctx.query, decision: 'approve' } }),
        ctx.res
      )
      sinon.assert.calledWith(ctx.res.status, 400)
      sinon.assert.notCalled(ctx.OAuthService.createAuthorizationCode)
    })

    it('logs the redirect URI of a mismatched request', async ctx => {
      ctx.OAuthService.validateAuthorizeRequest.rejects(
        new ctx.Errors.AuthorizePageError('oauth_error_redirect_uri_mismatch')
      )
      const redirectUri = 'https://oauth-redirect.googleusercontent.com/r/p'
      await ctx.Controller.showAuthorize(
        makeReq({ query: { ...ctx.query, redirect_uri: redirectUri } }),
        ctx.res
      )
      sinon.assert.calledOnce(ctx.logger.info)
      const [fields] = ctx.logger.info.firstCall.args
      expect(fields).toEqual({ clientId: CLIENT_ID, redirectUri })
    })
  })

  describe('client management', () => {
    it('returns the secret once on creation', async ctx => {
      ctx.OAuthService.createClient.resolves({
        clientSecret: 'ols_secret',
        client: { clientId: CLIENT_ID, name: 'Claude' },
      })
      await ctx.Controller.createClient(
        makeReq({ body: { name: 'Claude', redirectUris: [CALLBACK] } }),
        ctx.res
      )
      sinon.assert.calledWith(ctx.OAuthService.createClient, 'user-1', {
        name: 'Claude',
        redirectUris: [CALLBACK],
      })
      sinon.assert.calledWith(ctx.res.json, {
        clientId: CLIENT_ID,
        name: 'Claude',
        clientSecret: 'ols_secret',
      })
    })

    it('passes the refresh token rotation choice on', async ctx => {
      ctx.OAuthService.createClient.resolves({
        clientSecret: 'ols_secret',
        client: { clientId: CLIENT_ID, name: 'Gemini' },
      })
      await ctx.Controller.createClient(
        makeReq({
          body: {
            name: 'Gemini',
            redirectUris: [CALLBACK],
            rotateRefreshTokens: false,
          },
        }),
        ctx.res
      )
      sinon.assert.calledWith(ctx.OAuthService.createClient, 'user-1', {
        name: 'Gemini',
        redirectUris: [CALLBACK],
        rotateRefreshTokens: false,
      })
    })

    it('answers invalid redirect URIs with a 400 message', async ctx => {
      ctx.OAuthService.createClient.rejects(
        new ctx.Errors.InvalidRequestError('redirect URI must be https')
      )
      await ctx.Controller.createClient(
        makeReq({ body: { name: 'x', redirectUris: ['http://x'] } }),
        ctx.res
      )
      sinon.assert.calledWith(ctx.res.status, 400)
      sinon.assert.calledWith(ctx.res.json, {
        message: 'redirect URI must be https',
      })
    })

    it('deletes only the caller’s clients', async ctx => {
      ctx.OAuthService.deleteClient.resolves(false)
      await ctx.Controller.deleteClient(
        makeReq({ params: { clientId: CLIENT_ID } }),
        ctx.res
      )
      sinon.assert.calledWith(
        ctx.OAuthService.deleteClient,
        'user-1',
        CLIENT_ID
      )
      sinon.assert.calledWith(ctx.res.sendStatus, 404)
    })
  })
})
