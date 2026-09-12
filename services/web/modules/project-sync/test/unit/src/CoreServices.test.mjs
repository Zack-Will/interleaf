import { describe, it, expect, vi } from 'vitest'
import sinon from 'sinon'
describe('project-sync core services', () => {
  it('parses project ids and URLs', async () => {
    vi.resetModules()
    vi.doMock('@overleaf/settings', () => ({
      default: { siteUrl: 'https://ol' },
    }))
    const { default: ProjectRef } =
      await import('../../../app/src/ProjectRef.mjs')
    expect(ProjectRef.parse('68c1f9a3e4b0c2d1a5f6e7b8')).toEqual({
      projectId: '68c1f9a3e4b0c2d1a5f6e7b8',
    })
    expect(
      ProjectRef.parse('https://x/project/68c1f9a3e4b0c2d1a5f6e7b8/foo')
    ).toEqual({ projectId: '68c1f9a3e4b0c2d1a5f6e7b8' })
    expect(() => ProjectRef.parse('bad')).toThrow()
  })
  it('flushes document updater before history', async () => {
    vi.resetModules()
    const order = []
    vi.doMock('@overleaf/settings', () => ({
      default: { apis: { project_history: { url: 'http://history' } } },
    }))
    vi.doMock('@overleaf/fetch-utils', () => ({
      fetchJson: sinon.stub().callsFake(async () => {
        order.push('fetch')
        return { version: 3 }
      }),
    }))
    vi.doMock(
      '../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
      () => ({
        default: {
          promises: { flushProjectToMongo: async () => order.push('doc') },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/History/HistoryManager.mjs',
      () => ({
        default: { promises: { flushProject: async () => order.push('hist') } },
      })
    )
    const { default: VersionService } =
      await import('../../../app/src/VersionService.mjs')
    await VersionService.getLatestVersion('p')
    expect(order).toEqual(['doc', 'hist', 'fetch'])
  })
})

describe('WriteService', () => {
  it('rejects stale base versions before writing', async () => {
    vi.resetModules()
    const lock = { promises: { runWithLock: async (_n, _id, fn) => fn() } }
    vi.doMock('@overleaf/settings', () => ({
      default: { path: { dumpFolder: '/tmp' } },
    }))
    vi.doMock('../../../../../app/src/infrastructure/LockManager.mjs', () => ({
      default: lock,
    }))
    vi.doMock(
      '../../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs',
      () => ({
        default: {
          promises: { _mergeUpdate: sinon.stub(), deleteUpdate: sinon.stub() },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
      () => ({ default: { promises: { getAllEntities: sinon.stub() } } })
    )
    vi.doMock('../../../app/src/VersionService.mjs', () => ({
      default: {
        promises: { getLatestVersion: sinon.stub().resolves({ version: 4 }) },
      },
    }))
    vi.doMock('../../../app/src/LabelService.mjs', () => ({
      default: { promises: { createLabel: sinon.stub() } },
    }))
    const { default: WriteService } =
      await import('../../../app/src/WriteService.mjs')
    let error
    try {
      await WriteService.writeFiles('p', 'u', {
        baseVersion: 3,
        message: 'm',
        files: [],
      })
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({
      code: 'version_conflict',
      expectedVersion: 3,
      actualVersion: 4,
    })
  })
})

describe('WriteService.withProjectWriteLock', () => {
  const load = async ({ version }) => {
    vi.resetModules()
    const runWithLock = sinon.stub().callsFake((_name, _id, fn) => fn())
    vi.doMock('@overleaf/settings', () => ({
      default: { path: { dumpFolder: '/tmp' } },
    }))
    vi.doMock('../../../../../app/src/infrastructure/LockManager.mjs', () => ({
      default: { promises: { runWithLock } },
    }))
    vi.doMock(
      '../../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs',
      () => ({
        default: {
          promises: { _mergeUpdate: sinon.stub(), deleteUpdate: sinon.stub() },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
      () => ({ default: { promises: { getAllEntities: sinon.stub() } } })
    )
    vi.doMock('../../../app/src/VersionService.mjs', () => ({
      default: {
        promises: { getLatestVersion: sinon.stub().resolves({ version }) },
      },
    }))
    vi.doMock('../../../app/src/LabelService.mjs', () => ({
      default: { promises: { createLabel: sinon.stub() } },
    }))
    const { default: WriteService } =
      await import('../../../app/src/WriteService.mjs')
    return { WriteService, runWithLock }
  }

  it('runs the write under the project-sync lock and hands it the version', async () => {
    const { WriteService, runWithLock } = await load({ version: 4 })
    const result = await WriteService.withProjectWriteLock(
      'p',
      4,
      async current => `ran at ${current.version}`
    )
    expect(result).toBe('ran at 4')
    expect(runWithLock.firstCall.args.slice(0, 2)).toEqual([
      'project-sync',
      'p',
    ])
  })

  it('refuses a stale base version without running the write', async () => {
    const { WriteService } = await load({ version: 5 })
    const run = sinon.stub()
    const error = await WriteService.withProjectWriteLock('p', 3, run).catch(
      error => error
    )
    expect(error).toMatchObject({
      code: 'version_conflict',
      expectedVersion: 3,
      actualVersion: 5,
    })
    expect(run.called).toBe(false)
  })
})

describe('WriteService labels', () => {
  // A label is a milestone, so it is only created when the caller asks for
  // one.  Everything else about the write is unchanged.
  async function load() {
    vi.resetModules()
    const lock = { promises: { runWithLock: async (_n, _id, fn) => fn() } }
    const createLabel = sinon.stub().resolves({ _id: 'l1', comment: 'm' })
    vi.doMock('@overleaf/settings', () => ({
      default: { path: { dumpFolder: '/tmp' } },
    }))
    vi.doMock('../../../../../app/src/infrastructure/LockManager.mjs', () => ({
      default: lock,
    }))
    vi.doMock(
      '../../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs',
      () => ({
        default: {
          promises: { _mergeUpdate: sinon.stub(), deleteUpdate: sinon.stub() },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
      () => ({ default: { promises: { getAllEntities: sinon.stub() } } })
    )
    vi.doMock('../../../app/src/VersionService.mjs', () => ({
      default: {
        promises: { getLatestVersion: sinon.stub().resolves({ version: 4 }) },
      },
    }))
    vi.doMock('../../../app/src/LabelService.mjs', () => ({
      default: { promises: { createLabel } },
    }))
    const { default: WriteService } =
      await import('../../../app/src/WriteService.mjs')
    return { WriteService, createLabel }
  }

  const oneFile = [{ path: 'main.tex', content: 'hi' }]

  it('does not create a label when no files are applied', async () => {
    const { WriteService, createLabel } = await load()

    const result = await WriteService.writeFiles('p', 'u', {
      message: 'm',
      files: [],
    })

    expect(result).toEqual({
      version: 4,
      label: null,
      applied: [],
      failed: [],
      comments_affected: [],
    })
    expect(createLabel.called).toBe(false)
  })

  it('does not create a label for an ordinary write', async () => {
    const { WriteService, createLabel } = await load()

    const result = await WriteService.writeFiles('p', 'u', {
      message: 'Rewrite the abstract',
      files: oneFile,
    })

    expect(result.applied).toEqual(['main.tex'])
    expect(result.label).toBe(null)
    expect(createLabel.called).toBe(false)
  })

  it('creates one when the caller marks a milestone', async () => {
    const { WriteService, createLabel } = await load()

    const result = await WriteService.writeFiles('p', 'u', {
      message: 'Rewrite the abstract',
      files: oneFile,
      label: true,
    })

    expect(result.label).toEqual({ id: 'l1', comment: 'm' })
    expect(createLabel.firstCall.args).toEqual([
      'p',
      'u',
      4,
      'Rewrite the abstract',
    ])
  })

  it('keeps the message in the origin whether or not a label is made', async () => {
    const { WriteService } = await load()
    const { default: UpdateMerger } =
      await import('../../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs')

    await WriteService.writeFiles('p', 'u', {
      message: 'Rewrite the abstract',
      agent: 'Claude Code',
      files: oneFile,
    })

    expect(UpdateMerger.promises._mergeUpdate.firstCall.args[4]).toMatchObject({
      kind: 'mcp',
      agent: 'Claude Code',
      message: 'Rewrite the abstract',
    })
  })
})

describe('WriteService origin kind', () => {
  async function writeOneFile(options) {
    vi.resetModules()
    const mergeUpdate = sinon.stub()
    const lock = { promises: { runWithLock: async (_n, _id, fn) => fn() } }
    vi.doMock('@overleaf/settings', () => ({
      default: { path: { dumpFolder: '/tmp' } },
    }))
    vi.doMock('../../../../../app/src/infrastructure/LockManager.mjs', () => ({
      default: lock,
    }))
    vi.doMock(
      '../../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs',
      () => ({
        default: {
          promises: { _mergeUpdate: mergeUpdate, deleteUpdate: sinon.stub() },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
      () => ({ default: { promises: { getAllEntities: sinon.stub() } } })
    )
    vi.doMock('../../../app/src/VersionService.mjs', () => ({
      default: {
        promises: { getLatestVersion: sinon.stub().resolves({ version: 4 }) },
      },
    }))
    vi.doMock('../../../app/src/LabelService.mjs', () => ({
      default: {
        promises: { createLabel: sinon.stub().resolves({ id: 'l' }) },
      },
    }))
    const { default: WriteService } =
      await import('../../../app/src/WriteService.mjs')
    await WriteService.writeFiles('p', 'u', {
      message: 'm',
      files: [{ path: 'main.tex', content: 'hi' }],
      ...options,
    })
    return mergeUpdate.firstCall.args[4]
  }

  it('defaults to the mcp origin kind', async () => {
    const origin = await writeOneFile({})
    expect(origin.kind).toEqual('mcp')
  })

  it('records git pushes as a git-bridge origin', async () => {
    const origin = await writeOneFile({ originKind: 'git-bridge' })
    expect(origin.kind).toEqual('git-bridge')
  })
})

describe('SnapshotService hash resolution', () => {
  it('loads text blobs and exposes binary buffers', async () => {
    vi.resetModules()
    vi.doMock('@overleaf/settings', () => ({
      default: {
        max_doc_length: 100,
        apis: { project_history: { url: 'http://history' } },
      },
    }))
    vi.doMock('@overleaf/fetch-utils', () => ({
      fetchJson: vi.fn(async () => ({
        version: 2,
        files: {
          '/main.tex': { data: { hash: 'h1' } },
          '/image.png': { data: { hash: 'h2' } },
        },
      })),
    }))
    vi.doMock(
      '../../../../../app/src/Features/History/HistoryManager.mjs',
      () => ({
        default: {
          promises: {
            requestBlobWithProjectId: vi.fn(async (_id, hash) => ({
              stream: (async function* () {
                yield Buffer.from(hash === 'h1' ? 'hello' : '\\x00bin', 'utf8')
              })(),
              contentLength: 5,
            })),
          },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Uploads/FileTypeManager.mjs',
      () => ({
        default: {
          isEditable: content => content === '' || content === 'hello',
        },
      })
    )
    const { default: SnapshotService } =
      await import('../../../app/src/SnapshotService.mjs')
    const snapshot = await SnapshotService.getSnapshot('p', 2, {
      includeBinary: true,
    })
    expect(snapshot.files.find(file => file.path === 'main.tex')).toMatchObject(
      { kind: 'doc', content: 'hello' }
    )
    expect(
      snapshot.files.find(file => file.path === 'image.png')
    ).toMatchObject({ kind: 'file', hash: 'h2' })
  })
})
