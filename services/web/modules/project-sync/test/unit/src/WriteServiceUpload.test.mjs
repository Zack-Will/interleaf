import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

// A file the caller already has on disk reaches the merge untouched, and
// staying the caller's, it is still there afterwards.
describe('WriteService contentPath', () => {
  it('merges the file in place without reading documents', async () => {
    vi.resetModules()
    const mergeUpdate = sinon.stub()
    const getAllDocPaths = sinon.stub().resolves({})
    vi.doMock('@overleaf/settings', () => ({
      default: { path: { dumpFolder: os.tmpdir() } },
    }))
    vi.doMock('../../../../../app/src/infrastructure/LockManager.mjs', () => ({
      default: { promises: { runWithLock: async (_n, _id, fn) => fn() } },
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
      () => ({
        default: {
          promises: {
            getAllEntities: sinon.stub().resolves({ docs: [], files: [] }),
            getAllDocPathsFromProjectById: getAllDocPaths,
          },
        },
      })
    )
    vi.doMock(
      '../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
      () => ({ default: { promises: { getDocument: sinon.stub() } } })
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

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-upload-'))
    const contentPath = path.join(dir, 'figure')
    await fs.writeFile(contentPath, Buffer.from([0, 1, 2]))
    try {
      const result = await WriteService.writeFiles('p', 'u', {
        message: 'm',
        agent: 'a',
        files: [{ path: 'figures/a.pdf', contentPath }],
      })
      expect(result.applied).toEqual(['figures/a.pdf'])
      expect(mergeUpdate.firstCall.args.slice(0, 4)).toEqual([
        'u',
        'p',
        '/figures/a.pdf',
        contentPath,
      ])
      expect(getAllDocPaths.called).toBe(false)
      expect((await fs.stat(contentPath)).size).toBe(3)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  })
})
