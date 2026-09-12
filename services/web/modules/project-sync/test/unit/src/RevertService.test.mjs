import { describe, expect, it, vi } from 'vitest'

// Reverting is a milestone event, so it keeps labelling the version it
// produces even though ordinary writes no longer do.
async function importRevertService({ writeFiles }) {
  vi.resetModules()
  vi.doMock('../../../app/src/SnapshotService.mjs', () => ({
    default: {
      async getSnapshot() {
        return {
          version: 2,
          files: [{ path: 'main.tex', kind: 'doc', content: 'old' }],
        }
      },
      async getFileTree() {
        return [{ path: 'main.tex', kind: 'doc' }]
      },
    },
  }))
  vi.doMock('../../../app/src/VersionService.mjs', () => ({
    default: {
      promises: {
        async getLatestVersion() {
          return { version: 7 }
        },
      },
    },
  }))
  vi.doMock('../../../app/src/WriteService.mjs', () => ({
    default: { writeFiles },
  }))
  vi.doMock('../../../app/src/ProjectRef.mjs', () => ({
    default: { async requireAccess() {} },
  }))
  const { default: RevertService } =
    await import('../../../app/src/RevertService.mjs')
  return RevertService
}

describe('RevertService', () => {
  it('asks for a label and reports both versions', async () => {
    const writeFiles = vi.fn().mockResolvedValue({
      version: 8,
      label: { id: 'l1', comment: 'Revert project to version 2' },
      applied: ['main.tex'],
      failed: [],
      comments_affected: [],
    })
    const RevertService = await importRevertService({ writeFiles })

    const result = await RevertService.revertTo('p', 'u', { version: 2 })

    expect(writeFiles).toHaveBeenCalledWith(
      'p',
      'u',
      expect.objectContaining({
        message: 'Revert project to version 2',
        originExtra: { revert: { from: 7, to: 2 } },
        label: true,
      })
    )
    expect(result).toMatchObject({
      project_version: 8,
      reverted_from_version: 7,
      reverted_to_version: 2,
      label: { id: 'l1' },
    })
  })
})
