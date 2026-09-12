import { describe, expect, it, vi } from 'vitest'

const branchId = 'b'.repeat(24)
const parentId = 'p'.repeat(24)

function setupBranch({ base, ours, theirs, branch = {} } = {}) {
  const requireAccess = vi.fn()
  const getSnapshot = vi.fn(async (projectId, version) => {
    if (projectId === parentId && version === 3) return base
    if (projectId === branchId) return ours
    return theirs
  })
  const getLatestVersion = vi.fn(async projectId => ({
    version: projectId === branchId ? 7 : 9,
  }))
  const record = {
    branchProjectId: branchId,
    parentProjectId: parentId,
    baseVersion: 3,
    name: 'feature',
    ...branch,
  }
  const findOne = vi.fn().mockResolvedValue(record)
  const updateOne = vi.fn().mockResolvedValue(record)
  const writeFiles = vi.fn().mockResolvedValue({
    version: 10,
    label: { id: 'label', comment: 'merge' },
  })
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectDetailsHandler.mjs',
    () => ({
      default: { fixProjectName: vi.fn(name => name) },
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectDuplicator.mjs',
    () => ({
      default: { promises: { duplicate: vi.fn() } },
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectDeleter.mjs',
    () => ({
      default: { promises: { archiveProject: vi.fn() } },
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectGetter.mjs',
    () => ({
      default: { promises: { getProject: vi.fn() } },
    })
  )
  vi.doMock('../../../../../app/src/Features/Tags/TagsHandler.mjs', () => ({
    default: { promises: { addProjectToTagName: vi.fn() } },
  }))
  vi.doMock('../../../app/src/models/SyncBranch.mjs', () => ({
    SyncBranch: { findOne, find: vi.fn(), create: vi.fn(), updateOne },
    default: { findOne, find: vi.fn(), create: vi.fn(), updateOne },
  }))
  vi.doMock('../../../app/src/ProjectRef.mjs', () => ({
    default: { requireAccess, urlFor: id => `https://ol/project/${id}` },
  }))
  vi.doMock('../../../app/src/SnapshotService.mjs', () => ({
    default: { getSnapshot },
  }))
  vi.doMock('../../../app/src/VersionService.mjs', () => ({
    default: { getLatestVersion, promises: { getLatestVersion } },
  }))
  vi.doMock('../../../app/src/WriteService.mjs', () => ({
    default: { writeFiles },
  }))
  return {
    getSnapshot,
    getLatestVersion,
    requireAccess,
    findOne,
    updateOne,
    writeFiles,
  }
}

async function importBranchService() {
  return (await import('../../../app/src/BranchService.mjs')).default
}

function doc(path, content) {
  return { path, kind: 'doc', content }
}

function binary(path, hash) {
  return { path, kind: 'file', hash, buffer: Buffer.from(hash) }
}

describe('BranchService createBranch', () => {
  it('truncates the parent name, captures the base version, clones without history, tags, and saves', async () => {
    vi.resetModules()
    const mocks = setupBranch()
    const duplicate = vi.fn().mockResolvedValue({ _id: branchId })
    const create = vi.fn().mockImplementation(async value => ({ ...value }))
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectDuplicator.mjs',
      () => ({
        default: { promises: { duplicate } },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectGetter.mjs',
      () => ({
        default: {
          promises: {
            getProject: vi.fn().mockResolvedValue({ name: 'P'.repeat(145) }),
          },
        },
      })
    )
    vi.doMock('../../../app/src/models/SyncBranch.mjs', () => ({
      SyncBranch: {
        findOne: mocks.findOne,
        find: vi.fn(),
        create,
        updateOne: mocks.updateOne,
      },
      default: {
        findOne: mocks.findOne,
        find: vi.fn(),
        create,
        updateOne: mocks.updateOne,
      },
    }))
    const addProjectToTagName = vi.fn()
    vi.doMock('../../../../../app/src/Features/Tags/TagsHandler.mjs', () => ({
      default: { promises: { addProjectToTagName } },
    }))
    const service = await importBranchService()
    const result = await service.createBranch(parentId, 'u', { name: 'x' })
    const projectName = duplicate.mock.calls[0][2]
    expect(projectName.length).toBeLessThanOrEqual(150)
    expect(projectName).toBe(
      `${'P'.repeat(145).slice(0, 150 - ' [branch: x]'.length)} [branch: x]`
    )
    expect(mocks.getLatestVersion).toHaveBeenCalledWith(parentId)
    expect(duplicate).toHaveBeenCalledWith(
      { _id: 'u' },
      parentId,
      projectName,
      [],
      { isDebugCopy: false, cloneHistory: false, cloneRanges: false }
    )
    expect(addProjectToTagName).toHaveBeenCalledWith(
      'u',
      `branch: ${'P'.repeat(40)}`,
      branchId
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ baseVersion: 9, status: 'open' })
    )
    expect(result.base_version).toBe(9)
  })
})

describe('BranchService classification', () => {
  it('classifies every document state and deleted paths', async () => {
    vi.resetModules()
    const base = {
      files: [
        doc('/unchanged', 'a'),
        doc('/branch', 'a'),
        doc('/parent', 'a'),
        doc('/same', 'a'),
        doc('/diff', 'a'),
        doc('/deleted', 'a'),
      ],
    }
    const ours = {
      files: [
        doc('/unchanged', 'a'),
        doc('/branch', 'b'),
        doc('/parent', 'a'),
        doc('/same', 'b'),
        doc('/diff', 'b'),
      ],
    }
    const theirs = {
      files: [
        doc('/unchanged', 'a'),
        doc('/branch', 'a'),
        doc('/parent', 'c'),
        doc('/same', 'b'),
        doc('/diff', 'c'),
        doc('/deleted', 'a'),
      ],
    }
    setupBranch({ base, ours, theirs })
    const service = await importBranchService()
    const result = await service.diffBranch(branchId, 'u')
    expect(
      Object.fromEntries(result.files.map(file => [file.path, file.state]))
    ).toEqual({
      '/branch': 'branch_only',
      '/deleted': 'branch_only',
      '/diff': 'both_differ',
      '/parent': 'parent_only',
      '/same': 'both_same',
      '/unchanged': 'unchanged',
    })
  })

  it('compares binary files by hash', async () => {
    vi.resetModules()
    setupBranch({
      base: { files: [binary('/same.bin', 'a'), binary('/changed.bin', 'a')] },
      ours: { files: [binary('/same.bin', 'b'), binary('/changed.bin', 'b')] },
      theirs: {
        files: [binary('/same.bin', 'b'), binary('/changed.bin', 'c')],
      },
    })
    const service = await importBranchService()
    const result = await service.diffBranch(branchId, 'u')
    expect(result.files).toEqual([
      { path: '/changed.bin', kind: 'file', state: 'both_differ' },
      { path: '/same.bin', kind: 'file', state: 'both_same' },
    ])
  })
})

describe('BranchService mergeBranch', () => {
  it('merges disjoint document edits in a dry run without writing', async () => {
    vi.resetModules()
    const mocks = setupBranch({
      base: { files: [doc('/main.tex', 'a\nb\nc\nd')] },
      ours: { files: [doc('/main.tex', 'a\nM\nc\nd')] },
      theirs: { files: [doc('/main.tex', 'a\nb\nc\nP')] },
    })
    const service = await importBranchService()
    const result = await service.mergeBranch(branchId, 'u', { dryRun: true })
    expect(result.mergeable).toBe(true)
    expect(result.files[0].content).toContain('M')
    expect(result.files[0].content).toContain('P')
    expect(result.conflicts).toEqual([])
    expect(mocks.writeFiles).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      base_version: 3,
      branch_version: 7,
      parent_version: 9,
    })
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(3)
  })

  it('reports overlapping document edits with conflict hunks', async () => {
    vi.resetModules()
    setupBranch({
      base: { files: [doc('/main.tex', 'a\nb\nc')] },
      ours: { files: [doc('/main.tex', 'a\nM\nc')] },
      theirs: { files: [doc('/main.tex', 'a\nP\nc')] },
    })
    const service = await importBranchService()
    const result = await service.mergeBranch(branchId, 'u')
    expect(result.mergeable).toBe(false)
    expect(result.conflicts[0].path).toBe('/main.tex')
    expect(result.conflicts[0].conflicts[0]).toEqual(
      expect.objectContaining({
        mine: expect.any(Array),
        theirs: expect.any(Array),
      })
    )
  })

  it('reports delete versus modify with a reason', async () => {
    vi.resetModules()
    setupBranch({
      base: { files: [binary('/image.png', 'a')] },
      ours: { files: [] },
      theirs: { files: [binary('/image.png', 'b')] },
    })
    const service = await importBranchService()
    const result = await service.mergeBranch(branchId, 'u')
    expect(result.conflicts).toEqual([
      {
        path: '/image.png',
        conflicts: [{ reason: 'deleted_in_branch_modified_in_parent' }],
      },
    ])
  })

  it('writes a clean merge with the observed parent version and updates the record', async () => {
    vi.resetModules()
    const mocks = setupBranch({
      base: { files: [doc('/main.tex', 'a\nb')] },
      ours: { files: [doc('/main.tex', 'a\nM')] },
      theirs: { files: [doc('/main.tex', 'a\nb')] },
    })
    const service = await importBranchService()
    const result = await service.mergeBranch(branchId, 'u', {
      dryRun: false,
      message: 'merge it',
      agent: 'agent-x',
    })
    expect(mocks.writeFiles).toHaveBeenCalledWith(
      parentId,
      'u',
      expect.objectContaining({
        baseVersion: 9,
        message: 'merge it',
        agent: 'agent-x',
        originExtra: { merge: { branch: branchId, branchVersion: 7 } },
      })
    )
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { branchProjectId: branchId },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'merged', mergedVersion: 10 }),
      })
    )
    expect(result).toMatchObject({
      mergeable: true,
      version: 10,
      base_version: 3,
      branch_version: 7,
      parent_version: 9,
    })
  })
})

describe('BranchService archiveBranch', () => {
  it('archives the project and updates status', async () => {
    vi.resetModules()
    const mocks = setupBranch()
    const archiveProject = vi.fn()
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectDeleter.mjs',
      () => ({
        default: { promises: { archiveProject } },
      })
    )
    const service = await importBranchService()
    expect(await service.archiveBranch(branchId, 'u')).toEqual({
      branch_project_id: branchId,
      status: 'archived',
    })
    expect(archiveProject).toHaveBeenCalledWith(branchId, 'u')
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { branchProjectId: branchId },
      { $set: { status: 'archived' } }
    )
  })
})

describe('WriteService unchanged detection', () => {
  function setupWrite({ document, getDocumentError = false } = {}) {
    vi.doUnmock('../../../app/src/WriteService.mjs')
    const getAllEntities = vi.fn().mockResolvedValue({ docs: [], files: [] })
    const getAllDocPathsFromProjectById = vi
      .fn()
      .mockResolvedValue({ doc1: '/main.tex' })
    const getDocument = getDocumentError
      ? vi.fn().mockRejectedValue(new Error('comparison failed'))
      : vi.fn().mockResolvedValue({ lines: document ?? ['live'] })
    const mergeUpdate = vi.fn().mockResolvedValue(undefined)
    const createLabel = vi
      .fn()
      .mockResolvedValue({ id: 'label', comment: 'write' })
    const getLatestVersion = vi
      .fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 })
    const warn = vi.fn()
    vi.doMock('@overleaf/settings', () => ({
      default: { path: { dumpFolder: '/tmp' } },
    }))
    vi.doMock('@overleaf/logger', () => ({ default: { warn } }))
    vi.doMock('../../../../../app/src/infrastructure/LockManager.mjs', () => ({
      default: { promises: { runWithLock: async (_name, _id, fn) => fn() } },
    }))
    vi.doMock(
      '../../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs',
      () => ({
        default: {
          promises: { _mergeUpdate: mergeUpdate, deleteUpdate: vi.fn() },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
      () => ({
        default: {
          promises: { getAllEntities, getAllDocPathsFromProjectById },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
      () => ({
        default: { promises: { getDocument } },
      })
    )
    vi.doMock('../../../app/src/VersionService.mjs', () => ({
      default: { promises: { getLatestVersion } },
    }))
    vi.doMock('../../../app/src/LabelService.mjs', () => ({
      default: { promises: { createLabel } },
    }))
    return {
      getAllEntities,
      getAllDocPathsFromProjectById,
      getDocument,
      mergeUpdate,
      createLabel,
      warn,
    }
  }

  it('marks a document unchanged only when live content equals the new content', async () => {
    vi.resetModules()
    const mocks = setupWrite({ document: ['live'] })
    const { default: WriteService } =
      await import('../../../app/src/WriteService.mjs')
    const result = await WriteService.writeFiles('p', 'u', {
      message: 'write',
      files: [{ path: 'main.tex', content: 'live' }],
    })
    expect(result).toMatchObject({ applied: [], unchanged: ['main.tex'] })
    expect(mocks.getAllEntities).toHaveBeenCalledTimes(1)
    expect(mocks.getAllDocPathsFromProjectById).toHaveBeenCalledTimes(1)
    expect(mocks.mergeUpdate).not.toHaveBeenCalled()
  })

  it('writes a document when its live content differs', async () => {
    vi.resetModules()
    const mocks = setupWrite({ document: ['old'] })
    const { default: WriteService } =
      await import('../../../app/src/WriteService.mjs')
    const result = await WriteService.writeFiles('p', 'u', {
      message: 'write',
      files: [{ path: 'main.tex', content: 'new' }],
    })
    expect(result.applied).toEqual(['main.tex'])
    expect(mocks.mergeUpdate).toHaveBeenCalledTimes(1)
  })

  it('logs comparison errors and falls through to writing', async () => {
    vi.resetModules()
    const mocks = setupWrite({ getDocumentError: true })
    const { default: WriteService } =
      await import('../../../app/src/WriteService.mjs')
    const result = await WriteService.writeFiles('p', 'u', {
      message: 'write',
      files: [{ path: 'main.tex', content: 'new' }],
    })
    expect(result.applied).toEqual(['main.tex'])
    expect(mocks.mergeUpdate).toHaveBeenCalledTimes(1)
    expect(mocks.warn).toHaveBeenCalled()
  })
})

describe('sync branch migration', () => {
  it('exports tags, migrate, and rollback for all deployments', async () => {
    vi.resetModules()
    vi.doMock('../../../../../../../tools/migrations/lib/mongodb.mjs', () => ({
      getCollectionInternal: vi.fn(),
    }))
    vi.doMock(
      '../../../../../../../tools/migrations/lib/helpers.mjs',
      () => ({})
    )
    const migration = (
      await import('../../../../../../../tools/migrations/20260912000000_create_syncBranches_collection.mjs')
    ).default
    expect(Object.keys(migration).sort()).toEqual([
      'migrate',
      'rollback',
      'tags',
    ])
    expect(migration.tags).toEqual(['server-ce', 'server-pro', 'saas'])
  })
})
