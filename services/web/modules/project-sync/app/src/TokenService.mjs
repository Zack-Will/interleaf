import crypto from 'node:crypto'
import { PersonalAccessToken } from './models/PersonalAccessToken.mjs'
import {
  InsufficientScopeError,
  InvalidTokenRequestError,
  TokenExpiredError,
  TokenInvalidError,
} from './Errors.mjs'

const TOKEN_PREFIX = 'olp_'
const TOKEN_LENGTH = 16
const TOKEN_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const ALLOWED_SCOPES = new Set(['git_bridge', 'mcp'])

function maybeExec(value) {
  return value && typeof value.exec === 'function' ? value.exec() : value
}

function makeToken() {
  const bytes = crypto.randomBytes(TOKEN_LENGTH)
  let suffix = ''
  for (const byte of bytes) {
    suffix += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]
  }
  return TOKEN_PREFIX + suffix
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function normalizeScopes(scopes) {
  if (scopes != null && !Array.isArray(scopes)) {
    throw new InvalidTokenRequestError('token scopes must be an array')
  }
  const values = scopes == null ? ['git_bridge'] : [...new Set(scopes)]
  if (values.length === 0) {
    throw new InvalidTokenRequestError('at least one token scope is required')
  }
  if (values.some(scope => !ALLOWED_SCOPES.has(scope))) {
    throw new InvalidTokenRequestError(
      'unsupported personal access token scope'
    )
  }
  return values
}

function expiresAtFromDays(expiresInDays) {
  if (expiresInDays == null || expiresInDays === '') return null
  let days
  try {
    days = Number(expiresInDays)
  } catch (error) {
    throw new InvalidTokenRequestError(
      'expiresInDays must be a positive number',
      { cause: error }
    )
  }
  if (!Number.isFinite(days) || days <= 0) {
    throw new InvalidTokenRequestError(
      'expiresInDays must be a positive number'
    )
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

function idToString(id) {
  return id == null ? id : id.toString()
}

async function createToken(userId, options = {}) {
  const scopes = normalizeScopes(options.scopes)
  const token = makeToken()
  const record = await PersonalAccessToken.create({
    user_id: userId,
    tokenPrefix: token.slice(0, 8),
    hashedToken: hashToken(token),
    scopes,
    label: options.label || '',
    createdAt: new Date(),
    expiresAt: expiresAtFromDays(options.expiresInDays),
    lastUsedAt: null,
  })
  return { token, record }
}

async function verifyToken(token, requiredScope) {
  if (typeof token !== 'string' || !/^olp_[A-Za-z0-9]{16}$/.test(token)) {
    throw new TokenInvalidError()
  }

  const record = await maybeExec(
    PersonalAccessToken.findOne({ hashedToken: hashToken(token) })
  )
  if (!record) throw new TokenInvalidError()

  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
    throw new TokenExpiredError()
  }

  if (requiredScope && !record.scopes?.includes(requiredScope)) {
    throw new InsufficientScopeError()
  }

  // Token use should not delay the request or make authentication fail when the
  // audit timestamp update is temporarily unavailable.
  Promise.resolve()
    .then(() =>
      maybeExec(
        PersonalAccessToken.updateOne(
          { _id: record._id },
          { $set: { lastUsedAt: new Date() } }
        )
      )
    )
    .catch(() => {})

  return {
    userId: idToString(record.user_id),
    scopes: record.scopes || [],
    tokenId: idToString(record._id),
  }
}

async function listTokens(userId) {
  const query = PersonalAccessToken.find({ user_id: userId })
  const sorted =
    query && typeof query.sort === 'function'
      ? query.sort({ createdAt: -1 })
      : query
  const records = await maybeExec(
    sorted && typeof sorted.lean === 'function' ? sorted.lean() : sorted
  )
  return (records || []).map(record => ({
    id: idToString(record._id ?? record.id),
    tokenPrefix: record.tokenPrefix,
    scopes: record.scopes || [],
    label: record.label,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt ?? null,
    lastUsedAt: record.lastUsedAt ?? null,
  }))
}

async function revokeToken(userId, tokenId) {
  return maybeExec(
    PersonalAccessToken.deleteOne({ _id: tokenId, user_id: userId })
  )
}

async function revokeAllForUser(userId) {
  return maybeExec(PersonalAccessToken.deleteMany({ user_id: userId }))
}

const methods = {
  createToken,
  verifyToken,
  listTokens,
  revokeToken,
  revokeAllForUser,
}

const TokenService = {
  ...methods,
  promises: methods,
  hashToken,
}

export { hashToken, makeToken }
export default TokenService
