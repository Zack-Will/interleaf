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
})
