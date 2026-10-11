import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { PreviewError } from './Errors.mjs'
import { validateProject } from '@overleaf/live-preview-protocol/Tickets.mjs'

export function projectPath(directory, relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    path.isAbsolute(relative) ||
    relative.split('/').some(part => !part || part === '..' || part === '.') ||
    relative === 'build' ||
    relative.startsWith('build/') ||
    relative === '.live-preview-pdfs' ||
    relative.startsWith('.live-preview-pdfs/')
  ) {
    throw new PreviewError('invalid_path', 'Unsafe project file path', 400)
  }
  return path.join(directory, relative)
}

// Inspect every existing component, including the session root. Never follow a
// link supplied by a project or left by an engine when reconciling snapshots.
export async function assertNoSymlinks(filesystem, directory, destination) {
  const relative = path.relative(directory, destination)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PreviewError('invalid_path', 'Path leaves session directory', 400)
  }
  let current = directory
  for (const part of ['', ...relative.split('/').filter(Boolean)]) {
    current = path.join(current, part)
    try {
      const stat = await filesystem.lstat(current)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new PreviewError('invalid_path', 'Unsafe project file type', 400)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

/**
 * P2 internal snapshot contract (also docs/snapshot.schema.json):
 * { projectId, compiler: 'lualatex', rootDoc: 'main.tex',
 *   docs: [{ id, path, content: string, version: integer }],
 *   files: [{ id, path, blobUrl: absolute http(s) URL }] }.
 * Paths include folder names. Text and versions come from document-updater;
 * binary URLs are private filestore URLs. No get_and_flush_if_old is used.
 */
export class Materializer {
  constructor({ settings, fetchSnapshot, fetchBinary, filesystem = fs }) {
    this.settings = settings
    this.fetchSnapshot = fetchSnapshot
    this.fetchBinary = fetchBinary
    this.fs = filesystem
  }

  async snapshot(projectId) {
    validateProject(projectId)
    const snapshot = await this.fetchSnapshot(projectId)
    if (
      snapshot.projectId !== projectId ||
      !Array.isArray(snapshot.docs) ||
      !Array.isArray(snapshot.files)
    ) {
      throw new PreviewError('invalid_snapshot', 'Invalid snapshot contract')
    }
    const paths = new Set()
    const ids = new Set()
    if (
      snapshot.docs.length + snapshot.files.length >
      (this.settings.maxSnapshotEntries ?? 2000)
    ) {
      throw new PreviewError(
        'snapshot_too_large',
        'Too many project files',
        413
      )
    }
    for (const entry of [...snapshot.docs, ...snapshot.files]) {
      projectPath(this.settings.baseDir, entry.path)
      if (!entry.id || ids.has(entry.id) || paths.has(entry.path)) {
        throw new PreviewError('invalid_snapshot', 'Duplicate path or id')
      }
      ids.add(entry.id)
      paths.add(entry.path)
    }
    if (!snapshot.docs.some(doc => doc.path === snapshot.rootDoc)) {
      throw new PreviewError('invalid_snapshot', 'Root document is missing')
    }
    for (const doc of snapshot.docs) {
      if (
        typeof doc.content !== 'string' ||
        !Number.isSafeInteger(doc.version) ||
        doc.version < 0
      ) {
        throw new PreviewError(
          'invalid_snapshot',
          'Invalid document content or version'
        )
      }
      this.checkSize(doc.content)
    }
    for (const file of snapshot.files) {
      if (!/^https?:\/\//.test(file.blobUrl || '')) {
        throw new PreviewError('invalid_snapshot', 'Invalid blob URL')
      }
    }
    return snapshot
  }

  async materialize(projectId) {
    const snapshot = await this.snapshot(projectId)
    const directory = path.join(this.settings.baseDir, projectId)
    // This directory is exclusively owned by live-preview, including its build tree.
    await this.fs.rm(directory, { recursive: true, force: true })
    await this.fs.mkdir(directory, { recursive: true })
    try {
      await this.writeSnapshot(directory, snapshot)
      if (this.settings.texDir) {
        await this.fs.cp(
          this.settings.texDir,
          path.join(directory, 'build/rtex-support'),
          { recursive: true }
        )
      }
    } catch (error) {
      await this.fs.rm(directory, { recursive: true, force: true })
      throw error
    }
    return {
      directory,
      snapshot,
      docs: new Map(snapshot.docs.map(doc => [doc.id, { ...doc }])),
    }
  }

  async writeSnapshot(directory, snapshot, previous) {
    let bytes = 0
    const countBytes = size => {
      bytes += size
      if (bytes > (this.settings.maxSnapshotBytes ?? 256 * 1024 ** 2)) {
        throw new PreviewError(
          'snapshot_too_large',
          'Project exceeds byte budget',
          413
        )
      }
    }
    for (const doc of snapshot.docs) {
      countBytes(this.checkSize(doc.content))
      await this.write(directory, doc.path, doc.content)
    }
    for (const file of snapshot.files) {
      const old = previous?.files.find(entry => entry.id === file.id)
      if (!old || old.path !== file.path || old.blobUrl !== file.blobUrl) {
        const content = await this.fetchBinary(file.blobUrl)
        countBytes(this.checkSize(content))
        await this.write(directory, file.path, content)
      } else {
        const destination = projectPath(directory, file.path)
        await assertNoSymlinks(this.fs, directory, destination)
        countBytes((await this.fs.stat(destination)).size)
      }
    }
    if (previous) {
      const kept = new Set(
        [...snapshot.docs, ...snapshot.files].map(entry => entry.path)
      )
      for (const old of [...previous.docs, ...previous.files]) {
        if (!kept.has(old.path)) {
          const destination = projectPath(directory, old.path)
          await assertNoSymlinks(this.fs, directory, destination)
          await this.fs.rm(destination, { force: true })
        }
      }
    }
  }

  async write(directory, relative, content) {
    this.checkSize(content)
    const destination = projectPath(directory, relative)
    await assertNoSymlinks(this.fs, directory, destination)
    await this.fs.mkdir(path.dirname(destination), { recursive: true })
    // rtex hard-links project sources into its build snapshots. Replace the
    // directory entry so writing does not mutate a retained snapshot's inode.
    const temporary = path.join(
      path.dirname(destination),
      `.preview-${randomUUID()}`
    )
    try {
      await this.fs.writeFile(temporary, content, {
        flag:
          constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
      })
      await assertNoSymlinks(this.fs, directory, destination)
      await this.fs.rename(temporary, destination)
    } finally {
      await this.fs.rm(temporary, { force: true })
    }
  }

  checkSize(content) {
    const bytes = Buffer.byteLength(content)
    if (bytes > (this.settings.maxFileBytes ?? 32 * 1024 ** 2)) {
      throw new PreviewError(
        'file_too_large',
        'Project file exceeds byte budget',
        413
      )
    }
    return bytes
  }

  async cleanupStale() {
    await this.fs.mkdir(this.settings.baseDir, { recursive: true })
    await assertNoSymlinks(
      this.fs,
      this.settings.baseDir,
      this.settings.baseDir
    )
    for (const name of await this.fs.readdir(this.settings.baseDir)) {
      if (/^[a-f0-9]{24}$/i.test(name)) {
        await this.fs.rm(path.join(this.settings.baseDir, name), {
          recursive: true,
          force: true,
        })
      }
    }
  }
}
