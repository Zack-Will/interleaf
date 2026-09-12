import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import { fetchJson } from '@overleaf/fetch-utils'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import { NotATextFileError } from './Errors.mjs'

const clean = p => String(p || '').replace(/^\/+/, '')
async function getSnapshot(projectId, version) {
  const body = await fetchJson(`${Settings.apis.project_history.url}/project/${projectId}/version/${version}`)
  const files = []
  for (const [pathname, entry] of Object.entries(body.files || {})) {
    const path = clean(pathname); const data = entry?.data || {}
    if (data.content != null) files.push({ path, kind: 'doc', content: data.content, size: Buffer.byteLength(data.content) })
    else files.push({ path, kind: 'file', hash: data.hash, size: 0 })
  }
  return { version: body.version ?? version, files }
}
async function getFileTree(projectId) {
  const entities = await ProjectEntityHandler.promises.getAllEntities(projectId)
  return [...(entities.docs || []).map(d => ({ path: clean(d.path), kind: 'doc' })), ...(entities.files || []).map(f => ({ path: clean(f.path), kind: 'file' }))]
}
async function readDoc(projectId, path, { startLine, endLine } = {}) {
  const target = clean(path)
  const entities = await ProjectEntityHandler.promises.getAllEntities(projectId)
  if ((entities.files || []).some(f => clean(f.path) === target)) throw new NotATextFileError()
  const docs = await ProjectEntityHandler.promises.getAllDocPathsFromProjectById(projectId)
  const found = Object.entries(docs).find(([, p]) => clean(p) === target)
  if (!found) throw new Error('document not found')
  const [docId] = found
  const doc = await DocumentUpdaterHandler.promises.getDocument(projectId, docId, -1)
  const lines = Array.isArray(doc.lines) ? doc.lines : String(doc.lines || '').split(/\r\n|\n|\r/)
  const content = lines.join('\n')
  const from = startLine == null ? 0 : Math.max(0, startLine - 1)
  const to = endLine == null ? lines.length : Math.min(lines.length, endLine)
  return { path: target, lines: lines.slice(from, to), totalLines: lines.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), docVersion: doc.version }
}
export default { getSnapshot, getFileTree, readDoc, promises: { getSnapshot, getFileTree, readDoc } }
