import Path from 'node:path'
import { fileURLToPath } from 'node:url'
import basicAuth from 'basic-auth'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import { z, parseReq } from '../../../../app/src/infrastructure/Validation.mjs'
import OAuthService from './OAuthService.mjs'
import OAuthMetadata from './OAuthMetadata.mjs'
import {
  AuthorizePageError,
  InvalidClientError,
  InvalidRequestError,
  OAuthError,
  UnsupportedGrantTypeError,
} from './OAuthErrors.mjs'

const __dirname = Path.dirname(fileURLToPath(import.meta.url))

// OAuth parameters are optional strings. Anything else (a repeated parameter
// arrives as an array) is treated as absent and reported by the checks.
const optionalParam = z.string().optional().catch(undefined)

const AUTHORIZE_PARAMS = {
  client_id: optionalParam,
  redirect_uri: optionalParam,
  response_type: optionalParam,
  state: optionalParam,
  code_challenge: optionalParam,
  code_challenge_method: optionalParam,
  scope: optionalParam,
  resource: optionalParam,
}

const authorizeQuerySchema = z.object({
  query: z.object(AUTHORIZE_PARAMS).catch({}),
})

const authorizeDecisionSchema = z.object({
  body: z.object({ ...AUTHORIZE_PARAMS, decision: optionalParam }).catch({}),
})

const tokenRequestSchema = z.object({
  body: z
    .object({
      grant_type: optionalParam,
      code: optionalParam,
      redirect_uri: optionalParam,
      code_verifier: optionalParam,
      refresh_token: optionalParam,
      scope: optionalParam,
      client_id: optionalParam,
      client_secret: optionalParam,
    })
    .catch({}),
})

const revokeRequestSchema = z.object({
  body: z
    .object({
      token: optionalParam,
      token_type_hint: optionalParam,
      client_id: optionalParam,
      client_secret: optionalParam,
    })
    .catch({}),
})

const createClientSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(100),
    redirectUris: z.array(z.string().max(2048)).min(1).max(10),
  }),
})

const deleteClientSchema = z.object({
  params: z.object({
    clientId: z.string().regex(/^olo_[0-9a-f]{24}$/),
  }),
})

function view(name) {
  return Path.resolve(__dirname, '../views', name)
}

function siteUrl() {
  return Settings.siteUrl
}

// Browser-based MCP clients read discovery documents and call the token
// endpoint cross-origin. None of these use cookies, so any origin is fine.
function allowCrossOrigin(res) {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.set(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, MCP-Protocol-Version'
  )
  res.set('Access-Control-Max-Age', '86400')
}

function preflight(req, res) {
  allowCrossOrigin(res)
  res.sendStatus(204)
}

function sendMetadata(res, document) {
  allowCrossOrigin(res)
  res.set('Cache-Control', 'public, max-age=3600')
  res.json(document)
}

function protectedResourceMetadata(req, res) {
  sendMetadata(res, OAuthMetadata.protectedResourceMetadata(siteUrl()))
}

function authorizationServerMetadata(req, res) {
  sendMetadata(res, OAuthMetadata.authorizationServerMetadata(siteUrl()))
}

function redirectWithParams(res, status, redirectUri, params) {
  const url = new URL(redirectUri)
  for (const [name, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(name, value)
  }
  res.redirect(status, url.toString())
}

function redirectWithError(res, status, request, error) {
  redirectWithParams(res, status, request.redirectUri, {
    error: error.code,
    error_description: error.message,
    state: request.state,
    iss: OAuthMetadata.issuer(siteUrl()),
  })
}

function renderAuthorizeError(res, error) {
  res.status(error.status).render(view('authorize-error'), {
    title: 'oauth_error_title',
    messageKey: error.messageKey,
  })
}

async function validateForLoggedInUser(req, params) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  return OAuthService.promises.validateAuthorizeRequest(params, {
    userId,
    siteUrl: siteUrl(),
  })
}

// Runs the authorize checks and answers the request itself when they fail.
// Returns the validated request, or null when a response was sent.
async function checkAuthorizeRequest(req, res, params, redirectStatus) {
  let request
  try {
    request = await validateForLoggedInUser(req, params)
  } catch (error) {
    if (error instanceof AuthorizePageError) {
      renderAuthorizeError(res, error)
      return null
    }
    throw error
  }
  if (request.error) {
    redirectWithError(res, redirectStatus, request, request.error)
    return null
  }
  return request
}

async function showAuthorize(req, res) {
  const { query } = parseReq(req, authorizeQuerySchema)
  const request = await checkAuthorizeRequest(req, res, query, 302)
  if (!request) return
  const user = SessionManager.getSessionUser(req.session)
  res.render(view('authorize'), {
    title: 'oauth_authorize_title',
    clientName: request.client.name,
    userEmail: user?.email,
    redirectHost: new URL(request.redirectUri).host,
    // The decision form posts the same request back; it is checked again.
    hiddenFields: {
      client_id: request.client.clientId,
      redirect_uri: request.redirectUri,
      response_type: query.response_type,
      state: query.state,
      code_challenge: query.code_challenge,
      code_challenge_method: query.code_challenge_method,
      scope: query.scope,
      resource: query.resource,
    },
  })
}

async function decideAuthorize(req, res) {
  const { body } = parseReq(req, authorizeDecisionSchema)
  const request = await checkAuthorizeRequest(req, res, body, 303)
  if (!request) return
  if (body.decision !== 'approve') {
    const denied = new OAuthError(
      'access_denied',
      'the user denied the request'
    )
    return redirectWithError(res, 303, request, denied)
  }
  const code = await OAuthService.promises.createAuthorizationCode({
    client: request.client,
    userId: SessionManager.getLoggedInUserId(req.session),
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scope: request.scope,
  })
  redirectWithParams(res, 303, request.redirectUri, {
    code,
    state: request.state,
    iss: OAuthMetadata.issuer(siteUrl()),
  })
}

function decodeBasicPart(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    throw new InvalidClientError('malformed client credentials')
  }
}

// client_secret_basic (credentials form-urlencoded inside Basic, RFC 6749
// 2.3.1) or client_secret_post. Using both at once is rejected.
function getClientCredentials(req, body) {
  const authorization = req.get('authorization')
  if (!authorization) {
    return {
      basic: false,
      clientId: body.client_id,
      clientSecret: body.client_secret,
    }
  }
  const credentials = basicAuth(req)
  if (!credentials) {
    throw new InvalidClientError('unsupported client authentication')
  }
  if (body.client_secret != null) {
    throw new InvalidRequestError('use only one client authentication method')
  }
  const clientId = decodeBasicPart(credentials.name)
  if (body.client_id != null && body.client_id !== clientId) {
    throw new InvalidClientError('client_id does not match')
  }
  return {
    basic: true,
    clientId,
    clientSecret: decodeBasicPart(credentials.pass),
  }
}

function sendOAuthError(res, error, { basic }) {
  if (!(error instanceof OAuthError)) {
    logger.err({ err: error }, 'oauth endpoint failed')
    return res
      .status(500)
      .json({ error: 'server_error', error_description: 'internal error' })
  }
  if (error instanceof InvalidClientError && basic) {
    res.set('WWW-Authenticate', 'Basic realm="Overleaf"')
  }
  return res.status(error.status).json(error.toResponseObject())
}

async function runTokenGrant(client, body) {
  if (body.grant_type === 'authorization_code') {
    return OAuthService.promises.exchangeAuthorizationCode(client, {
      code: body.code,
      redirectUri: body.redirect_uri,
      codeVerifier: body.code_verifier,
    })
  }
  if (body.grant_type === 'refresh_token') {
    return OAuthService.promises.refreshAccessToken(client, {
      refreshToken: body.refresh_token,
      scope: body.scope,
    })
  }
  if (body.grant_type == null) {
    throw new InvalidRequestError('grant_type is required')
  }
  throw new UnsupportedGrantTypeError()
}

async function token(req, res) {
  allowCrossOrigin(res)
  res.set('Cache-Control', 'no-store')
  res.set('Pragma', 'no-cache')
  const { body } = parseReq(req, tokenRequestSchema)
  const context = { basic: false }
  try {
    const credentials = getClientCredentials(req, body)
    context.basic = credentials.basic
    const client = await OAuthService.promises.authenticateClient(credentials)
    res.json(await runTokenGrant(client, body))
  } catch (error) {
    sendOAuthError(res, error, context)
  }
}

async function revoke(req, res) {
  allowCrossOrigin(res)
  res.set('Cache-Control', 'no-store')
  const { body } = parseReq(req, revokeRequestSchema)
  const context = { basic: false }
  try {
    const credentials = getClientCredentials(req, body)
    context.basic = credentials.basic
    const client = await OAuthService.promises.authenticateClient(credentials)
    await OAuthService.promises.revokeToken(client, body.token)
    res.sendStatus(200)
  } catch (error) {
    sendOAuthError(res, error, context)
  }
}

async function listClients(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  res.json(await OAuthService.promises.listClients(userId))
}

async function createClient(req, res) {
  const { body } = parseReq(req, createClientSchema)
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    const { clientSecret, client } = await OAuthService.promises.createClient(
      userId,
      body
    )
    res.json({ ...client, clientSecret })
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      return res.status(400).json({ message: error.message })
    }
    throw error
  }
}

async function deleteClient(req, res) {
  const { params } = parseReq(req, deleteClientSchema)
  const userId = SessionManager.getLoggedInUserId(req.session)
  const deleted = await OAuthService.promises.deleteClient(
    userId,
    params.clientId
  )
  res.sendStatus(deleted ? 204 : 404)
}

export default {
  preflight,
  protectedResourceMetadata,
  authorizationServerMetadata,
  showAuthorize,
  decideAuthorize,
  token,
  revoke,
  listClients,
  createClient,
  deleteClient,
}
