import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import LockManager from '../../../../app/src/infrastructure/LockManager.mjs'
import UpdateMerger from '../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import VersionService from './VersionService.mjs'
import LabelService from './LabelService.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import { VersionConflictError } from './Errors.mjs'

const clean = value => String(value || '').replace(/^\/+/, '')

function threadIdOf(comment) {
  return comment.op?.t || comment.id
}

function docLines(document) {
  return Array.isArray(document.lines)
    ? document.lines
    : String(document.lines || '').split(/\r\n|\n|\r/)
}

function findDocId(docs, target) {
  const entry = Object.entries(docs || {}).find(
    ([, pathname]) => clean(pathname) === target
  )
  return entry ? entry[0] : null
}

// Comment ranges are transformed by the editing operations our write produces,
// so an agent needs to know which of them moved, changed size or lost their
// text entirely.  `moved` also covers a range that kept its length but now
// spans different text.
function commentState(before, after) {
  if (!after) return 'detached'
  const beforeText = before.op?.c ?? ''
  const afterText = after.op?.c ?? ''
  if (afterText === '' && beforeText !== '') return 'detached'
  if (afterText.length > beforeText.length) return 'grown'
  if (afterText.length < beforeText.length) return 'shrunk'
  if ((after.op?.p ?? 0) !== (before.op?.p ?? 0) || afterText !== beforeText)
    return 'moved'
  return 'unchanged'
}

function compareComments(target, before, after) {
  const afterByThread = new Map(
    (after || []).map(comment => [threadIdOf(comment), comment])
  )
  return (before || []).map(comment => ({
    thread_id: threadIdOf(comment),
    path: target,
    state: commentState(comment, afterByThread.get(threadIdOf(comment))),
  }))
}

async function loadDocument(projectId, docId, target) {
  try {
    return await DocumentUpdaterHandler.promises.getDocument(
      projectId,
      docId,
      -1
    )
  } catch (error) {
    logger.warn(
      { err: error, projectId, path: target },
      'failed to load project document for comment tracking'
    )
    return null
  }
}

/**
 * Every agent-facing write to a project goes through the same gate: one lock
 * per project so that two writes cannot interleave, and inside it the
 * `base_version` precondition, checked against the version the history has
 * *after* the flush that `getLatestVersion` performs.  `SuggestionService`
 * writes tracked changes rather than files, but it has to serialise against
 * plain writes and answer a stale `base_version` the same way, so it borrows
 * this helper instead of repeating it.
 *
 * @param {string} projectId
 * @param {number|string|null|undefined} baseVersion
 * @param {(current: {version: number}) => Promise<any>} run
 * @return {Promise<any>}
 */
async function withProjectWriteLock(projectId, baseVersion, run) {
  return LockManager.promises.runWithLock(
    'project-sync',
    projectId,
    async () => {
      const current = await VersionService.promises.getLatestVersion(projectId)
      if (
        baseVersion != null &&
        String(current.version) !== String(baseVersion)
      )
        throw new VersionConflictError('project version conflict', {
          expectedVersion: baseVersion,
          actualVersion: current.version,
        })
      return run(current)
    }
  )
}

/**
 * The history label a write leaves behind when it was asked for one, in the
 * shape the MCP tools return it.  The labels API echoes back the stored
 * document, which names the id `_id`, and older project-history builds answer
 * without the comment.
 *
 * @param {string} projectId
 * @param {string} userId
 * @param {number} version
 * @param {string} comment
 * @return {Promise<{id: string, comment: string}>}
 */
async function createWriteLabel(projectId, userId, version, comment) {
  const label = await LabelService.promises.createLabel(
    projectId,
    userId,
    version,
    comment
  )
  return { id: label.id ?? label._id, comment: label.comment ?? comment }
}

/**
 * Apply a batch of file writes to a project, atomically with respect to other
 * agent writes.
 *
 * An Overleaf label is a milestone — a "saved version" a human picked out of
 * the timeline, and the commit the git-bridge exposes — so a write does not
 * leave one behind by default.  The intent of the change travels in the
 * persisted origin instead, where the history panel shows it under the author
 * line.  Callers that really are marking a milestone (a revert, a branch
 * merge, or an agent that asked for it) pass `label: true`.
 *
 * @param {string} projectId
 * @param {string} userId
 * @param {{baseVersion?: number|string, message: string, agent?: string,
 *          files?: Array<object>, originExtra?: object, originKind?: string,
 *          label?: boolean}} request
 * @return {Promise<object>}
 */
async function writeFiles(
  projectId,
  userId,
  {
    baseVersion,
    message,
    agent,
    files = [],
    originExtra = {},
    originKind = 'mcp',
    label = false,
  }
) {
  return withProjectWriteLock(projectId, baseVersion, async () => {
    const origin = { ...originExtra, kind: originKind, agent, message }
    const applied = []
    const failed = []
    const unchanged = []
    const tempPaths = []
    const commentsAffected = []
    try {
      let docs
      const hasDocCandidates = files.some(
        item => !item.delete && item.contentBase64 == null
      )
      if (hasDocCandidates) {
        try {
          ;[, docs] = await Promise.all([
            ProjectEntityHandler.promises.getAllEntities(projectId),
            ProjectEntityHandler.promises.getAllDocPathsFromProjectById(
              projectId
            ),
          ])
        } catch (error) {
          logger.warn(
            { err: error, projectId },
            'failed to load project entities for unchanged detection'
          )
        }
      }
      for (const item of files) {
        const target = clean(item.path)
        // Only text documents carry comment ranges, and only they can be
        // compared against their current content.
        const docId =
          !item.delete && item.contentBase64 == null
            ? findDocId(docs, target)
            : null
        let commentsBefore = []
        try {
          if (docId) {
            const document = await loadDocument(projectId, docId, target)
            if (document) {
              if (
                docLines(document).join('\n') === String(item.content ?? '')
              ) {
                unchanged.push(target)
                continue
              }
              commentsBefore = document.ranges?.comments || []
            }
          }
          if (item.delete) {
            const entities =
              await ProjectEntityHandler.promises.getAllEntities(projectId)
            const exists = [
              ...(entities.docs || []),
              ...(entities.files || []),
            ].some(entity => String(entity.path).replace(/^\/+/, '') === target)
            if (!exists) {
              unchanged.push(target)
              continue
            }
            await UpdateMerger.promises.deleteUpdate(
              userId,
              projectId,
              '/' + target,
              origin
            )
            const ents =
              await ProjectEntityHandler.promises.getAllEntities(projectId)
            if (
              [...(ents.docs || []), ...(ents.files || [])].some(
                e => String(e.path).replace(/^\/+/, '') === target
              )
            )
              throw new Error('delete failed: path still exists')
          } else {
            const content =
              item.contentBase64 != null
                ? Buffer.from(item.contentBase64, 'base64')
                : Buffer.from(String(item.content ?? ''), 'utf8')
            const fsPath = path.join(
              Settings.path.dumpFolder,
              `${projectId}_${crypto.randomUUID()}_project-sync`
            )
            tempPaths.push(fsPath)
            await fs.writeFile(fsPath, content)
            await UpdateMerger.promises._mergeUpdate(
              userId,
              projectId,
              '/' + target,
              fsPath,
              origin
            )
          }
          applied.push(target)
          if (commentsBefore.length) {
            const document = await loadDocument(projectId, docId, target)
            // A failed read is not evidence that the comments went away.
            if (document)
              commentsAffected.push(
                ...compareComments(
                  target,
                  commentsBefore,
                  document.ranges?.comments || []
                )
              )
          }
        } catch (error) {
          failed.push({ path: target, error: error.message })
        }
      }
      const after = await VersionService.promises.getLatestVersion(projectId)
      if (applied.length === 0) {
        return {
          version: after.version,
          label: null,
          applied,
          ...(files.length ? { unchanged } : {}),
          failed,
          comments_affected: commentsAffected,
        }
      }
      const labelComment = originExtra.revert
        ? `${message} (reverted from ${originExtra.revert.from} to ${originExtra.revert.to})`
        : message
      const created = label
        ? await createWriteLabel(projectId, userId, after.version, labelComment)
        : null
      return {
        version: after.version,
        label: created,
        applied,
        unchanged,
        failed,
        comments_affected: commentsAffected,
      }
    } finally {
      await Promise.all(tempPaths.map(p => fs.unlink(p).catch(() => {})))
    }
  })
}
export { writeFiles, withProjectWriteLock, createWriteLabel }
export default {
  writeFiles,
  withProjectWriteLock,
  createWriteLabel,
  promises: { writeFiles, withProjectWriteLock, createWriteLabel },
}
