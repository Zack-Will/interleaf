import OAuthRouter from './app/src/OAuthRouter.mjs'
import OAuthService from './app/src/OAuthService.mjs'

/** @import { WebModule } from '../../types/web-module' */

/** @type {WebModule} */
const OAuthModule = {
  router: {
    apply: OAuthRouter.apply,
  },
  nonCsrfRouter: {
    apply: OAuthRouter.applyNonCsrfRouter,
  },
  hooks: {
    promises: {
      // Fired by UserDeleter alongside project-sync's hook of the same name,
      // which removes the access tokens themselves.
      cleanupPersonalAccessTokens(userId) {
        return OAuthService.promises.cleanupForUser(userId)
      },
    },
  },
}

export default OAuthModule
