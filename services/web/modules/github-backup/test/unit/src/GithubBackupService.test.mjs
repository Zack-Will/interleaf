import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

const PROJECT_ID = '68c1f9a3e4b0c2d1a5f6e7b8'
const USER_ID = '5f6e7b868c1f9a3e4b0c2d1a'
const GITHUB_TOKEN = 'github_pat_11ABCDEFG0123456789abcdef'
const BRIDGE_TOKEN = 'olp_AbCdEfGhIjKlMnOp'
const CIPHER_PASSWORD = 'github-backup-unit-test-cipher-password'

// A stand-in for the Mongoose model holding at most one link, which is all a
// single-project test needs. It implements only the query shapes the service
// actually uses.
function createLinkModel(initial = null) {
  const state = { doc: initial }

  function leaseIsFree(doc, query) {
    if (!query.$or) return true
    return doc.leaseUntil == null || new Date(doc.leaseUntil) <= new Date()
  }

  function selects(query) {
    const doc = state.doc
    if (!doc) return false
    if (String(doc.projectId) !== String(query.projectId)) return false
    if (query.enabled != null && doc.enabled !== query.enabled) return false
    return leaseIsFree(doc, query)
  }

  function applyUpdate(update) {
    Object.assign(state.doc, update.$set || {})
  }

  return {
    state,
    async findOne(query) {
      return state.doc &&
        String(state.doc.projectId) === String(query.projectId)
        ? state.doc
        : null
    },
    async findOneAndUpdate(query, update) {
      if (!selects(query)) return null
      applyUpdate(update)
      return state.doc
    },
    async updateOne(query, update, options = {}) {
      if (!state.doc && options.upsert) {
        state.doc = { ...(update.$setOnInsert || {}) }
      }
      if (!state.doc) return { matchedCount: 0 }
      applyUpdate(update)
      return { matchedCount: 1 }
    },
    async deleteOne() {
      const deleted = state.doc ? 1 : 0
      state.doc = null
      return { deletedCount: deleted }
    },
    find() {
      return {
        lean: async () => (state.doc ? [state.doc] : []),
      }
    },
  }
}

function githubRepoBody(overrides = {}) {
  return {
    name: 'thesis-backup',
    owner: { login: 'octocat' },
    private: true,
    default_branch: 'main',
    permissions: { push: true, pull: true, admin: true },
    ...overrides,
  }
}

// vitest's `expect(...).rejects` is shadowed by chai-as-promised in this
// repository's unit bootstrap, so rejections are inspected directly.
async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the call to be rejected')
}

async function exists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

async function loadService(ctx, overrides = {}) {
  vi.resetModules()
  ctx.reposDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'gh-backup-test-'))
  ctx.model = overrides.model || createLinkModel(overrides.initialLink ?? null)
  ctx.createToken = sinon.stub().resolves({
    token: BRIDGE_TOKEN,
    record: { _id: 'bridge-token-id' },
  })
  ctx.revokeToken = sinon.stub().resolves({ deletedCount: 1 })
  ctx.mirrorRun =
    overrides.mirrorRun ||
    sinon.stub().resolves({
      skipped: false,
      version: 7,
      patch: {
        status: 'ok',
        lastSyncedVersion: 7,
        lastSyncedAt: new Date('2026-09-13T00:00:00.000Z'),
        lastPushedCommit: 'a'.repeat(40),
        lastError: null,
      },
    })

  vi.doMock('@overleaf/settings', () => ({
    default: {
      githubBackup: {
        enabled: overrides.enabled ?? true,
        reposDir: ctx.reposDir,
        gitTimeoutMs: 1000,
        apiBaseUrl: 'https://api.github.test',
        accessTokenEncryptor: {
          cipherLabel: '2026.1-v3',
          cipherPasswords: { '2026.1-v3': CIPHER_PASSWORD },
        },
      },
      apis: { gitBridge: { url: 'http://git-bridge:8000' } },
    },
  }))
  vi.doMock('@overleaf/logger', () => ({
    default: { warn: sinon.stub(), debug: sinon.stub(), error: sinon.stub() },
  }))
  vi.doMock('../../../app/src/models/GithubBackupLink.mjs', () => ({
    default: ctx.model,
    GithubBackupLink: ctx.model,
  }))
  vi.doMock('../../../../project-sync/app/src/TokenService.mjs', () => ({
    default: {
      promises: { createToken: ctx.createToken, revokeToken: ctx.revokeToken },
    },
  }))
  vi.doMock('../../../../project-sync/app/src/VersionService.mjs', () => ({
    default: {
      promises: { getLatestVersion: sinon.stub().resolves({ version: 7 }) },
    },
  }))
  vi.doMock('../../../app/src/MirrorJob.mjs', () => ({
    createMirrorJob: () => ({ run: ctx.mirrorRun }),
  }))

  return await import('../../../app/src/GithubBackupService.mjs')
}

describe('GithubBackupService', () => {
  afterEach(async ctx => {
    vi.unstubAllGlobals()
    if (ctx.reposDir)
      await fs.rm(ctx.reposDir, { recursive: true, force: true })
  })

  describe('link', () => {
    it('validates the repository, mints an internal token and syncs once', async ctx => {
      const service = await loadService(ctx)
      const fetchStub = sinon
        .stub()
        .resolves(jsonResponse(200, githubRepoBody()))
      vi.stubGlobal('fetch', fetchStub)

      const status = await service.link(PROJECT_ID, USER_ID, {
        repository: 'https://github.com/octocat/thesis-backup.git',
        branch: 'main',
        token: GITHUB_TOKEN,
      })

      const [url, options] = fetchStub.firstCall.args
      expect(url).toEqual('https://api.github.test/repos/octocat/thesis-backup')
      expect(options.headers.Authorization).toEqual(`Bearer ${GITHUB_TOKEN}`)
      expect(options.headers['X-GitHub-Api-Version']).toEqual('2022-11-28')
      expect(options.headers['User-Agent']).toBeTruthy()

      sinon.assert.calledOnce(ctx.createToken)
      expect(ctx.createToken.firstCall.args[1].scopes).toEqual(['git_bridge'])
      sinon.assert.calledOnce(ctx.mirrorRun)

      expect(status.linked).toEqual(true)
      expect(status.owner).toEqual('octocat')
      expect(status.repo).toEqual('thesis-backup')
      expect(status.branch).toEqual('main')
      expect(status.repoUrl).toEqual('https://github.com/octocat/thesis-backup')
      expect(status.status).toEqual('ok')
      expect(status.lastSyncedVersion).toEqual(7)
      expect(status.inProgress).toEqual(false)
    })

    it('never stores either token in the clear', async ctx => {
      const service = await loadService(ctx)
      vi.stubGlobal(
        'fetch',
        sinon.stub().resolves(jsonResponse(200, githubRepoBody()))
      )

      await service.link(PROJECT_ID, USER_ID, {
        repository: 'octocat/thesis-backup',
        token: GITHUB_TOKEN,
      })

      const stored = JSON.stringify(ctx.model.state.doc)
      expect(stored).not.toContain(GITHUB_TOKEN)
      expect(stored).not.toContain(BRIDGE_TOKEN)
      expect(ctx.model.state.doc.githubTokenEncrypted).toMatch(/^2026\.1-v3:/)
      expect(ctx.model.state.doc.bridgeTokenEncrypted).toMatch(/^2026\.1-v3:/)
    })

    it('creates the repository when it is missing and the caller asked for it', async ctx => {
      const service = await loadService(ctx)
      const fetchStub = sinon.stub()
      fetchStub
        .onFirstCall()
        .resolves(jsonResponse(404, { message: 'Not Found' }))
      fetchStub.onSecondCall().resolves(jsonResponse(201, githubRepoBody()))
      vi.stubGlobal('fetch', fetchStub)

      const status = await service.link(PROJECT_ID, USER_ID, {
        repository: 'octocat/thesis-backup',
        token: GITHUB_TOKEN,
        createIfMissing: true,
      })

      const [url, options] = fetchStub.secondCall.args
      expect(url).toEqual('https://api.github.test/user/repos')
      expect(options.method).toEqual('POST')
      expect(JSON.parse(options.body)).toEqual({
        name: 'thesis-backup',
        private: true,
        auto_init: false,
      })
      expect(status.status).toEqual('ok')
    })

    it('reports a missing repository when it may not create one', async ctx => {
      const service = await loadService(ctx)
      vi.stubGlobal(
        'fetch',
        sinon.stub().resolves(jsonResponse(404, { message: 'Not Found' }))
      )

      const error = await rejection(
        service.link(PROJECT_ID, USER_ID, {
          repository: 'octocat/thesis-backup',
          token: GITHUB_TOKEN,
        })
      )
      expect(error.code).toEqual('github_repo_not_found')
      sinon.assert.notCalled(ctx.createToken)
    })

    it('refuses a token that cannot push', async ctx => {
      const service = await loadService(ctx)
      vi.stubGlobal(
        'fetch',
        sinon
          .stub()
          .resolves(
            jsonResponse(200, githubRepoBody({ permissions: { push: false } }))
          )
      )

      const error = await rejection(
        service.link(PROJECT_ID, USER_ID, {
          repository: 'octocat/thesis-backup',
          token: GITHUB_TOKEN,
        })
      )
      expect(error.code).toEqual('github_no_push_permission')
      sinon.assert.notCalled(ctx.createToken)
    })

    it('reports a bad token as an authentication failure', async ctx => {
      const service = await loadService(ctx)
      vi.stubGlobal(
        'fetch',
        sinon.stub().resolves(jsonResponse(401, { message: 'Bad credentials' }))
      )

      const error = await rejection(
        service.link(PROJECT_ID, USER_ID, {
          repository: 'octocat/thesis-backup',
          token: GITHUB_TOKEN,
        })
      )
      expect(error.code).toEqual('github_auth_failed')
    })

    it('rejects a repository reference that is not owner/repo', async ctx => {
      const service = await loadService(ctx)
      vi.stubGlobal('fetch', sinon.stub())

      const error = await rejection(
        service.link(PROJECT_ID, USER_ID, {
          repository: 'not-a-repository',
          token: GITHUB_TOKEN,
        })
      )
      expect(error.code).toEqual('invalid_repository')
    })
  })

  describe('unlink', () => {
    it('revokes the internal token, deletes the mirror and drops the link', async ctx => {
      const service = await loadService(ctx, {
        initialLink: {
          projectId: PROJECT_ID,
          linkedBy: USER_ID,
          owner: 'octocat',
          repo: 'thesis-backup',
          branch: 'main',
          bridgeTokenId: 'bridge-token-id',
          enabled: true,
          status: 'ok',
        },
      })
      const mirror = Path.join(ctx.reposDir, `${PROJECT_ID}.git`)
      await fs.mkdir(mirror, { recursive: true })

      const result = await service.unlink(PROJECT_ID)

      expect(result.unlinked).toEqual(true)
      sinon.assert.calledWith(ctx.revokeToken, USER_ID, 'bridge-token-id')
      expect(ctx.model.state.doc).toEqual(null)
      expect(await exists(mirror)).toEqual(false)
    })

    it('reports a project that is not linked', async ctx => {
      const service = await loadService(ctx)
      const error = await rejection(service.unlink(PROJECT_ID))
      expect(error.code).toEqual('backup_not_linked')
    })
  })

  describe('getStatus', () => {
    it('says so when the project has no backup', async ctx => {
      const service = await loadService(ctx)
      expect(await service.getStatus(PROJECT_ID)).toMatchObject({
        linked: false,
      })
    })

    it('refuses every call when the feature is disabled', async ctx => {
      const service = await loadService(ctx, { enabled: false })
      const error = await rejection(service.getStatus(PROJECT_ID))
      expect(error.code).toEqual('backup_disabled')
    })
  })

  describe('syncNow', () => {
    it('reports the running sync instead of starting a second one', async ctx => {
      const service = await loadService(ctx, {
        initialLink: {
          projectId: PROJECT_ID,
          linkedBy: USER_ID,
          owner: 'octocat',
          repo: 'thesis-backup',
          branch: 'main',
          enabled: true,
          status: 'syncing',
          leaseUntil: new Date(Date.now() + 60000),
        },
      })

      const status = await service.syncNow(PROJECT_ID)

      expect(status.inProgress).toEqual(true)
      expect(status.status).toEqual('syncing')
      sinon.assert.notCalled(ctx.mirrorRun)
    })

    it('takes an expired lease and releases it afterwards', async ctx => {
      const service = await loadService(ctx, {
        initialLink: {
          projectId: PROJECT_ID,
          linkedBy: USER_ID,
          owner: 'octocat',
          repo: 'thesis-backup',
          branch: 'main',
          enabled: true,
          status: 'error',
          leaseUntil: new Date(Date.now() - 60000),
        },
      })

      const status = await service.syncNow(PROJECT_ID)

      sinon.assert.calledOnce(ctx.mirrorRun)
      expect(status.status).toEqual('ok')
      expect(status.inProgress).toEqual(false)
      expect(ctx.model.state.doc.leaseUntil).toEqual(null)
    })

    it('releases the lease when the mirror job blows up', async ctx => {
      const service = await loadService(ctx, {
        mirrorRun: sinon.stub().rejects(new Error('git exploded')),
        initialLink: {
          projectId: PROJECT_ID,
          linkedBy: USER_ID,
          owner: 'octocat',
          repo: 'thesis-backup',
          branch: 'main',
          enabled: true,
          status: 'ok',
          leaseUntil: null,
        },
      })

      const error = await rejection(service.syncNow(PROJECT_ID))
      expect(error.message).toEqual('git exploded')
      expect(ctx.model.state.doc.leaseUntil).toEqual(null)
      expect(ctx.model.state.doc.status).toEqual('error')
    })
  })

  describe('projectExpired', () => {
    it('unlinks the project', async ctx => {
      const service = await loadService(ctx, {
        initialLink: {
          projectId: PROJECT_ID,
          linkedBy: USER_ID,
          owner: 'octocat',
          repo: 'thesis-backup',
          branch: 'main',
          bridgeTokenId: 'bridge-token-id',
          enabled: true,
          status: 'ok',
        },
      })

      await service.projectExpired(PROJECT_ID)

      expect(ctx.model.state.doc).toEqual(null)
      sinon.assert.calledOnce(ctx.revokeToken)
    })

    it('does nothing for a project that was never linked', async ctx => {
      const service = await loadService(ctx)
      expect(await service.projectExpired(PROJECT_ID)).toEqual(undefined)
    })
  })

  describe('listEnabledLinks', () => {
    it('returns the links the scheduler should walk', async ctx => {
      const service = await loadService(ctx, {
        initialLink: { projectId: PROJECT_ID, enabled: true },
      })
      const links = await service.listEnabledLinks()
      expect(links).toHaveLength(1)
    })
  })
})
