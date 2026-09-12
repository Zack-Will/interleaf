// Agent edits offered as tracked changes ("suggestions") that a human accepts
// or rejects in the review panel, instead of landing in the document directly.
//
// A suggestion is an ordinary Overleaf tracked change: document-updater records
// it when the update carries `meta.tc`, and the review panel already renders
// `ranges.changes[]` with accept and reject controls.  What this service adds is
// the write path an agent can reach — a whole-document write whose diff is
// tracked — plus reading the pending changes back in a shape an agent can talk
// about, and acting on them when a human explicitly asks.
//
// Everything that talks to document-updater, Mongo or project-history is
// injectable so unit tests and the MCP smoke script can run without any of them.
import logger from '@overleaf/logger'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import UserInfoController from '../../../../app/src/Features/User/UserInfoController.mjs'
import UserInfoManager from '../../../../app/src/Features/User/UserInfoManager.mjs'
import VersionService from '../../../project-sync/app/src/VersionService.mjs'
import WriteService from '../../../project-sync/app/src/WriteService.mjs'
import DocumentUpdaterClient from './DocumentUpdaterClient.mjs'
import ReviewService from './ReviewService.mjs'
import { positionToLineColumn } from './TextPositions.mjs'
import { SuggestionNotFoundError } from './Errors.mjs'

const cleanPath = value => String(value || '').replace(/^\/+/, '')

// A tracked insert carries the text it added, a tracked delete the text it
// took out; the review panel shows both, so both are worth reporting.
function suggestionType(change) {
  if (typeof change.op?.i === 'string') return 'insert'
  if (typeof change.op?.d === 'string') return 'delete'
  return 'unknown'
}

function suggestionText(change) {
  return change.op?.i ?? change.op?.d ?? ''
}

export function createSuggestionService(services = {}) {
  const documentUpdater =
    services.DocumentUpdaterHandler || DocumentUpdaterHandler
  const documentUpdaterClient =
    services.DocumentUpdaterClient || DocumentUpdaterClient
  const projectEntityHandler =
    services.ProjectEntityHandler || ProjectEntityHandler
  const reviewService = services.ReviewService || ReviewService
  const userInfoController = services.UserInfoController || UserInfoController
  const userInfoManager = services.UserInfoManager || UserInfoManager
  const versionService = services.VersionService || VersionService
  const writeService = services.WriteService || WriteService

  async function listDocs(projectId) {
    const docPaths =
      await projectEntityHandler.promises.getAllDocPathsFromProjectById(
        projectId
      )
    return Object.entries(docPaths || {}).map(([docId, pathname]) => ({
      docId,
      path: cleanPath(pathname),
    }))
  }

  // Tracked changes carry only the id of their author, so each distinct one is
  // looked up once per call.  A user we cannot read is still worth reporting by
  // id: the suggestion itself is not in doubt.
  async function loadAuthor(userId) {
    try {
      const user = await userInfoManager.promises.getPersonalInfo(userId)
      const info = userInfoController.formatPersonalInfo(user)
      const name = [info?.first_name, info?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim()
      return { id: userId, ...(name ? { name } : {}) }
    } catch (error) {
      logger.warn(
        { err: error, userId },
        'failed to resolve the author of a tracked change'
      )
      return { id: userId }
    }
  }

  function authorFor(cache, userId) {
    if (userId == null) return Promise.resolve(undefined)
    const key = String(userId)
    if (!cache.has(key)) cache.set(key, loadAuthor(key))
    return cache.get(key)
  }

  /**
   * Replace the content of a document with `lines` so that the diff lands as
   * pending tracked changes attributed to `userId`.
   *
   * The write takes the same project lock and honours the same `baseVersion`
   * precondition as `WriteService.writeFiles`, so a suggestion and a plain
   * write cannot interleave and a stale `base_version` is refused identically.
   * It also follows the same label rule: `message` always travels in the
   * persisted origin, where the history panel shows it, and a label is only
   * created when the caller asks for one by passing `label: true`.
   *
   * @param {string} projectId
   * @param {string} docId
   * @param {string} userId the user the tracked changes are attributed to
   * @param {{lines: string[], agent?: string, message: string,
   *          baseVersion?: number, label?: boolean}} request
   * @return {Promise<{change_ids: string[], version: number,
   *                   label: {id: string, comment: string} | null}>}
   */
  async function suggestDocContent(
    projectId,
    docId,
    userId,
    { lines, agent, message, baseVersion, label = false }
  ) {
    return writeService.promises.withProjectWriteLock(
      projectId,
      baseVersion,
      async () => {
        const { change_ids: changeIds } =
          await documentUpdaterClient.promises.setDocumentTracked(
            projectId,
            docId,
            userId,
            lines,
            { kind: 'mcp', agent, message, suggestion: true }
          )
        const after = await versionService.promises.getLatestVersion(projectId)
        // A write that suggested nothing changed nothing, and a label on an
        // unchanged version would be noise in the history panel.
        const created =
          label && changeIds.length
            ? await writeService.promises.createWriteLabel(
                projectId,
                userId,
                after.version,
                `Suggest: ${message}`
              )
            : null
        return { change_ids: changeIds, version: after.version, label: created }
      }
    )
  }

  /**
   * The pending tracked changes of a project, or of one document, read from the
   * live ranges so that they match what the human sees in the review panel.
   *
   * @param {string} projectId
   * @param {string} [docId] limit to a single document
   * @return {Promise<{files: Array<object>, suggestions: Array<object>,
   *                   count: number}>}
   */
  async function listSuggestions(projectId, docId) {
    const docs = await listDocs(projectId)
    const wanted =
      docId == null
        ? docs
        : docs.filter(doc => String(doc.docId) === String(docId))
    const authors = new Map()
    const files = []
    const suggestions = []
    for (const doc of wanted) {
      const document = await reviewService.getDocRanges(projectId, doc.docId)
      const lines = document?.lines || []
      const changes = document?.ranges?.changes || []
      const entries = []
      for (const change of changes) {
        const position = change.op?.p ?? 0
        const { line, column } = positionToLineColumn(lines, position)
        entries.push({
          change_id: change.id,
          doc_id: doc.docId,
          path: doc.path,
          type: suggestionType(change),
          text: suggestionText(change),
          position,
          line,
          column,
          author: await authorFor(authors, change.metadata?.user_id),
          created_at: change.metadata?.ts,
        })
      }
      if (!entries.length) continue
      entries.sort((left, right) => left.position - right.position)
      files.push({
        path: doc.path,
        doc_id: doc.docId,
        suggestions: entries,
        count: entries.length,
      })
      suggestions.push(...entries)
    }
    files.sort((left, right) => left.path.localeCompare(right.path))
    return { files, suggestions, count: suggestions.length }
  }

  async function pendingChangeIds(projectId, docId) {
    const document = await reviewService.getDocRanges(projectId, docId)
    return (document?.ranges?.changes || []).map(change => String(change.id))
  }

  // `changeIds == null` means every pending change of the document, which is
  // what the `all: true` form of the accept / reject tools asks for.  Ids that
  // are not pending are refused rather than silently ignored, because an agent
  // that passes a stale id is working from a stale reading of the document.
  async function applyToSuggestions(
    apply,
    projectId,
    docId,
    changeIds,
    userId
  ) {
    const pending = await pendingChangeIds(projectId, docId)
    const ids =
      changeIds == null ? pending : changeIds.map(changeId => String(changeId))
    const missing = ids.filter(changeId => !pending.includes(changeId))
    if (missing.length)
      throw new SuggestionNotFoundError(
        `no pending suggestion ${missing.join(', ')} in this document`,
        { projectId, docId, missingChangeIds: missing }
      )
    if (ids.length) await apply(projectId, docId, ids, userId)
    const remaining = ids.length
      ? (await pendingChangeIds(projectId, docId)).length
      : pending.length
    return { change_ids: ids, remaining }
  }

  /**
   * @param {string} projectId
   * @param {string} docId
   * @param {string[]|null} changeIds null accepts every pending suggestion
   * @param {string} userId the human who accepted them
   * @return {Promise<{change_ids: string[], remaining: number}>}
   */
  async function acceptSuggestions(projectId, docId, changeIds, userId) {
    const accept = (...args) => documentUpdater.promises.acceptChanges(...args)
    return applyToSuggestions(accept, projectId, docId, changeIds, userId)
  }

  /**
   * @param {string} projectId
   * @param {string} docId
   * @param {string[]|null} changeIds null rejects every pending suggestion
   * @param {string} userId the human who rejected them
   * @return {Promise<{change_ids: string[], remaining: number}>}
   */
  async function rejectSuggestions(projectId, docId, changeIds, userId) {
    const reject = (...args) => documentUpdater.promises.rejectChanges(...args)
    return applyToSuggestions(reject, projectId, docId, changeIds, userId)
  }

  return {
    suggestDocContent,
    listSuggestions,
    acceptSuggestions,
    rejectSuggestions,
  }
}

const SuggestionService = createSuggestionService()

export default SuggestionService
