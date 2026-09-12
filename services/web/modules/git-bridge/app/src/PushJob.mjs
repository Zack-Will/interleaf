import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import nodePath from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'

// git-bridge waits 360 seconds for the postback before giving up, so the whole
// job has to be finished well inside that window.
const PUSH_JOB_TIMEOUT_MS = 6 * 60 * 1000
const POSTBACK_TIMEOUT_MS = 30 * 1000
const DOWNLOAD_CONCURRENCY = 4
const WRITE_MESSAGE = 'Update from Git'

const stripLeadingSlash = path => String(path || '').replace(/^\/+/, '')

function cleanPath(SafePath, path) {
  return path
    .split('/')
    .map(element => (element === '' ? element : SafePath.clean(element)))
    .join('/')
}

/**
 * Build the push job runner. Every collaborator is injected so that the job can
 * be unit tested without Mongo, Redis or a git-bridge container.
 *
 * @param {object} services
 * @returns {(job: object) => Promise<object>} resolves with the posted body
 */
function createPushJob(services) {
  const {
    SnapshotService,
    WriteService,
    SafePath,
    fetchStream,
    fetchNothing,
    settings,
    logger,
  } = services

  function findInvalidFiles(files) {
    const invalid = []
    for (const file of files) {
      const name = stripLeadingSlash(file.name)
      if (name === '') {
        invalid.push({ file: String(file.name ?? ''), state: 'error' })
        continue
      }
      if (SafePath.isCleanPath(name)) continue
      invalid.push({
        file: name,
        state: 'unclean_name',
        cleanFile: cleanPath(SafePath, name),
      })
    }
    return invalid
  }

  async function downloadFile(projectId, file, signal, tempPaths) {
    const fsPath = nodePath.join(
      settings.path.dumpFolder,
      `${projectId}_${crypto.randomUUID()}_git-bridge`
    )
    tempPaths.push(fsPath)
    const stream = await fetchStream(file.url, { signal })
    await pipeline(stream, createWriteStream(fsPath))
    const content = await fs.readFile(fsPath)
    return {
      path: stripLeadingSlash(file.name),
      contentBase64: content.toString('base64'),
    }
  }

  async function downloadChangedFiles(projectId, files, signal, tempPaths) {
    const changed = files.filter(file => file.url)
    const downloaded = []
    for (let index = 0; index < changed.length; index += DOWNLOAD_CONCURRENCY) {
      const batch = changed.slice(index, index + DOWNLOAD_CONCURRENCY)
      downloaded.push(
        ...(await Promise.all(
          batch.map(file => downloadFile(projectId, file, signal, tempPaths))
        ))
      )
    }
    return downloaded
  }

  async function buildDeletes(projectId, files) {
    const kept = new Set(files.map(file => stripLeadingSlash(file.name)))
    const tree = await SnapshotService.promises.getFileTree(projectId)
    return tree
      .map(entry => stripLeadingSlash(entry.path))
      .filter(path => !kept.has(path))
      .map(path => ({ path, delete: true }))
  }

  async function postback(postbackUrl, body) {
    try {
      await fetchNothing(postbackUrl, {
        method: 'POST',
        json: body,
        signal: AbortSignal.timeout(POSTBACK_TIMEOUT_MS),
      })
    } catch (error) {
      logger.error(
        { err: error, postbackUrl, code: body.code },
        'git-bridge postback failed'
      )
    }
    return body
  }

  function describeFailure(error) {
    if (error?.code === 'version_conflict') {
      return { code: 'outOfDate', message: 'Out of Date' }
    }
    return { code: 'error', message: error?.message || 'push failed' }
  }

  /**
   * Apply one git push and tell git-bridge how it went.
   *
   * @param {{projectId: string, userId: string, latestVerId: number,
   *          files: Array<object>, postbackUrl: string}} job
   */
  async function runPushJob(job) {
    const { projectId, userId, latestVerId, files, postbackUrl } = job
    const invalid = findInvalidFiles(files)
    if (invalid.length > 0) {
      return await postback(postbackUrl, {
        code: 'invalidFiles',
        errors: invalid,
      })
    }

    const tempPaths = []
    const signal = AbortSignal.timeout(PUSH_JOB_TIMEOUT_MS)
    try {
      const changed = await downloadChangedFiles(
        projectId,
        files,
        signal,
        tempPaths
      )
      const deletes = await buildDeletes(projectId, files)
      const result = await WriteService.promises.writeFiles(projectId, userId, {
        baseVersion: latestVerId,
        message: WRITE_MESSAGE,
        originKind: 'git-bridge',
        files: [...changed, ...deletes],
      })
      if (result.failed?.length > 0) {
        return await postback(postbackUrl, {
          code: 'invalidFiles',
          errors: result.failed.map(failure => ({
            file: failure.path,
            state: 'error',
          })),
        })
      }
      return await postback(postbackUrl, {
        code: 'upToDate',
        latestVerId: Number(result.version),
      })
    } catch (error) {
      logger.error({ err: error, projectId }, 'git-bridge push job failed')
      return await postback(postbackUrl, describeFailure(error))
    } finally {
      await Promise.all(tempPaths.map(path => fs.unlink(path).catch(() => {})))
    }
  }

  return runPushJob
}

export {
  createPushJob,
  PUSH_JOB_TIMEOUT_MS,
  DOWNLOAD_CONCURRENCY,
  WRITE_MESSAGE,
}
export default { createPushJob }
