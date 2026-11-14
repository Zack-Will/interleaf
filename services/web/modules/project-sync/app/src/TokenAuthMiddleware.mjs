import basicAuth from 'basic-auth'

import TokenService from './TokenService.mjs'
import {
  InsufficientScopeError,
  TokenExpiredError,
  TokenInvalidError,
} from './Errors.mjs'

// With a resource metadata URL (RFC 9728) the challenge tells OAuth clients
// where to discover the authorization server.
function challenge(resourceMetadataUrl) {
  if (!resourceMetadataUrl) return 'Bearer realm="Overleaf"'
  return `Bearer realm="Overleaf", resource_metadata="${resourceMetadataUrl}"`
}

function respond(res, status, error, errorCode, options) {
  res.setHeader('WWW-Authenticate', challenge(options.resourceMetadataUrl))
  return res.status(status).json({ error, error_code: errorCode })
}

function getToken(req) {
  const authorization =
    (typeof req.get === 'function' ? req.get('authorization') : undefined) ??
    req.headers?.authorization
  if (typeof authorization !== 'string' || authorization.trim() === '') {
    return { errorCode: 'token_malformed' }
  }

  const bearerMatch = authorization.match(/^Bearer\s+(\S+)$/i)
  if (bearerMatch) return { token: bearerMatch[1] }

  if (/^Basic\s+/i.test(authorization)) {
    const credentials = basicAuth(req)
    if (!credentials || credentials.name !== 'git' || !credentials.pass) {
      return { errorCode: 'token_malformed' }
    }
    return { token: credentials.pass }
  }

  return { errorCode: 'token_malformed' }
}

/**
 * Require a project-sync personal access token with the given scope.
 * @param {string} scope
 * @param {{ resourceMetadataUrl?: string }} [options]
 * @returns {import('express').RequestHandler}
 */
export function requireAccessToken(scope, options = {}) {
  return async function requireAccessTokenMiddleware(req, res, next) {
    const parsed = getToken(req)
    if (parsed.errorCode) {
      return respond(res, 401, 'invalid_token', parsed.errorCode, options)
    }

    try {
      const result = await TokenService.promises.verifyToken(
        parsed.token,
        scope
      )
      req.syncUser = result
      return next()
    } catch (error) {
      if (
        error instanceof InsufficientScopeError ||
        error?.code === 'insufficient_scope'
      ) {
        return respond(
          res,
          403,
          'insufficient_scope',
          'insufficient_scope',
          options
        )
      }
      if (
        error instanceof TokenExpiredError ||
        error?.code === 'token_expired'
      ) {
        return respond(res, 401, 'invalid_token', 'token_expired', options)
      }
      if (
        error instanceof TokenInvalidError ||
        error?.code === 'token_invalid'
      ) {
        return respond(res, 401, 'invalid_token', 'token_invalid', options)
      }
      return next(error)
    }
  }
}

export default { requireAccessToken }
