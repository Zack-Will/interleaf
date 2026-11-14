import crypto from 'node:crypto'
import TokenService from '../../../project-sync/app/src/TokenService.mjs'
import { OAuthClient } from './models/OAuthClient.mjs'
import { OAuthAuthorizationCode } from './models/OAuthAuthorizationCode.mjs'
import { OAuthGrant } from './models/OAuthGrant.mjs'
import { SCOPE, resourceUrl } from './OAuthMetadata.mjs'
import {
  AuthorizePageError,
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  UnsupportedResponseTypeError,
} from './OAuthErrors.mjs'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const ACCESS_TOKEN_LIFETIME_MS = HOUR
export const REFRESH_TOKEN_LIFETIME_MS = 90 * DAY
export const AUTHORIZATION_CODE_LIFETIME_MS = 10 * MINUTE

// Enough to recognise a replayed refresh token for a while after it rotated.
const ROTATED_HASHES_KEPT = 20

const MAX_REDIRECT_URIS = 10
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

function maybeExec(value) {
  return value && typeof value.exec === 'function' ? value.exec() : value
}

function idToString(id) {
  return id == null ? id : id.toString()
}

function randomSecret(prefix, bytes = 30) {
  return prefix + crypto.randomBytes(bytes).toString('base64url')
}

function makeClientId() {
  return 'olo_' + crypto.randomBytes(12).toString('hex')
}

function hashSecret(secret) {
  return TokenService.hashToken(secret)
}

function hashesMatch(secret, hashed) {
  const actual = Buffer.from(hashSecret(secret), 'hex')
  const expected = Buffer.from(String(hashed), 'hex')
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  )
}

function fromNow(milliseconds) {
  return new Date(Date.now() + milliseconds)
}

function isExpired(date) {
  return new Date(date).getTime() <= Date.now()
}

function serializeClient(record) {
  return {
    clientId: record.clientId,
    name: record.name,
    redirectUris: record.redirectUris || [],
    rotateRefreshTokens: rotatesRefreshTokens(record),
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt ?? null,
  }
}

// Clients created before the option existed rotate their refresh tokens.
function rotatesRefreshTokens(client) {
  return client.rotateRefreshTokens !== false
}

function accessTokenLabel(client) {
  return `${client.name} (OAuth)`
}

/**
 * Redirect URIs are matched exactly at authorization time, so they are
 * checked once here: absolute, no fragment, https unless loopback.
 */
export function isAllowedRedirectUri(value) {
  if (typeof value !== 'string' || value.length > 2048) return false
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.hash || value.includes('#')) return false
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

export function verifyPkce(codeVerifier, codeChallenge) {
  if (
    typeof codeVerifier !== 'string' ||
    !CODE_VERIFIER_PATTERN.test(codeVerifier)
  ) {
    return false
  }
  const computed = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url')
  const expected = String(codeChallenge)
  return (
    computed.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected))
  )
}

// The only scope is `mcp`; an absent scope means `mcp`.
export function parseScope(scope) {
  if (scope == null || scope.trim() === '') return SCOPE
  const values = scope.trim().split(/\s+/)
  if (values.some(value => value !== SCOPE)) {
    throw new InvalidScopeError()
  }
  return SCOPE
}

function sameResource(value, siteUrl) {
  return value.replace(/\/+$/, '') === resourceUrl(siteUrl)
}

async function createClient(
  userId,
  { name, redirectUris, rotateRefreshTokens = true }
) {
  const uris = [...new Set(redirectUris.map(uri => uri.trim()))].filter(Boolean)
  if (uris.length === 0) {
    throw new InvalidRequestError('at least one redirect URI is required')
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    throw new InvalidRequestError(
      `at most ${MAX_REDIRECT_URIS} redirect URIs are allowed`
    )
  }
  const invalid = uris.find(uri => !isAllowedRedirectUri(uri))
  if (invalid) {
    throw new InvalidRequestError(
      `redirect URI must be an absolute https URL without a fragment: ${invalid}`
    )
  }
  const clientSecret = randomSecret('ols_')
  const record = await OAuthClient.create({
    clientId: makeClientId(),
    hashedSecret: hashSecret(clientSecret),
    user_id: userId,
    name: name.trim(),
    redirectUris: uris,
    rotateRefreshTokens: rotateRefreshTokens !== false,
    createdAt: new Date(),
    lastUsedAt: null,
  })
  return { clientSecret, client: serializeClient(record) }
}

async function listClients(userId) {
  const query = OAuthClient.find({ user_id: userId })
  const sorted =
    query && typeof query.sort === 'function'
      ? query.sort({ createdAt: -1 })
      : query
  const records = await maybeExec(
    sorted && typeof sorted.lean === 'function' ? sorted.lean() : sorted
  )
  return (records || []).map(serializeClient)
}

async function getClient(clientId) {
  if (typeof clientId !== 'string' || clientId === '') return null
  return maybeExec(OAuthClient.findOne({ clientId }))
}

// Deleting a client ends every connection made with it.
async function deleteClient(userId, clientId) {
  const result = await maybeExec(
    OAuthClient.deleteOne({ clientId, user_id: userId })
  )
  if (!result || result.deletedCount === 0) return false
  await revokeEverythingForClient(clientId)
  return true
}

async function revokeEverythingForClient(clientId) {
  await maybeExec(OAuthAuthorizationCode.deleteMany({ clientId }))
  await maybeExec(OAuthGrant.deleteMany({ clientId }))
  await TokenService.promises.revokeOAuthAccessTokensForClient(clientId)
}

// Removes a deleted user's clients and everything issued with them. Their
// access tokens are personal access tokens, removed by project-sync.
async function cleanupForUser(userId) {
  const clients = await maybeExec(OAuthClient.find({ user_id: userId }))
  for (const client of clients || []) {
    await revokeEverythingForClient(client.clientId)
  }
  await maybeExec(OAuthClient.deleteMany({ user_id: userId }))
  await maybeExec(OAuthGrant.deleteMany({ user_id: userId }))
  await maybeExec(OAuthAuthorizationCode.deleteMany({ user_id: userId }))
}

async function authenticateClient({ clientId, clientSecret }) {
  if (typeof clientSecret !== 'string' || clientSecret === '') {
    throw new InvalidClientError()
  }
  const client = await getClient(clientId)
  if (!client || !hashesMatch(clientSecret, client.hashedSecret)) {
    throw new InvalidClientError()
  }
  return client
}

function touchClient(client) {
  // A usage timestamp must never fail or delay token issuance.
  Promise.resolve()
    .then(() =>
      maybeExec(
        OAuthClient.updateOne(
          { _id: client._id },
          { $set: { lastUsedAt: new Date() } }
        )
      )
    )
    .catch(() => {})
}

function resolveRedirectUri(client, redirectUri) {
  if (redirectUri == null) {
    if (client.redirectUris.length === 1) return client.redirectUris[0]
    throw new AuthorizePageError('oauth_error_redirect_uri_mismatch')
  }
  if (!client.redirectUris.includes(redirectUri)) {
    throw new AuthorizePageError('oauth_error_redirect_uri_mismatch')
  }
  return redirectUri
}

function findAuthorizeError(params, siteUrl) {
  if (params.response_type !== 'code') {
    return new UnsupportedResponseTypeError()
  }
  if (!params.code_challenge) {
    return new InvalidRequestError('code_challenge is required (PKCE)')
  }
  if (params.code_challenge_method !== 'S256') {
    return new InvalidRequestError('code_challenge_method must be S256')
  }
  if (!CODE_CHALLENGE_PATTERN.test(params.code_challenge)) {
    return new InvalidRequestError('code_challenge is malformed')
  }
  if (params.resource != null && !sameResource(params.resource, siteUrl)) {
    return new InvalidTargetError(`resource must be ${resourceUrl(siteUrl)}`)
  }
  try {
    parseScope(params.scope)
  } catch (error) {
    return error
  }
  return null
}

/**
 * Checks an authorization request for the logged-in user.
 *
 * Throws AuthorizePageError when the response cannot go back to the client:
 * unknown client, unregistered redirect URI, or a user who does not own the
 * client. Other problems come back as `error`, to be sent to the redirect URI.
 */
async function validateAuthorizeRequest(params, { userId, siteUrl }) {
  const client = await getClient(params.client_id)
  if (!client) {
    throw new AuthorizePageError('oauth_error_unknown_client')
  }
  const redirectUri = resolveRedirectUri(client, params.redirect_uri)
  if (idToString(client.user_id) !== idToString(userId)) {
    throw new AuthorizePageError('oauth_error_not_client_owner', 403)
  }
  return {
    client,
    redirectUri,
    state: params.state,
    codeChallenge: params.code_challenge,
    scope: SCOPE,
    error: findAuthorizeError(params, siteUrl),
  }
}

async function createAuthorizationCode({
  client,
  userId,
  redirectUri,
  codeChallenge,
  scope,
}) {
  const code = randomSecret('olc_')
  await OAuthAuthorizationCode.create({
    hashedCode: hashSecret(code),
    clientId: client.clientId,
    user_id: userId,
    redirectUri,
    codeChallenge,
    scope,
    createdAt: new Date(),
    expiresAt: fromNow(AUTHORIZATION_CODE_LIFETIME_MS),
  })
  return code
}

// Without a refresh token the client keeps the one it has (RFC 6749 6).
function tokenResponse({ accessToken, refreshToken, scope }) {
  const response = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_LIFETIME_MS / SECOND,
  }
  if (refreshToken != null) {
    response.refresh_token = refreshToken
  }
  response.scope = scope
  return response
}

async function createGrant(client, { userId, scope }) {
  const { token, record } = await TokenService.promises.createOAuthAccessToken(
    userId,
    {
      label: accessTokenLabel(client),
      clientId: client.clientId,
      expiresAt: fromNow(ACCESS_TOKEN_LIFETIME_MS),
    }
  )
  const refreshToken = randomSecret('olr_', 36)
  try {
    await OAuthGrant.create({
      hashedRefreshToken: hashSecret(refreshToken),
      rotatedRefreshTokenHashes: [],
      clientId: client.clientId,
      user_id: userId,
      tokenId: record._id,
      scope,
      createdAt: new Date(),
      refreshExpiresAt: fromNow(REFRESH_TOKEN_LIFETIME_MS),
    })
  } catch (error) {
    await TokenService.promises.revokeOAuthAccessTokenById(record._id)
    throw error
  }
  return tokenResponse({ accessToken: token, refreshToken, scope })
}

// Codes are single use: the code is deleted before it is checked, so a
// failed attempt burns it too.
async function exchangeAuthorizationCode(
  client,
  { code, redirectUri, codeVerifier }
) {
  if (typeof code !== 'string' || code === '') {
    throw new InvalidRequestError('code is required')
  }
  if (typeof codeVerifier !== 'string' || codeVerifier === '') {
    throw new InvalidRequestError('code_verifier is required')
  }
  const record = await maybeExec(
    OAuthAuthorizationCode.findOneAndDelete({ hashedCode: hashSecret(code) })
  )
  if (!record || isExpired(record.expiresAt)) {
    throw new InvalidGrantError('authorization code is invalid or expired')
  }
  if (record.clientId !== client.clientId) {
    throw new InvalidGrantError(
      'authorization code was issued to another client'
    )
  }
  if (redirectUri != null && redirectUri !== record.redirectUri) {
    throw new InvalidGrantError('redirect_uri does not match')
  }
  if (!verifyPkce(codeVerifier, record.codeChallenge)) {
    throw new InvalidGrantError('code_verifier does not match the challenge')
  }
  touchClient(client)
  return createGrant(client, { userId: record.user_id, scope: record.scope })
}

async function revokeGrant(grant) {
  await maybeExec(OAuthGrant.deleteOne({ _id: grant._id }))
  await TokenService.promises.revokeOAuthAccessTokenById(grant.tokenId)
}

function findLiveGrant(client, hashed) {
  return {
    hashedRefreshToken: hashed,
    clientId: client.clientId,
    refreshExpiresAt: { $gt: new Date() },
  }
}

// Every refresh issues a new refresh token and invalidates the old one. A
// rotated token that comes back means it leaked: the whole grant is revoked.
async function rotateRefreshToken(client, hashed) {
  const nextRefreshToken = randomSecret('olr_', 36)
  const grant = await maybeExec(
    OAuthGrant.findOneAndUpdate(
      findLiveGrant(client, hashed),
      {
        $set: {
          hashedRefreshToken: hashSecret(nextRefreshToken),
          refreshExpiresAt: fromNow(REFRESH_TOKEN_LIFETIME_MS),
        },
        $push: {
          rotatedRefreshTokenHashes: {
            $each: [hashed],
            $slice: -ROTATED_HASHES_KEPT,
          },
        },
      },
      { new: true }
    )
  )
  if (!grant) {
    const replayed = await maybeExec(
      OAuthGrant.findOne({ rotatedRefreshTokenHashes: hashed })
    )
    if (replayed) {
      await revokeGrant(replayed)
      throw new InvalidGrantError(
        'refresh token was already used; the grant has been revoked'
      )
    }
    throw new InvalidGrantError('refresh token is invalid or expired')
  }
  return { grant, refreshToken: nextRefreshToken }
}

// Some clients (Gemini) must keep their refresh token: it stays valid and its
// expiry slides with each use.
async function keepRefreshToken(client, hashed) {
  const grant = await maybeExec(
    OAuthGrant.findOneAndUpdate(
      findLiveGrant(client, hashed),
      { $set: { refreshExpiresAt: fromNow(REFRESH_TOKEN_LIFETIME_MS) } },
      { new: true }
    )
  )
  if (!grant) {
    throw new InvalidGrantError('refresh token is invalid or expired')
  }
  return { grant, refreshToken: undefined }
}

async function refreshAccessToken(client, { refreshToken, scope }) {
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new InvalidRequestError('refresh_token is required')
  }
  const grantedScope = parseScope(scope)
  const hashed = hashSecret(refreshToken)
  const renew = rotatesRefreshTokens(client)
    ? rotateRefreshToken
    : keepRefreshToken
  const { grant, refreshToken: nextRefreshToken } = await renew(client, hashed)

  const rotated = await TokenService.promises.rotateOAuthAccessToken(
    grant.tokenId,
    fromNow(ACCESS_TOKEN_LIFETIME_MS)
  )
  if (!rotated) {
    // The user revoked the access token in their settings.
    await maybeExec(OAuthGrant.deleteOne({ _id: grant._id }))
    throw new InvalidGrantError('the grant has been revoked')
  }
  touchClient(client)
  return tokenResponse({
    accessToken: rotated.token,
    refreshToken: nextRefreshToken,
    scope: grantedScope,
  })
}

// RFC 7009: revoking either token of a grant ends the grant. Unknown tokens
// are not an error.
async function revokeToken(client, token) {
  if (typeof token !== 'string' || token === '') {
    throw new InvalidRequestError('token is required')
  }
  const grant = await maybeExec(
    OAuthGrant.findOne({
      hashedRefreshToken: hashSecret(token),
      clientId: client.clientId,
    })
  )
  if (grant) {
    await revokeGrant(grant)
    return
  }
  const accessToken = await TokenService.promises.revokeOAuthAccessToken(
    token,
    client.clientId
  )
  if (accessToken) {
    await maybeExec(OAuthGrant.deleteMany({ tokenId: accessToken._id }))
  }
}

const methods = {
  createClient,
  listClients,
  getClient,
  deleteClient,
  cleanupForUser,
  authenticateClient,
  validateAuthorizeRequest,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
}

const OAuthService = {
  ...methods,
  promises: methods,
}

export default OAuthService
