import crypto from 'node:crypto'
import Settings from '@overleaf/settings'

// The Java git-bridge fetches attachment URLs with a plain GET and no
// Authorization header, so the URL itself has to carry the proof of access.
// Ten minutes is plenty for one `git clone` / `git pull`.
const DEFAULT_TTL_MS = 10 * 60 * 1000

function getSecret(settings) {
  const secret =
    settings?.gitBridge?.blobUrlSecret || settings?.security?.sessionSecret
  if (!secret) {
    throw new Error('git-bridge blob URL secret is not configured')
  }
  return String(secret)
}

function getPublicBaseUrl(settings) {
  const base = settings?.apis?.gitBridge?.webPublicUrl || settings?.siteUrl
  return String(base || '').replace(/\/+$/, '')
}

function signPayload(projectId, hash, expiresAt, settings) {
  const payload = `${projectId}:${hash}:${expiresAt}`
  return crypto
    .createHmac('sha256', getSecret(settings))
    .update(payload)
    .digest('hex')
}

/**
 * Build an absolute, self-authenticating URL for one history blob.
 *
 * @param {string} projectId
 * @param {string} hash
 * @param {string} path project-relative path, used only as a cache hint
 * @param {{ settings?: object, now?: number, ttlMs?: number }} [options]
 * @returns {string}
 */
function buildSignedBlobUrl(projectId, hash, path, options = {}) {
  const settings = options.settings || Settings
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const expiresAt = Math.floor((now + ttlMs) / 1000)
  const token = signPayload(projectId, hash, expiresAt, settings)
  const query = new URLSearchParams()
  // git-bridge strips `token=...` when computing its resource cache key, so the
  // parameter has to keep exactly this name.
  query.set('token', token)
  query.set('exp', String(expiresAt))
  query.set('_path', String(path || ''))
  const base = getPublicBaseUrl(settings)
  return `${base}/api/v0/docs/${projectId}/blobs/${hash}?${query.toString()}`
}

/**
 * Verify a signature produced by buildSignedBlobUrl.
 *
 * @param {string} projectId
 * @param {string} hash
 * @param {{ token?: string, exp?: string|number }} query
 * @param {{ settings?: object, now?: number }} [options]
 * @returns {boolean}
 */
function verifyBlobToken(projectId, hash, query, options = {}) {
  const settings = options.settings || Settings
  const now = options.now ?? Date.now()
  const token = query?.token
  const expiresAt = Number(query?.exp)
  if (typeof token !== 'string' || token.length === 0) return false
  if (!Number.isFinite(expiresAt)) return false
  if (expiresAt * 1000 < now) return false
  const expected = signPayload(projectId, hash, expiresAt, settings)
  const provided = Buffer.from(token, 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  if (provided.length !== wanted.length) return false
  return crypto.timingSafeEqual(provided, wanted)
}

export { buildSignedBlobUrl, verifyBlobToken, DEFAULT_TTL_MS }
export default { buildSignedBlobUrl, verifyBlobToken, DEFAULT_TTL_MS }
