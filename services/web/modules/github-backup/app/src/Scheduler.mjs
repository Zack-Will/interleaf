import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import GithubBackupService from './GithubBackupService.mjs'

// Long enough for the web process to have finished booting and for git-bridge
// to be reachable before the first backup is attempted.
const FIRST_TICK_DELAY_MS = 60 * 1000

let timer = null
let running = false

async function tick(services = { GithubBackupService, logger }) {
  if (running) {
    services.logger.debug(
      {},
      'skipping github backup tick, the previous one is still running'
    )
    return
  }
  running = true
  try {
    const links = await services.GithubBackupService.listEnabledLinks()
    // Sequential on purpose: each sync shells out to git, and a busy server
    // should not fork one git process per linked project at once.
    for (const link of links) {
      const projectId = String(link.projectId)
      try {
        await services.GithubBackupService.syncNow(projectId)
      } catch (error) {
        services.logger.warn(
          { err: error, projectId },
          'scheduled github backup failed'
        )
      }
    }
  } catch (error) {
    services.logger.warn({ err: error }, 'github backup tick failed')
  } finally {
    running = false
  }
}

function start(settings = Settings) {
  if (!settings.githubBackup?.enabled) return null
  if (timer) return timer
  const intervalMs = (settings.githubBackup.intervalSeconds || 600) * 1000
  timer = setTimeout(() => {
    void tick()
    timer = setInterval(() => {
      void tick()
    }, intervalMs)
    timer.unref()
  }, FIRST_TICK_DELAY_MS)
  timer.unref()
  logger.debug({ intervalMs }, 'github backup scheduler started')
  return timer
}

function stop() {
  if (!timer) return
  clearTimeout(timer)
  clearInterval(timer)
  timer = null
}

export { start, stop, tick, FIRST_TICK_DELAY_MS }
export default { start, stop, tick }
