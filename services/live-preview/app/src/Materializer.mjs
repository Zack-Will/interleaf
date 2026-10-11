import fs from 'node:fs/promises'
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
    await this.writeSnapshot(directory, snapshot)
    return {
      directory,
      snapshot,
      docs: new Map(snapshot.docs.map(doc => [doc.id, { ...doc }])),
    }
  }

  async writeSnapshot(directory, snapshot, previous) {
    for (const doc of snapshot.docs) {
      await this.write(directory, doc.path, doc.content)
    }
    for (const file of snapshot.files) {
      const old = previous?.files.find(entry => entry.id === file.id)
      if (!old || old.path !== file.path || old.blobUrl !== file.blobUrl) {
        await this.write(
          directory,
          file.path,
          await this.fetchBinary(file.blobUrl)
        )
      }
    }
    if (previous) {
      const kept = new Set(
        [...snapshot.docs, ...snapshot.files].map(entry => entry.path)
      )
      for (const old of [...previous.docs, ...previous.files]) {
        if (!kept.has(old.path)) {
          await this.fs.rm(projectPath(directory, old.path), { force: true })
        }
      }
    }
  }

  async write(directory, relative, content) {
    const destination = projectPath(directory, relative)
    await this.fs.mkdir(path.dirname(destination), { recursive: true })
    await this.fs.writeFile(destination, content)
  }
}
