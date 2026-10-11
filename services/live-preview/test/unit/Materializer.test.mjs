import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import sinon from 'sinon'
import { Materializer, projectPath } from '../../app/src/Materializer.mjs'

describe('Materializer', () => {
  let directory
  let snapshot
  let materializer
  const project = 'a'.repeat(24)
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-unit-'))
    snapshot = {
      projectId: project,
      compiler: 'lualatex',
      rootDoc: 'main.tex',
      docs: [{ id: 'd', path: 'main.tex', content: '中文😀', version: 2 }],
      files: [{ id: 'f', path: 'images/a.png', blobUrl: 'http://fake/blob' }],
    }
    materializer = new Materializer({
      settings: { baseDir: directory },
      fetchSnapshot: sinon.stub().callsFake(async () => snapshot),
      fetchBinary: sinon.stub().resolves(Buffer.from([1, 2, 3])),
    })
  })
  afterEach(async () => fs.rm(directory, { recursive: true, force: true }))
  it('writes document versions and downloads binary files', async () => {
    const result = await materializer.materialize(project)
    expect(
      await fs.readFile(path.join(result.directory, 'main.tex'), 'utf8')
    ).toBe('中文😀')
    expect(
      await fs.readFile(path.join(result.directory, 'images/a.png'))
    ).toEqual(Buffer.from([1, 2, 3]))
    expect(result.docs.get('d').version).toBe(2)
  })
  it('reconciles moves and removes old files', async () => {
    const result = await materializer.materialize(project)
    const next = structuredClone(snapshot)
    next.files[0].path = 'moved/a.png'
    await materializer.writeSnapshot(result.directory, next, snapshot)
    await expect(
      fs.access(path.join(result.directory, 'images/a.png'))
    ).rejects.toThrow()
    expect(
      await fs.readFile(path.join(result.directory, 'moved/a.png'))
    ).toEqual(Buffer.from([1, 2, 3]))
  })
  it.each([
    '../outside',
    '/absolute',
    'build/rtex/input.tex',
    '.live-preview-pdfs/1.pdf',
    'a/../../x',
    'a\\b',
    'a/./b',
  ])('rejects unsafe path %s', relative => {
    expect(() => projectPath(directory, relative)).toThrow('Unsafe')
  })
  it('validates root, duplicate paths and versions before writing', async () => {
    snapshot.docs[0].version = -1
    await expect(materializer.materialize(project)).rejects.toThrow('version')
    snapshot.docs[0].version = 0
    snapshot.files[0].path = 'main.tex'
    await expect(materializer.materialize(project)).rejects.toThrow('Duplicate')
    snapshot.files = []
    snapshot.rootDoc = 'missing.tex'
    await expect(materializer.materialize(project)).rejects.toThrow('Root')
  })
  it.each(['file', 'parent', 'root'])(
    'rejects %s symlinks without changing their target',
    async kind => {
      const outside = path.join(directory, 'outside')
      await fs.mkdir(outside)
      const target = path.join(outside, 'sentinel')
      await fs.writeFile(target, 'unchanged')
      const root = path.join(directory, 'session')
      await fs.mkdir(root)
      let relative = 'input.tex'
      if (kind === 'root') {
        await fs.rm(root, { recursive: true })
        await fs.symlink(outside, root)
      } else if (kind === 'parent') {
        await fs.symlink(outside, path.join(root, 'chapter'))
        relative = 'chapter/sentinel'
      } else {
        await fs.symlink(target, path.join(root, relative))
      }
      await expect(
        materializer.write(root, relative, 'overwrite')
      ).rejects.toMatchObject({ code: 'invalid_path' })
      expect(await fs.readFile(target, 'utf8')).toBe('unchanged')
    }
  )
  it('bounds file count, UTF-8 bytes, binary bytes and aggregate bytes', async () => {
    materializer.settings.maxSnapshotEntries = 1
    await expect(materializer.materialize(project)).rejects.toMatchObject({
      code: 'snapshot_too_large',
    })
    materializer.settings.maxSnapshotEntries = 2
    materializer.settings.maxFileBytes = 8
    await expect(materializer.materialize(project)).rejects.toMatchObject({
      code: 'file_too_large',
    })
    materializer.settings.maxFileBytes = 10
    materializer.fetchBinary.resolves(Buffer.alloc(11))
    await expect(materializer.materialize(project)).rejects.toMatchObject({
      code: 'file_too_large',
    })
    materializer.fetchBinary.resolves(Buffer.alloc(3))
    materializer.settings.maxSnapshotBytes = 11
    await expect(materializer.materialize(project)).rejects.toMatchObject({
      code: 'snapshot_too_large',
    })
    await expect(fs.access(path.join(directory, project))).rejects.toThrow()
  })
  it('removes stale project directories on startup, preserving unrelated files', async () => {
    await materializer.materialize(project)
    await fs.writeFile(path.join(directory, 'README'), 'keep')
    await materializer.cleanupStale()
    await expect(fs.access(path.join(directory, project))).rejects.toThrow()
    expect(await fs.readFile(path.join(directory, 'README'), 'utf8')).toBe(
      'keep'
    )
  })
  it('atomically replaces source hard links without mutating the retained build snapshot', async () => {
    const result = await materializer.materialize(project)
    const source = path.join(result.directory, 'main.tex')
    const retained = path.join(result.directory, 'retained.tex')
    await fs.link(source, retained)
    await materializer.write(result.directory, 'main.tex', 'changed')
    expect(await fs.readFile(source, 'utf8')).toBe('changed')
    expect(await fs.readFile(retained, 'utf8')).toBe('中文😀')
  })
})
