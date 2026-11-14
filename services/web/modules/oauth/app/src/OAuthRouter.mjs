import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { expressify } from '@overleaf/promise-utils'
import OAuthController from './OAuthController.mjs'

// /oauth/token/info belongs to project-sync (git-bridge); these paths do not
// overlap with it.
const PROTECTED_RESOURCE_PATHS = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
]
const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server'

const authorizeRateLimiter = new RateLimiter('oauth-authorize', {
  points: 30,
  duration: 60,
})

const tokenRateLimiter = new RateLimiter('oauth-token', {
  points: 60,
  duration: 60,
})

const metadataRateLimiter = new RateLimiter('oauth-metadata', {
  points: 120,
  duration: 60,
})

function apply(webRouter) {
  const requireLogin = AuthenticationController.requireLogin()
  const limitAuthorize = RateLimiterMiddleware.rateLimit(authorizeRateLimiter)

  webRouter.get(
    '/oauth/authorize',
    requireLogin,
    limitAuthorize,
    expressify(OAuthController.showAuthorize)
  )
  webRouter.post(
    '/oauth/authorize',
    requireLogin,
    limitAuthorize,
    expressify(OAuthController.decideAuthorize)
  )

  webRouter.get(
    '/user/oauth-clients',
    requireLogin,
    expressify(OAuthController.listClients)
  )
  webRouter.post(
    '/user/oauth-clients',
    requireLogin,
    expressify(OAuthController.createClient)
  )
  webRouter.delete(
    '/user/oauth-clients/:clientId',
    requireLogin,
    expressify(OAuthController.deleteClient)
  )
}

function applyNonCsrfRouter(_webRouter, _privateApiRouter, publicApiRouter) {
  const limitMetadata = RateLimiterMiddleware.rateLimit(metadataRateLimiter, {
    ipOnly: true,
  })
  const limitToken = RateLimiterMiddleware.rateLimit(tokenRateLimiter, {
    ipOnly: true,
  })

  for (const path of PROTECTED_RESOURCE_PATHS) {
    publicApiRouter.options(path, OAuthController.preflight)
    publicApiRouter.get(
      path,
      limitMetadata,
      OAuthController.protectedResourceMetadata
    )
  }
  publicApiRouter.options(AUTHORIZATION_SERVER_PATH, OAuthController.preflight)
  publicApiRouter.get(
    AUTHORIZATION_SERVER_PATH,
    limitMetadata,
    OAuthController.authorizationServerMetadata
  )

  publicApiRouter.options('/oauth/token', OAuthController.preflight)
  publicApiRouter.post(
    '/oauth/token',
    limitToken,
    expressify(OAuthController.token)
  )
  publicApiRouter.options('/oauth/revoke', OAuthController.preflight)
  publicApiRouter.post(
    '/oauth/revoke',
    limitToken,
    expressify(OAuthController.revoke)
  )
}

export default { apply, applyNonCsrfRouter }
