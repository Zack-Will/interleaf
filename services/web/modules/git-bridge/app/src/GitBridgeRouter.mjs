import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { expressify } from '@overleaf/promise-utils'
import { fetchStream, fetchNothing } from '@overleaf/fetch-utils'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import SafePath from '../../../../app/src/Features/Project/SafePath.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import ProjectRef from '../../../project-sync/app/src/ProjectRef.mjs'
import VersionService from '../../../project-sync/app/src/VersionService.mjs'
import SnapshotService from '../../../project-sync/app/src/SnapshotService.mjs'
import LabelService from '../../../project-sync/app/src/LabelService.mjs'
import WriteService from '../../../project-sync/app/src/WriteService.mjs'
import { requireAccessToken } from '../../../project-sync/app/src/TokenAuthMiddleware.mjs'
import { createHandlers } from './GitBridgeController.mjs'

const apiRateLimiter = new RateLimiter('git-bridge-api', {
  points: 120,
  duration: 60,
})

const blobRateLimiter = new RateLimiter('git-bridge-blob', {
  points: 120,
  duration: 60,
})

function createDefaultServices() {
  return {
    ProjectRef,
    VersionService,
    SnapshotService,
    LabelService,
    WriteService,
    UserGetter,
    HistoryManager,
    SafePath,
    fetchStream,
    fetchNothing,
    settings: Settings,
    logger,
  }
}

function apply(_webRouter, _privateApiRouter, publicApiRouter) {
  if (!Settings.enableGitBridge) {
    logger.debug({}, 'git-bridge module is disabled, not registering routes')
    return
  }

  const handlers = createHandlers(createDefaultServices())
  const authenticate = requireAccessToken('git_bridge')
  const rateLimit = RateLimiterMiddleware.rateLimit(apiRateLimiter, {
    getUserId: req => req.syncUser?.userId,
  })

  publicApiRouter.get(
    '/api/v0/docs/:projectId',
    authenticate,
    rateLimit,
    expressify(handlers.getDoc)
  )
  publicApiRouter.get(
    '/api/v0/docs/:projectId/saved_vers',
    authenticate,
    rateLimit,
    expressify(handlers.getSavedVers)
  )
  publicApiRouter.get(
    '/api/v0/docs/:projectId/snapshots/:version',
    authenticate,
    rateLimit,
    expressify(handlers.getSnapshot)
  )
  publicApiRouter.post(
    '/api/v0/docs/:projectId/snapshots',
    authenticate,
    rateLimit,
    expressify(handlers.postSnapshot)
  )
  // git-bridge fetches attachments without an Authorization header, so this
  // route authenticates on the signed query string alone.
  publicApiRouter.get(
    '/api/v0/docs/:projectId/blobs/:hash',
    RateLimiterMiddleware.rateLimit(blobRateLimiter, { ipOnly: true }),
    expressify(handlers.getBlob)
  )
}

export { apply, createDefaultServices }
export default { apply, createDefaultServices }
