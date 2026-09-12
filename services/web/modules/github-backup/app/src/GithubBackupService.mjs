import fs from 'node:fs/promises'
import Path from 'node:path'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import TokenService from '../../../project-sync/app/src/TokenService.mjs'
import VersionService from '../../../project-sync/app/src/VersionService.mjs'
import GithubBackupLink from './models/GithubBackupLink.mjs'
import GithubApi from './GithubApi.mjs'
import { createMirrorJob } from './MirrorJob.mjs'
import { encryptToken } from './TokenCipher.mjs'
import {
  BackupDisabledError,
  BackupNotLinkedError,
  GithubNoPushPermissionError,
  GithubRepoNotFoundError,
  InvalidBackupRequestError,
} from './Errors.mjs'

const BRIDGE_TOKEN_LABEL = 'GitHub backup (internal)'
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/

const mirrorJob = createMirrorJob({ VersionService })

function maybeExec(value) {
  return value && typeof value.exec === 'function' ? value.exec() : value
}

function assertEnabled() {
  if (!Settings.githubBackup?.enabled) throw new BackupDisabledError()
}

function reposDir() {
  return Settings.githubBackup?.reposDir || 'data/github-backup'
}

// A run is a fetch and a push, each bounded by the git timeout, so the lease
// must outlive both with a margin, or a slow push could be started twice.
function leaseDuration() {
  return 2 * (Settings.githubBackup?.gitTimeoutMs || 300000) + 60000
}

function normalizeBranch(branch) {
  const value = String(branch ?? '').trim() || 'main'
  if (!BRANCH_PATTERN.test(value) || value.includes('..')) {
    throw new InvalidBackupRequestError('invalid git branch name')
  }
  return value
}

function resolveRepository(options) {
  if (options.repository) return GithubApi.parseRepository(options.repository)
  if (options.owner && options.repo) {
    return GithubApi.parseRepository(`${options.owner}/${options.repo}`)
  }
  throw new InvalidBackupRequestError('a GitHub repository is required')
}

function serialize(link, extra = {}) {
  if (!link) return { linked: false, ...extra }
  return {
    linked: true,
    project_id: String(link.projectId),
    owner: link.owner,
    repo: link.repo,
    branch: link.branch,
    repoUrl: GithubApi.repoUrl(link.owner, link.repo),
    enabled: link.enabled !== false,
    status: link.status || 'idle',
    lastSyncedVersion: link.lastSyncedVersion ?? null,
    lastSyncedAt: link.lastSyncedAt ?? null,
    lastPushedCommit: link.lastPushedCommit ?? null,
    lastError: link.lastError
      ? {
          code: link.lastError.code,
          message: link.lastError.message,
          at: link.lastError.at ?? null,
        }
      : null,
    linkedBy: link.linkedBy ? String(link.linkedBy) : null,
    createdAt: link.createdAt ?? null,
    updatedAt: link.updatedAt ?? null,
    inProgress:
      link.leaseUntil != null &&
      new Date(link.leaseUntil).getTime() > Date.now(),
    ...extra,
  }
}

async function findLink(projectId) {
  return await maybeExec(GithubBackupLink.findOne({ projectId }))
}

async function validateGithubRepository(
  { owner, repo },
  token,
  createIfMissing
) {
  try {
    return await GithubApi.getRepository(owner, repo, token)
  } catch (error) {
    if (error.code === 'github_repo_not_found' && createIfMissing) {
      return await GithubApi.createRepository(owner, repo, token)
    }
    if (error.code === 'github_repo_not_found') {
      throw new GithubRepoNotFoundError(
        `GitHub has no repository ${owner}/${repo} that this token can see. Create it first, or tick "Create the repository".`
      )
    }
    throw error
  }
}

async function revokeBridgeToken(link) {
  if (!link?.bridgeTokenId) return
  try {
    await TokenService.promises.revokeToken(link.linkedBy, link.bridgeTokenId)
  } catch (error) {
    logger.warn(
      { err: error, projectId: String(link.projectId) },
      'could not revoke the internal github backup token'
    )
  }
}

async function removeMirror(projectId) {
  const directory = Path.join(reposDir(), `${projectId}.git`)
  try {
    await fs.rm(directory, { recursive: true, force: true })
  } catch (error) {
    logger.warn(
      { err: error, projectId },
      'could not remove the github backup mirror directory'
    )
  }
}

/**
 * Link a project to a GitHub repository and run the first backup.
 */
async function link(projectId, userId, options = {}) {
  assertEnabled()
  const repository = resolveRepository(options)
  const branch = normalizeBranch(options.branch)
  const githubToken = String(options.token ?? '').trim()
  if (!githubToken) {
    throw new InvalidBackupRequestError('a GitHub access token is required')
  }

  const remote = await validateGithubRepository(
    repository,
    githubToken,
    options.createIfMissing === true
  )
  if (!remote.canPush) throw new GithubNoPushPermissionError()

  const previous = await findLink(projectId)
  const { token: bridgeToken, record } =
    await TokenService.promises.createToken(userId, {
      label: BRIDGE_TOKEN_LABEL,
      scopes: ['git_bridge'],
    })

  const now = new Date()
  await maybeExec(
    GithubBackupLink.updateOne(
      { projectId },
      {
        $set: {
          projectId,
          linkedBy: userId,
          owner: remote.owner,
          repo: remote.repo,
          branch,
          githubTokenEncrypted: await encryptToken(githubToken),
          bridgeTokenEncrypted: await encryptToken(bridgeToken),
          bridgeTokenId: record._id,
          enabled: true,
          status: 'idle',
          lastError: null,
          leaseUntil: null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    )
  )
  // The previous internal token is no longer referenced by anything.
  if (previous) await revokeBridgeToken(previous)

  return await syncNow(projectId, { force: true })
}

async function unlink(projectId) {
  assertEnabled()
  const existing = await findLink(projectId)
  if (!existing) throw new BackupNotLinkedError()
  await revokeBridgeToken(existing)
  await removeMirror(String(projectId))
  await maybeExec(GithubBackupLink.deleteOne({ projectId }))
  return { linked: false, unlinked: true, project_id: String(projectId) }
}

async function getStatus(projectId) {
  assertEnabled()
  const existing = await findLink(projectId)
  return serialize(existing, existing ? {} : { project_id: String(projectId) })
}

/**
 * Run one backup, guarded by a Mongo lease so that the scheduler and a user
 * clicking "Back up now" cannot mirror the same project at the same time.
 */
async function syncNow(projectId, options = {}) {
  assertEnabled()
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + leaseDuration())
  const claimed = await maybeExec(
    GithubBackupLink.findOneAndUpdate(
      {
        projectId,
        enabled: true,
        $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
      },
      { $set: { leaseUntil, status: 'syncing', updatedAt: now } },
      // The document as it was before the claim: the mirror job compares its
      // last `ok` state with the current project version to skip an unchanged
      // project, and the claim has just overwritten `status` with `syncing`.
      { new: false }
    )
  )

  if (!claimed) {
    const existing = await findLink(projectId)
    if (!existing) throw new BackupNotLinkedError()
    return serialize(existing, { inProgress: true })
  }

  let patch
  try {
    const result = await mirrorJob.run(claimed, { force: options.force })
    patch = result.patch
  } finally {
    await maybeExec(
      GithubBackupLink.updateOne(
        { projectId },
        {
          $set: {
            ...(patch || { status: 'error' }),
            leaseUntil: null,
            updatedAt: new Date(),
          },
        }
      )
    )
  }
  return await getStatus(projectId)
}

async function listEnabledLinks() {
  const query = GithubBackupLink.find({ enabled: true })
  const lean = query && typeof query.lean === 'function' ? query.lean() : query
  return (await maybeExec(lean)) || []
}

async function projectExpired(projectId) {
  if (!Settings.githubBackup?.enabled) return
  try {
    await unlink(projectId)
  } catch (error) {
    if (error.code === 'backup_not_linked') return
    logger.warn(
      { err: error, projectId: String(projectId) },
      'could not remove the github backup link of an expired project'
    )
  }
}

const methods = {
  link,
  unlink,
  getStatus,
  syncNow,
  listEnabledLinks,
  projectExpired,
}

export { link, unlink, getStatus, syncNow, listEnabledLinks, projectExpired }
export default { ...methods, promises: methods }
