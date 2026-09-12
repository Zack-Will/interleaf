import ProjectSyncRouter from './app/src/ProjectSyncRouter.mjs'
import TokenService from './app/src/TokenService.mjs'

/** @import { WebModule } from '../../types/web-module' */

/** @type {WebModule} */
const ProjectSyncModule = {
  router: {
    apply: ProjectSyncRouter.apply,
  },
  nonCsrfRouter: {
    apply: ProjectSyncRouter.applyNonCsrfRouter,
  },
  hooks: {
    promises: {
      listPersonalAccessTokens(userId) {
        return TokenService.promises.listTokens(userId)
      },
      cleanupPersonalAccessTokens(userId) {
        return TokenService.promises.revokeAllForUser(userId)
      },
    },
  },
}

export default ProjectSyncModule
