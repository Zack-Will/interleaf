import Settings from '@overleaf/settings'
import GithubBackupRouter from './app/src/GithubBackupRouter.mjs'
import GithubBackupService from './app/src/GithubBackupService.mjs'
import Scheduler from './app/src/Scheduler.mjs'

async function start() {
  if (!Settings.githubBackup?.enabled) return
  Scheduler.start()
}

/** @import { WebModule } from '../../types/web-module' */

/** @type {WebModule} */
const GithubBackupModule = {
  dependencies: ['project-sync'],
  router: {
    apply: GithubBackupRouter.apply,
  },
  hooks: {
    promises: {
      // `projectExpired` is the only project-deletion hook web fires. A project
      // that is gone must not keep a GitHub token or a local mirror around.
      projectExpired(projectId) {
        return GithubBackupService.promises.projectExpired(String(projectId))
      },
    },
  },
  start,
}

export default GithubBackupModule
