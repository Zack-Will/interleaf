import { pipeline } from 'node:stream/promises'
import { formatSnapshot } from './SnapshotFormatter.mjs'
import { verifyBlobToken } from './SignedBlobUrl.mjs'
import { createPushJob } from './PushJob.mjs'

const HEX_24 = /^[0-9a-f]{24}$/
const HEX_BLOB = /^[0-9a-f]{40,}$/

const stripLeadingSlash = path => String(path || '').replace(/^\/+/, '')

function toIsoString(timestamp) {
  if (timestamp == null) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function toVersionNumber(version) {
  const parsed = Number(version)
  return Number.isFinite(parsed) ? parsed : 0
}

function respondWithStatus(res, status, message) {
  return res.status(status).json({ status, message })
}

/**
 * Build the git-bridge HTTP handlers. Collaborators are injected so the
 * handlers can be unit tested without Mongo or project-history.
 *
 * @param {object} services
 */
function createHandlers(services) {
  const {
    ProjectRef,
    VersionService,
    SnapshotService,
    LabelService,
    UserGetter,
    HistoryManager,
    settings,
    logger,
  } = services
  const runPushJob = services.runPushJob || createPushJob(services)

  function getProjectId(req) {
    const projectId = String(req.params.projectId || '').toLowerCase()
    return HEX_24.test(projectId) ? projectId : null
  }

  /**
   * Map a project-sync access error onto the HTTP statuses the Java client
   * understands: 401/403 mean "forbidden", 404 means "project missing".
   */
  function handleAccessError(error, res) {
    if (error?.code === 'not_found') {
      respondWithStatus(res, 404, 'Not Found')
      return true
    }
    if (error?.code === 'forbidden') {
      respondWithStatus(res, 403, 'Forbidden')
      return true
    }
    return false
  }

  async function requireProjectAccess(req, res, level) {
    const projectId = getProjectId(req)
    if (projectId == null) {
      respondWithStatus(res, 404, 'Not Found')
      return null
    }
    try {
      await ProjectRef.requireAccess(req.syncUser.userId, projectId, level)
    } catch (error) {
      if (handleAccessError(error, res)) return null
      throw error
    }
    return projectId
  }

  async function resolveUser(userId) {
    if (!userId) return { name: 'Unknown', email: '' }
    try {
      const user = await UserGetter.promises.getUser(userId, {
        first_name: 1,
        last_name: 1,
        email: 1,
      })
      if (!user) return { name: 'Unknown', email: '' }
      const name = [user.first_name, user.last_name]
        .filter(part => part)
        .join(' ')
      return { name: name || user.email || 'Unknown', email: user.email || '' }
    } catch (error) {
      logger.warn({ err: error, userId }, 'git-bridge could not resolve user')
      return { name: 'Unknown', email: '' }
    }
  }

  async function getDoc(req, res) {
    const projectId = await requireProjectAccess(req, res, 'read')
    if (projectId == null) return
    const latest = await VersionService.promises.getLatestVersion(projectId)
    const [authorId] = latest.v2Authors || []
    const user = await resolveUser(authorId)
    return res.json({
      latestVerId: toVersionNumber(latest.version),
      latestVerAt: toIsoString(latest.timestamp),
      latestVerBy: user,
    })
  }

  async function getSavedVers(req, res) {
    const projectId = await requireProjectAccess(req, res, 'read')
    if (projectId == null) return
    const labels = await LabelService.promises.listLabels(projectId)
    const savedVers = []
    for (const label of labels || []) {
      const user = await resolveUser(label.user_id)
      savedVers.push({
        versionId: toVersionNumber(label.version),
        comment: label.comment ?? '',
        user,
        createdAt: toIsoString(label.created_at),
      })
    }
    return res.json(savedVers)
  }

  async function getSnapshot(req, res) {
    const projectId = await requireProjectAccess(req, res, 'read')
    if (projectId == null) return
    const version = Number(req.params.version)
    if (!Number.isFinite(version)) {
      return respondWithStatus(res, 404, 'Not Found')
    }
    const snapshot = await SnapshotService.promises.getSnapshot(
      projectId,
      version,
      { includeBinary: true }
    )
    return res.json(formatSnapshot(projectId, snapshot, { settings }))
  }

  async function postSnapshot(req, res) {
    const projectId = await requireProjectAccess(req, res, 'write')
    if (projectId == null) return
    const { latestVerId, files = [], postbackUrl } = req.body || {}
    const latest = await VersionService.promises.getLatestVersion(projectId)
    const currentVersion = toVersionNumber(latest.version)
    if (toVersionNumber(latestVerId) !== currentVersion) {
      // Must be HTTP 200: the Java client turns every non-2xx status into a
      // connection/permission error instead of a normal push rejection.
      return res.json({
        status: 409,
        code: 'outOfDate',
        message: 'Out of Date',
      })
    }
    res.json({ status: 402, code: 'accepted', message: 'Accepted' })
    const job = {
      projectId,
      userId: req.syncUser.userId,
      latestVerId: currentVersion,
      files,
      postbackUrl,
    }
    // Deliberately not awaited: git-bridge polls for the postback instead.
    return runPushJob(job).catch(error => {
      logger.error({ err: error, projectId }, 'git-bridge push job crashed')
    })
  }

  async function getBlob(req, res) {
    const projectId = getProjectId(req)
    const hash = String(req.params.hash || '').toLowerCase()
    if (projectId == null || !HEX_BLOB.test(hash)) {
      return respondWithStatus(res, 404, 'Not Found')
    }
    if (!verifyBlobToken(projectId, hash, req.query, { settings })) {
      return respondWithStatus(res, 403, 'Forbidden')
    }
    let blob
    try {
      blob = await HistoryManager.promises.requestBlobWithProjectId(
        projectId,
        hash
      )
    } catch (error) {
      logger.warn({ err: error, projectId, hash }, 'git-bridge blob not found')
      return respondWithStatus(res, 404, 'Not Found')
    }
    res.setHeader('Content-Type', 'application/octet-stream')
    if (Number.isFinite(blob.contentLength)) {
      res.setHeader('Content-Length', String(blob.contentLength))
    }
    const path = stripLeadingSlash(req.query?._path)
    if (path) {
      res.setHeader('X-Blob-Path', encodeURIComponent(path))
    }
    return await pipeline(blob.stream, res)
  }

  return { getDoc, getSavedVers, getSnapshot, postSnapshot, getBlob }
}

export { createHandlers }
export default { createHandlers }
