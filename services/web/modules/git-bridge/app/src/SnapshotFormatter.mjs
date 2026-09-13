import { buildSignedBlobUrl } from './SignedBlobUrl.mjs'

const stripLeadingSlash = path => String(path || '').replace(/^\/+/, '')

/**
 * Translate a project-sync snapshot into the shape the Java git-bridge parses
 * in `SnapshotData`: text documents as `[content, path]` pairs and binaries as
 * `[url, path]` pairs.
 *
 * @param {string} projectId
 * @param {{ files?: Array<object> }} snapshot
 * @param {{ settings?: object, now?: number, ttlMs?: number }} [options]
 * @returns {{ srcs: Array<[string, string]>, atts: Array<[string, string]> }}
 */
function formatSnapshot(projectId, snapshot, options = {}) {
  const srcs = []
  const atts = []
  for (const file of snapshot?.files || []) {
    const path = stripLeadingSlash(file.path)
    if (file.kind === 'doc') {
      srcs.push([String(file.content ?? ''), path])
      continue
    }
    if (!file.hash) continue
    const url = buildSignedBlobUrl(projectId, file.hash, path, options)
    atts.push([url, path])
  }
  return { srcs, atts }
}

export { formatSnapshot }
export default { formatSnapshot }
