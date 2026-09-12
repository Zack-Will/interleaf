import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import Validation from '../../../../app/src/infrastructure/Validation.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import TokenService from './TokenService.mjs'
import { requireAccessToken } from './TokenAuthMiddleware.mjs'
import { expressify } from '@overleaf/promise-utils'

const { z, parseReq } = Validation

const tokenCreateSchema = z.object({
  body: z.object({
    label: z.string().max(255).optional(),
    scopes: z
      .array(z.enum(['git_bridge', 'mcp']))
      .min(1)
      .optional()
      .default(['git_bridge']),
    expiresInDays: z.number().int().positive().optional(),
  }),
})

const tokenInfoRateLimiter = new RateLimiter('oauth-token-info', {
  points: 60,
  duration: 60,
})

function serializeToken(record) {
  return {
    id: record._id?.toString?.() ?? record.id?.toString?.() ?? record.id,
    tokenPrefix: record.tokenPrefix,
    scopes: record.scopes,
    label: record.label,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt ?? null,
    lastUsedAt: record.lastUsedAt ?? null,
  }
}

async function listPersonalAccessTokens(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const tokens = await TokenService.promises.listTokens(userId)
  return res.json(tokens)
}

async function createPersonalAccessToken(req, res) {
  const { body } = parseReq(req, tokenCreateSchema)
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { token, record } = await TokenService.promises.createToken(userId, body)
  return res.json({ token, ...serializeToken(record) })
}

async function revokePersonalAccessToken(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const result = await TokenService.promises.revokeToken(
    userId,
    req.params.tokenId
  )
  if (result.deletedCount === 0) {
    return res.sendStatus(404)
  }
  return res.sendStatus(204)
}

function apply(webRouter) {
  webRouter.get(
    '/user/personal_access_tokens',
    AuthenticationController.requireLogin(),
    expressify(listPersonalAccessTokens)
  )
  webRouter.post(
    '/user/personal_access_tokens',
    AuthenticationController.requireLogin(),
    expressify(createPersonalAccessToken)
  )
  webRouter.delete(
    '/user/personal_access_tokens/:tokenId',
    AuthenticationController.requireLogin(),
    expressify(revokePersonalAccessToken)
  )
}

function applyNonCsrfRouter(_webRouter, _privateApiRouter, publicApiRouter) {
  publicApiRouter.get(
    '/oauth/token/info',
    RateLimiterMiddleware.rateLimit(tokenInfoRateLimiter, { ipOnly: true }),
    requireAccessToken('git_bridge'),
    (_req, res) => res.json({})
  )
}

export default { apply, applyNonCsrfRouter }
