import fs from 'node:fs/promises'
import Path from 'node:path'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import GithubApi from './GithubApi.mjs'
import { runGit, scrubSecrets } from './GitCommands.mjs'
import { decryptToken } from './TokenCipher.mjs'

const REMOTE_NAMESPACE = 'refs/remotes/overleaf'
const MAX_ERROR_LENGTH = 500

// git-bridge names the branch it builds `master`. That is not promised
// anywhere, so the branch is discovered and these are only the preferences.
const PREFERRED_SOURCE_BRANCHES = ['master', 'main']

const DIVERGED_MESSAGE =
  'GitHub has commits that Overleaf does not have, so the backup cannot fast-forward. ' +
  'Overleaf never overwrites the repository. Either push those commits somewhere else and ' +
  'reset the branch to the Overleaf history, or back up to a different branch. ' +
  'Pulling GitHub commits back into Overleaf is not supported yet.'

function isNonFastForward(stderr) {
  return (
    /\[rejected\]/.test(stderr) ||
    /non-fast-forward/.test(stderr) ||
    /fetch first/.test(stderr) ||
    /Updates were rejected/.test(stderr)
  )
}

function isAuthFailure(stderr) {
  return (
    /Authentication failed/i.test(stderr) ||
    /could not read Username/i.test(stderr) ||
    /Invalid username or password/i.test(stderr) ||
    /Repository not found/i.test(stderr) ||
    /Write access to repository not granted/i.test(stderr) ||
    /The requested URL returned error: 40[13]/.test(stderr) ||
    /terminal prompts disabled/i.test(stderr)
  )
}

function truncate(message) {
  const text = String(message ?? '').trim()
  if (text.length <= MAX_ERROR_LENGTH) return text
  return `${text.slice(0, MAX_ERROR_LENGTH - 1)}…`
}

function errorPatch(code, message, secrets) {
  return {
    status: code === 'diverged' ? 'diverged' : 'error',
    lastError: {
      code,
      message: truncate(scrubSecrets(message, secrets)),
      at: new Date(),
    },
  }
}

// `VersionService` is deliberately not a default: importing it pulls in
// document-updater and project-history, which the mirror tests do not need.
// `GithubBackupService` injects the real one.
function defaultServices() {
  return {
    runGit,
    decryptToken,
    settings: Settings,
    logger,
    bridgeUrlFor(projectId, services) {
      const base = services.settings.apis?.gitBridge?.url
      if (!base) {
        throw new Error('Settings.apis.gitBridge.url is not configured')
      }
      return `${String(base).replace(/\/+$/, '')}/${projectId}`
    },
    githubUrlFor(link) {
      return GithubApi.cloneUrl(link.owner, link.repo)
    },
  }
}

/**
 * The one-way mirror: fetch the project's git history from the git-bridge
 * container into a local bare repository, then fast-forward push it to GitHub.
 *
 * `run` never throws and never touches Mongo: it returns the fields the caller
 * should persist, so that it can be tested against real git repositories
 * without a database.
 */
function createMirrorJob(overrides = {}) {
  const services = { ...defaultServices(), ...overrides }

  function config() {
    const backup = services.settings.githubBackup || {}
    return {
      reposDir: backup.reposDir || 'data/github-backup',
      timeoutMs: backup.gitTimeoutMs || 300000,
    }
  }

  async function ensureBareRepository(projectId) {
    const { reposDir } = config()
    await fs.mkdir(reposDir, { recursive: true, mode: 0o700 })
    const repoDir = Path.join(reposDir, `${projectId}.git`)
    let initialised = true
    try {
      await fs.access(Path.join(repoDir, 'HEAD'))
    } catch {
      initialised = false
    }
    if (!initialised) {
      await fs.mkdir(repoDir, { recursive: true, mode: 0o700 })
      await services.runGit(['init', '--bare', '--quiet', repoDir], {
        timeoutMs: config().timeoutMs,
      })
    }
    return repoDir
  }

  async function fetchFromBridge(repoDir, link, bridgeToken) {
    const url = services.bridgeUrlFor(String(link.projectId), services)
    await services.runGit(
      [
        'fetch',
        '--prune',
        '--quiet',
        url,
        `+refs/heads/*:${REMOTE_NAMESPACE}/*`,
      ],
      {
        cwd: repoDir,
        timeoutMs: config().timeoutMs,
        credentials: { username: 'git', password: bridgeToken },
      }
    )
  }

  async function findSourceBranch(repoDir) {
    const { stdout } = await services.runGit(
      ['for-each-ref', '--format=%(refname)', REMOTE_NAMESPACE],
      { cwd: repoDir, timeoutMs: config().timeoutMs }
    )
    const branches = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(refname => refname.slice(`${REMOTE_NAMESPACE}/`.length))
      .sort()
    for (const preferred of PREFERRED_SOURCE_BRANCHES) {
      if (branches.includes(preferred)) return preferred
    }
    return branches[0] || null
  }

  async function pushToGithub(repoDir, link, source, githubToken) {
    const url = services.githubUrlFor(link, services)
    await services.runGit(
      ['push', url, `${REMOTE_NAMESPACE}/${source}:refs/heads/${link.branch}`],
      {
        cwd: repoDir,
        timeoutMs: config().timeoutMs,
        credentials: { username: 'x-access-token', password: githubToken },
      }
    )
  }

  async function headCommit(repoDir, source) {
    const { stdout } = await services.runGit(
      ['rev-parse', `${REMOTE_NAMESPACE}/${source}`],
      { cwd: repoDir, timeoutMs: config().timeoutMs }
    )
    return stdout.trim()
  }

  async function run(link, options = {}) {
    const force = options.force === true
    const projectId = String(link.projectId)
    const secrets = []
    try {
      const latest =
        await services.VersionService.promises.getLatestVersion(projectId)
      const version = latest?.version ?? null
      if (
        !force &&
        link.status === 'ok' &&
        version != null &&
        link.lastSyncedVersion === version
      ) {
        return { skipped: true, version, patch: { status: 'ok' } }
      }

      const bridgeToken = await services.decryptToken(link.bridgeTokenEncrypted)
      const githubToken = await services.decryptToken(link.githubTokenEncrypted)
      secrets.push(bridgeToken, githubToken)

      const repoDir = await ensureBareRepository(projectId)

      try {
        await fetchFromBridge(repoDir, link, bridgeToken)
      } catch (error) {
        const stderr = error.stderr || error.message
        const code = isAuthFailure(stderr)
          ? 'git_bridge_auth_failed'
          : 'git_fetch_failed'
        const message = isAuthFailure(stderr)
          ? `The internal git-bridge token was rejected. Disconnect and connect the repository again to mint a new one. ${stderr}`
          : `Could not read the project history from git-bridge. ${stderr}`
        return {
          skipped: false,
          version,
          patch: errorPatch(code, message, secrets),
        }
      }

      const source = await findSourceBranch(repoDir)
      if (!source) {
        return {
          skipped: false,
          version,
          patch: errorPatch(
            'empty_history',
            'git-bridge has not produced any branch for this project yet. Save a version in the editor and try again.',
            secrets
          ),
        }
      }

      try {
        await pushToGithub(repoDir, link, source, githubToken)
      } catch (error) {
        const stderr = error.stderr || error.message
        if (isNonFastForward(stderr)) {
          return {
            skipped: false,
            version,
            patch: errorPatch('diverged', DIVERGED_MESSAGE, secrets),
          }
        }
        if (isAuthFailure(stderr)) {
          return {
            skipped: false,
            version,
            patch: errorPatch(
              'github_auth_failed',
              `GitHub refused the push. Check that the token is still valid and grants "Contents: read and write" on this repository. ${stderr}`,
              secrets
            ),
          }
        }
        return {
          skipped: false,
          version,
          patch: errorPatch('git_push_failed', stderr, secrets),
        }
      }

      const commit = await headCommit(repoDir, source)
      return {
        skipped: false,
        version,
        patch: {
          status: 'ok',
          lastSyncedVersion: version,
          lastSyncedAt: new Date(),
          lastPushedCommit: commit,
          lastError: null,
        },
      }
    } catch (error) {
      services.logger.warn(
        { projectId, err: new Error(scrubSecrets(error.message, secrets)) },
        'github backup mirror failed'
      )
      return {
        skipped: false,
        version: null,
        patch: errorPatch(
          'backup_failed',
          error.stderr || error.message || String(error),
          secrets
        ),
      }
    }
  }

  return { run }
}

export { createMirrorJob, DIVERGED_MESSAGE }
export default { createMirrorJob, DIVERGED_MESSAGE }
