import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sinon from 'sinon'
import { createMirrorJob } from '../../../app/src/MirrorJob.mjs'

const execFileAsync = promisify(execFile)

const PROJECT_ID = '68c1f9a3e4b0c2d1a5f6e7b8'
const BRIDGE_TOKEN = 'olp_AbCdEfGhIjKlMnOp'
const GITHUB_TOKEN = 'github_pat_11ABCDEFG0123456789abcdef'

// These tests drive real git against local repositories, so that the argument
// lists, the refspecs and the non-fast-forward detection are exercised for
// real rather than against a stub.
async function git(args, cwd) {
  return await execFileAsync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Overleaf',
      GIT_AUTHOR_EMAIL: 'overleaf@example.test',
      GIT_COMMITTER_NAME: 'Overleaf',
      GIT_COMMITTER_EMAIL: 'overleaf@example.test',
    },
  })
}

async function commit(workDir, name, content, message) {
  await fs.writeFile(Path.join(workDir, name), content)
  await git(['add', name], workDir)
  await git(['commit', '--quiet', '-m', message], workDir)
}

/** A bare repository standing in for the one git-bridge maintains. */
async function makeBridgeRepository(base) {
  const workDir = Path.join(base, 'bridge-work')
  await fs.mkdir(workDir, { recursive: true })
  await git(['init', '--quiet', '-b', 'master', '.'], workDir)
  await commit(workDir, 'main.tex', 'one\n', 'Initial version')
  await commit(workDir, 'main.tex', 'one\ntwo\n', 'Second version')
  const bare = Path.join(base, 'bridge', PROJECT_ID)
  await fs.mkdir(Path.dirname(bare), { recursive: true })
  await git(['clone', '--bare', '--quiet', workDir, bare])
  return bare
}

async function makeGithubRepository(base) {
  const bare = Path.join(base, 'github.git')
  await git(['init', '--bare', '--quiet', bare])
  return bare
}

async function refCommit(repository, ref) {
  const { stdout } = await git(['rev-parse', ref], repository)
  return stdout.trim()
}

function buildLink(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    owner: 'octocat',
    repo: 'thesis-backup',
    branch: 'main',
    githubTokenEncrypted: `enc:${GITHUB_TOKEN}`,
    bridgeTokenEncrypted: `enc:${BRIDGE_TOKEN}`,
    enabled: true,
    status: 'idle',
    lastSyncedVersion: null,
    ...overrides,
  }
}

describe('MirrorJob', () => {
  beforeEach(async ctx => {
    ctx.base = await fs.mkdtemp(Path.join(os.tmpdir(), 'gh-mirror-test-'))
    ctx.bridge = await makeBridgeRepository(ctx.base)
    ctx.github = await makeGithubRepository(ctx.base)
    ctx.version = 7
    ctx.settings = {
      githubBackup: {
        enabled: true,
        reposDir: Path.join(ctx.base, 'mirrors'),
        gitTimeoutMs: 60000,
      },
    }
    ctx.logger = {
      warn: sinon.stub(),
      debug: sinon.stub(),
      error: sinon.stub(),
    }
    ctx.makeJob = (overrides = {}) =>
      createMirrorJob({
        settings: ctx.settings,
        logger: ctx.logger,
        VersionService: {
          promises: {
            getLatestVersion: async () => ({ version: ctx.version }),
          },
        },
        // The stored tokens are opaque strings here: encryption has its own
        // test, and the job only has to pass them on unread.
        decryptToken: async value => String(value).replace(/^enc:/, ''),
        bridgeUrlFor: projectId => Path.join(ctx.base, 'bridge', projectId),
        githubUrlFor: () => ctx.github,
        ...overrides,
      })
  })

  afterEach(async ctx => {
    await fs.rm(ctx.base, { recursive: true, force: true })
  })

  it('fast-forwards the git-bridge history onto the GitHub branch', async ctx => {
    const result = await ctx.makeJob().run(buildLink())

    expect(result.skipped).toEqual(false)
    expect(result.patch.status).toEqual('ok')
    expect(result.patch.lastSyncedVersion).toEqual(7)
    expect(result.patch.lastError).toEqual(null)

    const pushed = await refCommit(ctx.github, 'refs/heads/main')
    expect(result.patch.lastPushedCommit).toEqual(pushed)
    expect(await refCommit(ctx.bridge, 'refs/heads/master')).toEqual(pushed)
  })

  it('pushes later Overleaf versions onto the same branch', async ctx => {
    const job = ctx.makeJob()
    const first = await job.run(buildLink())

    const workDir = Path.join(ctx.base, 'bridge-work')
    await commit(workDir, 'main.tex', 'one\ntwo\nthree\n', 'Third version')
    await git(['push', '--quiet', ctx.bridge, 'master'], workDir)

    ctx.version = 8
    const second = await job.run(
      buildLink({ status: 'ok', lastSyncedVersion: 7 })
    )

    expect(second.patch.status).toEqual('ok')
    expect(second.patch.lastSyncedVersion).toEqual(8)
    expect(second.patch.lastPushedCommit).not.toEqual(
      first.patch.lastPushedCommit
    )
    expect(await refCommit(ctx.github, 'refs/heads/main')).toEqual(
      second.patch.lastPushedCommit
    )
  })

  it('reports diverged when GitHub has commits Overleaf does not have', async ctx => {
    const job = ctx.makeJob()
    await job.run(buildLink())

    // Somebody commits straight to GitHub.
    const clone = Path.join(ctx.base, 'github-work')
    await git(['clone', '--quiet', '--branch', 'main', ctx.github, clone])
    await commit(clone, 'notes.md', 'edited on GitHub\n', 'Direct commit')
    await git(['push', '--quiet', 'origin', 'main'], clone)
    const githubHead = await refCommit(ctx.github, 'refs/heads/main')

    const result = await job.run(
      buildLink({ status: 'ok', lastSyncedVersion: 7 }),
      { force: true }
    )

    expect(result.patch.status).toEqual('diverged')
    expect(result.patch.lastError.code).toEqual('diverged')
    expect(result.patch.lastError.message).toContain(
      'commits that Overleaf does not have'
    )
    // Nothing was overwritten.
    expect(await refCommit(ctx.github, 'refs/heads/main')).toEqual(githubHead)
  })

  it('skips the work when the project has not changed since the last backup', async ctx => {
    const job = ctx.makeJob()
    await job.run(buildLink())

    const result = await job.run(
      buildLink({ status: 'ok', lastSyncedVersion: 7 })
    )

    expect(result.skipped).toEqual(true)
    expect(result.patch).toEqual({ status: 'ok' })
  })

  it('backs up again when forced even though the version is unchanged', async ctx => {
    const job = ctx.makeJob()
    await job.run(buildLink())

    const result = await job.run(
      buildLink({ status: 'ok', lastSyncedVersion: 7 }),
      { force: true }
    )

    expect(result.skipped).toEqual(false)
    expect(result.patch.status).toEqual('ok')
  })

  it('records a readable error when git-bridge cannot be read', async ctx => {
    const job = ctx.makeJob({
      bridgeUrlFor: () => Path.join(ctx.base, 'no-such-repository'),
    })

    const result = await job.run(buildLink())

    expect(result.patch.status).toEqual('error')
    expect(result.patch.lastError.code).toEqual('git_fetch_failed')
    expect(result.patch.lastError.message.length).toBeLessThanOrEqual(500)
  })

  it('never writes a token into the stored error message', async ctx => {
    // A failing remote whose path carries both tokens: whatever git echoes back
    // must come out redacted.
    const job = ctx.makeJob({
      bridgeUrlFor: () =>
        Path.join(ctx.base, `missing-${BRIDGE_TOKEN}-${GITHUB_TOKEN}`),
    })

    const result = await job.run(buildLink())

    const message = result.patch.lastError.message
    expect(message).not.toContain(BRIDGE_TOKEN)
    expect(message).not.toContain(GITHUB_TOKEN)
    expect(message).toContain('[redacted]')
  })

  it('reports an empty history instead of pushing nothing', async ctx => {
    const empty = Path.join(ctx.base, 'bridge', 'empty')
    await git(['init', '--bare', '--quiet', empty])
    const job = ctx.makeJob({ bridgeUrlFor: () => empty })

    const result = await job.run(buildLink())

    expect(result.patch.status).toEqual('error')
    expect(result.patch.lastError.code).toEqual('empty_history')
  })
})
