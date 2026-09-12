import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { expressify } from '@overleaf/promise-utils'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import GithubBackupService from './GithubBackupService.mjs'

const STATUS_BY_CODE = {
  backup_disabled: 404,
  backup_not_linked: 404,
  github_repo_not_found: 404,
  github_no_push_permission: 403,
  invalid_repository: 400,
  invalid_request: 400,
  github_auth_failed: 400,
  github_api_error: 502,
}

function sendError(res, error) {
  const code = error?.code || 'backup_failed'
  const status = STATUS_BY_CODE[code] || 500
  if (status >= 500) {
    logger.warn({ err: error }, 'github backup request failed')
  }
  const body = { code, message: error?.message || 'GitHub backup failed' }
  if (error?.status) body.details = { githubStatus: error.status }
  return res.status(status).json(body)
}

function requireEnabled(req, res, next) {
  if (Settings.githubBackup?.enabled) return next()
  return res.status(404).json({
    code: 'backup_disabled',
    message: 'GitHub backup is not enabled on this server',
  })
}

function handle(action) {
  return expressify(async (req, res) => {
    try {
      const body = await action(req)
      return res.json(body)
    } catch (error) {
      return sendError(res, error)
    }
  })
}

const getBackupStatus = handle(req =>
  GithubBackupService.promises.getStatus(req.params.Project_id)
)

const linkBackup = handle(req => {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { repository, branch, token, createIfMissing } = req.body || {}
  return GithubBackupService.promises.link(req.params.Project_id, userId, {
    repository,
    branch,
    token,
    createIfMissing: createIfMissing === true,
  })
})

const unlinkBackup = handle(req =>
  GithubBackupService.promises.unlink(req.params.Project_id)
)

const syncBackup = handle(req =>
  GithubBackupService.promises.syncNow(req.params.Project_id, { force: true })
)

function apply(webRouter) {
  webRouter.get(
    '/project/:Project_id/github-backup',
    requireEnabled,
    AuthorizationMiddleware.ensureUserCanReadProject,
    getBackupStatus
  )
  webRouter.post(
    '/project/:Project_id/github-backup',
    requireEnabled,
    AuthorizationMiddleware.ensureUserCanAdminProject,
    linkBackup
  )
  webRouter.delete(
    '/project/:Project_id/github-backup',
    requireEnabled,
    AuthorizationMiddleware.ensureUserCanAdminProject,
    unlinkBackup
  )
  webRouter.post(
    '/project/:Project_id/github-backup/sync',
    requireEnabled,
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    syncBackup
  )
}

export { apply, requireEnabled, sendError }
export default { apply }
