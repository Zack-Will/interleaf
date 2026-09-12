import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { fetchNothing } from '@overleaf/fetch-utils'
import GitBridgeRouter from './app/src/GitBridgeRouter.mjs'

const DELETE_TIMEOUT_MS = 30 * 1000

/**
 * Tell the Java git-bridge to drop its clone of a project. Best effort: a
 * failure here must never block project deletion.
 *
 * @param {string} projectId
 */
async function notifyProjectDeleted(projectId) {
  if (!Settings.enableGitBridge) return
  const base = Settings.apis?.gitBridge?.url
  if (!base) return
  const url = `${String(base).replace(/\/+$/, '')}/api/projects/${projectId}`
  try {
    await fetchNothing(url, {
      method: 'DELETE',
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    })
  } catch (error) {
    logger.warn(
      { err: error, projectId },
      'could not notify git-bridge of project deletion'
    )
  }
}

/** @import { WebModule } from '../../types/web-module' */

/** @type {WebModule} */
const GitBridgeModule = {
  dependencies: ['project-sync'],
  nonCsrfRouter: {
    apply: GitBridgeRouter.apply,
  },
  hooks: {
    promises: {
      // `projectExpired` is the only project-deletion hook web fires today. It
      // runs when a deleted project is hard-expired, which is the point at
      // which the git repository must go too.
      projectExpired(projectId) {
        return notifyProjectDeleted(String(projectId))
      },
    },
  },
}

export { notifyProjectDeleted }
export default GitBridgeModule
