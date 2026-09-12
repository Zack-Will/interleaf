// The MCP SDK exposes this file through a package subpath export that the
// repository resolver cannot currently inspect. The import is valid at runtime.
// eslint-disable-next-line import/no-unresolved -- subpath export
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import Settings from '@overleaf/settings'
import { z } from 'zod'
// eslint-disable-next-line import/no-extraneous-dependencies -- diff is a web dependency
import { createTwoFilesPatch } from 'diff'
import {
  AnchorAmbiguousError,
  AnchorNotFoundError,
  FileTooLargeError,
  InvalidEditError,
} from '../../../project-sync/app/src/Errors.mjs'
// Pure helper, safe to import here: it pulls in nothing that talks to a
// database, so the smoke script still runs without one.
import { positionToLineColumn } from '../../../review/app/src/TextPositions.mjs'

function normalizeStructuredContent(data) {
  if (Array.isArray(data)) return { items: data, count: data.length }
  if (data && typeof data === 'object') return data
  return { value: data }
}

function writeSummary(data) {
  const applied = Array.isArray(data.applied) ? data.applied : []
  const failed = Array.isArray(data.failed) ? data.failed : []
  const parts = [
    `${applied.length} file${applied.length === 1 ? '' : 's'} applied`,
  ]
  if (failed.length)
    parts.push(`${failed.length} file${failed.length === 1 ? '' : 's'} failed`)
  const version = data.project_version ?? data.version
  if (version != null) parts.unshift(`project version ${version}`)
  if (data.label?.comment) parts.push(`label: ${data.label.comment}`)
  if (data.code === 'write_failed') parts.unshift('No files were written')
  return parts.join('; ')
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function commentsSummary(data) {
  const hidden = data.resolved_hidden
    ? `; ${data.resolved_hidden} resolved hidden`
    : ''
  return `${plural(data.count, 'comment')}${hidden}`
}

function reviewQueueSummary(data) {
  const parts = [
    `${plural(data.count, 'open comment')} in ${plural(data.files.length, 'file')}`,
  ]
  for (const file of data.files)
    parts.push(`${file.path}: ${plural(file.count, 'comment')}`)
  if (data.detached_count)
    parts.push(
      `${plural(data.detached_count, 'detached comment')}: the commented text is gone, put them back with reanchor_comment`
    )
  // Suggestions still pending mean the human has not acted on the last edits
  // this agent offered, which is a reason not to offer more of the same.
  if (data.pending_suggestions)
    parts.push(
      `${plural(data.pending_suggestions, 'pending suggestion')} nobody has accepted or rejected yet; list_suggestions shows them`
    )
  return parts.join('\n')
}

function suggestEditsSummary(data) {
  const parts = [
    `${plural(data.change_ids.length, 'suggestion')} pending in ${data.path}`,
  ]
  if (data.project_version != null)
    parts.push(`project version ${data.project_version}`)
  if (data.label?.comment) parts.push(`label: ${data.label.comment}`)
  parts.push(
    data.change_ids.length
      ? 'nothing is applied until a human accepts them in the review panel'
      : 'the document already said this, so nothing was suggested'
  )
  return parts.join('; ')
}

function suggestionListSummary(data) {
  const parts = [
    `${plural(data.count, 'pending suggestion')} in ${plural(data.files.length, 'file')}`,
  ]
  for (const file of data.files)
    parts.push(`${file.path}: ${plural(file.suggestions.length, 'suggestion')}`)
  return parts.join('\n')
}

function suggestionActionSummary(data) {
  const verb = data.action === 'accept' ? 'Accepted' : 'Rejected'
  return `${verb} ${plural(data.change_ids.length, 'suggestion')} in ${data.path}; ${plural(data.remaining, 'suggestion')} still pending there`
}

function commentPlacementSummary(data) {
  const action = data.reanchored ? 'Re-anchored' : 'Added'
  const place = `${data.path}:${data.line}:${data.column}`
  return `${action} comment ${data.thread_id} at ${place} as ${data.acted_as}`
}

function commentActionSummary(data) {
  if (data.message_id)
    return `Replied to thread ${data.thread_id} as ${data.acted_as}`
  const state = data.resolved ? 'Resolved' : 'Reopened'
  return `${state} thread ${data.thread_id} as ${data.acted_as}`
}

function summaryText(data) {
  if (Array.isArray(data)) return `${data.length} items`
  if (!data || typeof data !== 'object')
    return String(data ?? 'Operation completed')
  if (Array.isArray(data.projects)) return `${data.count} projects`
  if (Array.isArray(data.entries)) return `${data.count} history entries`
  if (Array.isArray(data.headings)) return `${data.count} headings`
  if (Array.isArray(data.comments)) return commentsSummary(data)
  if (Array.isArray(data.detached) && Array.isArray(data.files))
    return reviewQueueSummary(data)
  if (data.thread_id && data.quoted_text != null)
    return commentPlacementSummary(data)
  if (data.thread_id) return commentActionSummary(data)
  if (Array.isArray(data.matches)) {
    const lines = data.matches
      .slice(0, 39)
      .map(match => `${match.path}:${match.line}: ${match.text}`)
    const heading = `${data.count} matches${data.truncated ? ' (truncated)' : ''}`
    return [heading, ...lines].join('\n')
  }
  if (Array.isArray(data.applied) || Array.isArray(data.failed))
    return writeSummary(data)
  if (Array.isArray(data.diff))
    return `${data.count ?? data.diff.length} diff entries`
  if (Array.isArray(data.branches))
    return `${data.count ?? data.branches.length} branches`
  if (Array.isArray(data.conflicts))
    return data.mergeable
      ? 'Branch merge is clean'
      : `${data.conflicts.length} merge conflicts`
  if (data.path && data.project_version != null)
    return `${data.path}; project version ${data.project_version}; document version ${data.doc_version ?? 'unknown'}`
  if (data.project_id && data.project_version != null) {
    const fileCount = Array.isArray(data.files)
      ? `; ${data.files.length} files`
      : ''
    return `Project ${data.name || data.project_id} at version ${data.project_version}${fileCount}; ${data.permissions || 'read'} access`
  }
  if (data.reverted_from_version != null)
    return `Reverted from version ${data.reverted_from_version} to ${data.reverted_to_version}`
  if (data.project_version != null) {
    const label = data.label?.comment ? `; label: ${data.label.comment}` : ''
    return `Project updated to version ${data.project_version}${label}`
  }
  if (data.message) return data.message
  return 'Operation completed'
}

const textResult = (data, text = summaryText(data)) => ({
  content: [{ type: 'text', text }],
  structuredContent: normalizeStructuredContent(data),
})

function writeResult(data, requestedCount = null) {
  const structured = normalizeStructuredContent(data)
  const applied = Array.isArray(structured.applied) ? structured.applied : []
  const failed = Array.isArray(structured.failed) ? structured.failed : []
  const allFailed =
    (requestedCount != null ? requestedCount > 0 : failed.length > 0) &&
    applied.length === 0
  if (!allFailed) return { isError: false, ...textResult(structured) }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: writeSummary({ ...structured, code: 'write_failed' }),
      },
    ],
    structuredContent: {
      ...structured,
      code: 'write_failed',
      message: 'No files were written and no label was created',
      next_action:
        'Fix the failed files and retry; nothing was written and no label was created',
    },
  }
}

function nextAction(error, next) {
  if (next) return next
  if (error.next_action) return error.next_action
  if (error.code === 'anchor_ambiguous')
    return 're-read the file and pick a unique anchor; candidate_lines lists the matches'
  if (error.code === 'anchor_not_found')
    return 're-read the file and choose an anchor present in the current content'
  if (error.code === 'text_mismatch')
    return 'the document changed under the anchor; re-read the file and retry with the text now at that position (actual_text)'
  return 'check request'
}

// OError keeps constructor properties on `info`, so look in both places.
function errorDetail(error, name) {
  return error[name] ?? error.info?.[name]
}

const errorResult = (error, next) => {
  const candidateLines = errorDetail(error, 'candidateLines')
  const actualText = errorDetail(error, 'actualText')
  return {
    isError: true,
    content: [{ type: 'text', text: error.message || String(error) }],
    structuredContent: {
      code: error.code || 'error',
      message: error.message || String(error),
      ...(error.expectedVersion != null
        ? { expected_version: error.expectedVersion }
        : {}),
      ...(error.actualVersion != null
        ? { actual_version: error.actualVersion }
        : {}),
      ...(candidateLines ? { candidate_lines: candidateLines } : {}),
      ...(actualText != null ? { actual_text: actualText } : {}),
      next_action: nextAction(error, next),
    },
  }
}

function projectId(ref, services) {
  return services.ProjectRef.parse(ref).projectId
}

async function access(services, request, id, level = 'read') {
  return services.ProjectRef.requireAccess(request.syncUser.userId, id, level)
}

function toolError(code, message, next) {
  return Object.assign(new Error(message), { code, next_action: next })
}

const cleanPath = value => String(value || '').replace(/^\/+/, '')

const ELLIPSIS = '...'

function occurrences(text, needle) {
  const positions = []
  let at = text.indexOf(needle)
  while (at >= 0) {
    positions.push(at)
    at = text.indexOf(needle, at + 1)
  }
  return positions
}

function linesOfPositions(text, positions) {
  return positions.map(position => text.slice(0, position).split('\n').length)
}

function resolveExactAnchor(text, exact) {
  const positions = occurrences(text, exact)
  if (!positions.length)
    throw new AnchorNotFoundError('anchor text is not in this document')
  if (positions.length > 1)
    throw new AnchorAmbiguousError('anchor text occurs more than once', {
      candidateLines: linesOfPositions(text, positions),
    })
  return { position: positions[0], text: exact }
}

// The first suffix occurrence that leaves the whole prefix inside the span.
function findSuffixEnd(text, suffix, minimumEnd) {
  let at = text.indexOf(suffix, Math.max(0, minimumEnd - suffix.length))
  while (at >= 0 && at + suffix.length < minimumEnd) {
    at = text.indexOf(suffix, at + 1)
  }
  return at < 0 ? -1 : at + suffix.length
}

// Notion-style "first words...last words": quote the ends of a long passage
// instead of all of it.
function resolveEllipsisAnchor(text, pattern) {
  const separator = pattern.indexOf(ELLIPSIS)
  if (separator < 0) return resolveExactAnchor(text, pattern)
  const prefix = pattern.slice(0, separator)
  const suffix = pattern.slice(separator + ELLIPSIS.length)
  if (!prefix || !suffix)
    throw toolError(
      'invalid_anchor',
      'start_with_ellipsis needs text on both sides of the "..."',
      'pass "first words...last words", or use exact for a short quote'
    )
  const spans = []
  for (const start of occurrences(text, prefix)) {
    const end = findSuffixEnd(text, suffix, start + prefix.length)
    if (end >= 0) spans.push({ position: start, text: text.slice(start, end) })
  }
  if (!spans.length)
    throw new AnchorNotFoundError(
      'no passage starts with the prefix and ends with the suffix'
    )
  if (spans.length > 1)
    throw new AnchorAmbiguousError('more than one passage matches the anchor', {
      candidateLines: linesOfPositions(
        text,
        spans.map(span => span.position)
      ),
    })
  return spans[0]
}

function resolveLineAnchor(lines, anchor) {
  const start = anchor.start_line
  const end = anchor.end_line ?? start
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > lines.length
  )
    throw toolError(
      'invalid_anchor',
      `line range ${start}-${end} is outside a document of ${lines.length} lines`,
      'read the file again and use a 1-based line range within it'
    )
  const position = lines
    .slice(0, start - 1)
    .reduce((total, line) => total + line.length + 1, 0)
  return { position, text: lines.slice(start - 1, end).join('\n') }
}

function anchorKind(anchor) {
  const kinds = []
  if (anchor?.exact != null) kinds.push('exact')
  if (anchor?.start_with_ellipsis != null) kinds.push('ellipsis')
  if (anchor?.start_line != null || anchor?.end_line != null)
    kinds.push('lines')
  if (kinds.length !== 1)
    throw toolError(
      'invalid_anchor',
      'anchor needs exactly one of exact, start_with_ellipsis or start_line/end_line',
      'pass a single anchor form'
    )
  return kinds[0]
}

// Turns an anchor into the character range the comment op needs.  Offsets are
// computed on lines.join('\n'), the same text document-updater holds.
function resolveAnchor(lines, anchor) {
  const text = lines.join('\n')
  const kind = anchorKind(anchor)
  let range
  if (kind === 'exact') range = resolveExactAnchor(text, String(anchor.exact))
  else if (kind === 'ellipsis')
    range = resolveEllipsisAnchor(text, String(anchor.start_with_ellipsis))
  else range = resolveLineAnchor(lines, anchor)
  if (!range.text)
    throw toolError(
      'invalid_anchor',
      'the anchor selects no text',
      'pick an anchor that covers at least one character'
    )
  return range
}

function formatUser(user, fallbackId) {
  const id = user?.id || (user?._id != null ? String(user._id) : fallbackId)
  if (!user) return id ? { id: String(id) } : undefined
  const name = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(' ')
    .trim()
  return { id: id == null ? undefined : String(id), name, email: user.email }
}

function formatMessages(thread) {
  return (thread?.messages || []).map(message => ({
    id: message.id,
    content: message.content,
    timestamp: message.timestamp,
    user: formatUser(message.user, message.user_id),
  }))
}

function commentEntry(doc, lines, comment, thread) {
  const threadId = comment.op?.t || comment.id
  const quotedText = comment.op?.c ?? ''
  const position = comment.op?.p ?? 0
  const messages = formatMessages(thread)
  const { line, column } = positionToLineColumn(lines, position)
  return {
    thread_id: threadId,
    doc_id: doc.docId,
    path: doc.path,
    quoted_text: quotedText,
    detached: quotedText === '',
    position,
    line,
    column,
    resolved: Boolean(thread?.resolved),
    resolved_at: thread?.resolved_at,
    resolved_by: thread?.resolved
      ? formatUser(thread.resolved_by_user, thread.resolved_by_user_id)
      : undefined,
    created_at: messages[0]?.timestamp ?? comment.metadata?.ts,
    author: messages[0]?.user ?? formatUser(null, comment.metadata?.user_id),
    messages,
  }
}

async function listDocs(services, id) {
  const docPaths =
    await services.ProjectEntityHandler.promises.getAllDocPathsFromProjectById(
      id
    )
  return Object.entries(docPaths || {}).map(([docId, pathname]) => ({
    docId,
    path: cleanPath(pathname),
  }))
}

function docNotFoundError(target) {
  return toolError(
    'doc_not_found',
    `no document at ${target}`,
    'call get_project to list the document paths'
  )
}

async function resolveDoc(services, id, path) {
  const target = cleanPath(path)
  const docs = await listDocs(services, id)
  const doc = docs.find(doc => doc.path === target)
  if (!doc) throw docNotFoundError(target)
  return doc
}

// Joins the live comment ranges of every document with the chat threads that
// hold their messages and resolved state.
async function loadProjectComments(services, id, path) {
  const docs = await listDocs(services, id)
  const target = path == null ? null : cleanPath(path)
  const wanted = target ? docs.filter(doc => doc.path === target) : docs
  if (target && !wanted.length) throw docNotFoundError(target)
  const threads = await services.ReviewService.listThreads(id)
  const comments = []
  const linesByPath = new Map()
  // The same ranges carry the pending tracked changes, and counting them here
  // saves reading every document a second time just to say how many there are.
  let suggestionCount = 0
  for (const doc of wanted) {
    const document = await services.ReviewService.getDocRanges(id, doc.docId)
    const lines = document?.lines || []
    linesByPath.set(doc.path, lines)
    suggestionCount += (document?.ranges?.changes || []).length
    for (const comment of document?.ranges?.comments || []) {
      const threadId = comment.op?.t || comment.id
      comments.push(commentEntry(doc, lines, comment, threads?.[threadId]))
    }
  }
  comments.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column
  )
  return { comments, linesByPath, suggestionCount }
}

async function findCommentThread(services, id, threadId) {
  const { comments } = await loadProjectComments(services, id)
  const comment = comments.find(entry => entry.thread_id === threadId)
  if (!comment)
    throw toolError(
      'thread_not_found',
      `no comment thread ${threadId} in this project`,
      'call list_comments to see the threads of this project'
    )
  return comment
}

// The agent posts as its own service user when the token user owns the
// project; otherwise it falls back to the token user and says so.
async function resolveActor(services, id, userId, actAsAgent) {
  if (!actAsAgent || !services.AgentUser)
    return { userId, acted_as: 'token_user' }
  const result = await services.AgentUser.ensureAgentIsCollaborator(id, userId)
  if (result?.ok) return { userId: result.agentUserId, acted_as: 'agent' }
  return { userId, acted_as: 'token_user', reason: result?.reason }
}

// Where the comment ended up, read back from the range document-updater
// returned rather than from what we asked for: the op may have been
// transformed against edits that were in flight.
function commentPlacement(lines, path, result, range, actor, extra = {}) {
  const position = result.comment?.op?.p ?? range.position
  const quotedText = result.comment?.op?.c ?? range.text
  const { line, column } = positionToLineColumn(lines, position)
  return {
    thread_id: result.threadId,
    path,
    position,
    line,
    column,
    quoted_text: quotedText,
    doc_version: result.version,
    acted_as: actor.acted_as,
    ...(actor.reason ? { reason: actor.reason } : {}),
    ...extra,
  }
}

function offsetOfLineIndex(lines, index) {
  let offset = 0
  for (
    let position = 0;
    position < index && position < lines.length;
    position++
  )
    offset += lines[position].length + 1
  return offset
}

// Each structured edit replaces one stretch of the document.  Positions are
// recorded against the document as it stood when that edit ran, so they have
// to be walked back to the document the comments were anchored in, and forward
// to the document the write produced.
function toOriginalPosition(position, earlierChanges, preferEnd) {
  let result = position
  for (let index = earlierChanges.length - 1; index >= 0; index -= 1) {
    const change = earlierChanges[index]
    const newEnd = change.start + change.newText.length
    if (result >= newEnd) result += change.oldLength - change.newText.length
    else if (result > change.start)
      result = preferEnd ? change.start + change.oldLength : change.start
  }
  return result
}

function toFinalPosition(position, laterChanges) {
  let result = position
  for (const change of laterChanges) {
    const oldEnd = change.start + change.oldLength
    if (result >= oldEnd) result += change.newText.length - change.oldLength
    else if (result > change.start) result = change.start
  }
  return result
}

// Only anchor-shaped edits replace a passage a comment could have been on;
// a line range edit still shifts the offsets of the ones around it.
function replacedRegions(changes) {
  return changes
    .map((change, index) => ({
      reanchor: change.reanchor,
      newText: change.newText,
      oldStart: toOriginalPosition(
        change.start,
        changes.slice(0, index),
        false
      ),
      oldEnd: toOriginalPosition(
        change.start + change.oldLength,
        changes.slice(0, index),
        true
      ),
      newStart: toFinalPosition(change.start, changes.slice(index + 1)),
    }))
    .filter(region => region.reanchor)
}

function spanIntersects(comment, region) {
  const start = comment.op?.p ?? 0
  const end = start + (comment.op?.c?.length ?? 0)
  if (start === end) return start >= region.oldStart && start <= region.oldEnd
  return start < region.oldEnd && end > region.oldStart
}

// The comments this write detached, paired with the text that replaced them.
function reanchorTargets(commentsBefore, commentsAffected, target, regions) {
  const detached = new Set(
    (commentsAffected || [])
      .filter(entry => entry.state === 'detached' && entry.path === target)
      .map(entry => entry.thread_id)
  )
  const targets = []
  for (const comment of commentsBefore || []) {
    const threadId = comment.op?.t || comment.id
    if (!detached.has(threadId)) continue
    const region = regions.find(region => spanIntersects(comment, region))
    if (region) targets.push({ threadId, region })
  }
  return targets
}

async function commentSnapshot(services, id, path) {
  if (!services.ReviewService?.reanchorComment) return null
  try {
    const doc = await resolveDoc(services, id, path)
    const document = await services.ReviewService.getDocRanges(id, doc.docId)
    const comments = document?.ranges?.comments || []
    return comments.length ? { docId: doc.docId, comments } : null
  } catch {
    // A project whose comments we cannot read is a project we cannot
    // re-anchor in; the edit itself is unaffected.
    return null
  }
}

// Best effort: a comment we fail to move is reported, never fatal.
async function reanchorDetachedComments(
  services,
  id,
  userId,
  { snapshot, changes, lines, result, path }
) {
  const reanchored = []
  const failed = []
  if (!snapshot || !result?.comments_affected?.length)
    return { reanchored, failed }
  const targets = reanchorTargets(
    snapshot.comments,
    result.comments_affected,
    cleanPath(path),
    replacedRegions(changes)
  )
  for (const { threadId, region } of targets) {
    try {
      const moved = await services.ReviewService.reanchorComment(
        id,
        snapshot.docId,
        userId,
        threadId,
        { position: region.newStart, text: region.newText }
      )
      const position = moved?.comment?.op?.p ?? region.newStart
      const { line, column } = positionToLineColumn(lines, position)
      reanchored.push({ thread_id: threadId, line, column })
    } catch (error) {
      failed.push({
        thread_id: threadId,
        code: error.code || 'error',
        message: error.message || String(error),
      })
    }
  }
  return { reanchored, failed }
}

function contextFor(lines, line, contextLines) {
  const index = line - 1
  return {
    before: lines.slice(Math.max(0, index - contextLines), index),
    line: lines[index] ?? '',
    after: lines.slice(index + 1, index + 1 + contextLines),
  }
}

const editSchema = z.object({
  type: z.string(),
  start_line: z.number().optional(),
  end_line: z.number().optional(),
  new_text: z.string().optional(),
  anchor: z.string().optional(),
  occurrence: z.number().optional(),
  title: z.string().optional(),
  level: z.string().optional(),
})

/**
 * Apply the structured edits of `edit_file` to a document, in order, and
 * report each replacement as a character range of the document as it stood
 * when that edit ran.  `suggest_edits` builds its new content the same way,
 * so the two tools take identical `edits` and behave identically on an
 * ambiguous or missing anchor.
 *
 * @param {string[]} documentLines
 * @param {Array<object>} edits
 * @return {{lines: string[], changes: Array<object>}}
 */
function applyStructuredEdits(documentLines, edits) {
  let lines = [...documentLines]
  const split = text => String(text ?? '').split(/\r\n|\n|\r/)
  const changes = []
  for (const edit of edits) {
    if (edit.type === 'replace_range') {
      const start = edit.start_line
      const end = edit.end_line ?? start
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end > lines.length ||
        end < start - 1
      )
        throw new InvalidEditError('invalid line range')
      const inserting = end < start
      const replacement = split(edit.new_text).join('\n')
      changes.push({
        start: offsetOfLineIndex(lines, start - 1),
        oldLength: inserting
          ? 0
          : lines.slice(start - 1, end).join('\n').length,
        newText: inserting ? `${replacement}\n` : replacement,
        reanchor: false,
      })
      lines.splice(
        start - 1,
        Math.max(0, end - start + 1),
        ...split(edit.new_text)
      )
    } else if (edit.type === 'replace_anchor') {
      const anchor = String(edit.anchor ?? '')
      const text = lines.join('\n')
      const positions = []
      let at = text.indexOf(anchor)
      while (at >= 0) {
        positions.push(at)
        at = text.indexOf(anchor, at + 1)
      }
      if (!positions.length) throw new AnchorNotFoundError()
      const candidateLines = positions.map(
        position => text.slice(0, position).split('\n').length
      )
      if (edit.occurrence != null) {
        const selected = edit.occurrence - 1
        if (selected < 0 || selected >= positions.length)
          throw new AnchorNotFoundError()
        positions.splice(0, positions.length, positions[selected])
      } else if (positions.length > 1) {
        throw new AnchorAmbiguousError('anchor is ambiguous', {
          candidateLines,
        })
      }
      changes.push({
        start: positions[0],
        oldLength: anchor.length,
        newText: String(edit.new_text ?? ''),
        reanchor: true,
      })
      const replacement =
        text.slice(0, positions[0]) +
        String(edit.new_text ?? '') +
        text.slice(positions[0] + anchor.length)
      lines = split(replacement)
    } else if (edit.type === 'replace_section') {
      const levels = [
        'part',
        'chapter',
        'section',
        'subsection',
        'subsubsection',
        'paragraph',
        'subparagraph',
      ]
      const level = edit.level || 'section'
      const levelIndex = levels.indexOf(level)
      if (levelIndex < 0) throw new InvalidEditError('invalid section level')
      const heading = new RegExp(
        '^\\\\(' +
          levels.join('|') +
          ')\\*?\\{' +
          String(edit.title).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') +
          '\\}'
      )
      const start = lines.findIndex(
        line => heading.test(line) && line.match(heading)[1] === level
      )
      if (start < 0) throw new AnchorNotFoundError('section not found')
      let end = lines.length
      for (let index = start + 1; index < lines.length; index += 1) {
        const match = lines[index].match(
          /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{/
        )
        if (match && levels.indexOf(match[1]) <= levelIndex) {
          end = index
          break
        }
        if (/^\\end\{document\}/.test(lines[index])) {
          end = index
          break
        }
      }
      const replacementLines = split(edit.new_text)
      if (!heading.test(replacementLines[0] || ''))
        throw new InvalidEditError(
          'replace_section new_text must include heading'
        )
      changes.push({
        start: offsetOfLineIndex(lines, start),
        oldLength: lines.slice(start, end).join('\n').length,
        newText: replacementLines.join('\n'),
        reanchor: true,
      })
      lines.splice(start, end - start, ...replacementLines)
    } else throw new InvalidEditError(`unknown edit type ${edit.type}`)
  }
  return { lines, changes }
}

// A document that outgrows the limit is refused before anything is written.
function assertDocumentFits(lines, services) {
  const size = lines.reduce((total, line) => total + line.length + 1, 0)
  if (size > (services.settings?.max_doc_length ?? Settings.max_doc_length))
    throw new FileTooLargeError()
}

// Someone else wrote to the project since the caller read it.  The version to
// retry with is the one the project is at now, so say it.
function withVersionConflictHint(error) {
  if (error.code === 'version_conflict')
    error.next_action = `re-read changed files and retry with base_version=${error.actualVersion}`
  return error
}

// The tracked changes a `suggest_edits` call just created, read back from the
// live ranges so their line numbers are the ones the human will see.
async function describeSuggestions(services, id, docId, changeIds) {
  if (!changeIds.length) return []
  const wanted = new Set(changeIds.map(String))
  const { suggestions } = await services.SuggestionService.listSuggestions(
    id,
    docId
  )
  return suggestions
    .filter(suggestion => wanted.has(String(suggestion.change_id)))
    .map(suggestion => ({
      change_id: suggestion.change_id,
      type: suggestion.type,
      line: suggestion.line,
      text: suggestion.text,
    }))
}

// `all: true` is how a caller asks for every pending suggestion of the file
// without listing them first; anything else has to name the ids, so that a
// bare call cannot accept work the human has not seen.
function requestedChangeIds(changeIds, all) {
  if (all) return null
  if (Array.isArray(changeIds) && changeIds.length) return changeIds
  throw toolError(
    'invalid_request',
    'pass change_ids, or all: true to act on every pending suggestion of this file',
    'call list_suggestions to see the pending suggestions and their ids'
  )
}

export function registerTools(
  server,
  { services = {}, req = {}, clientName } = {}
) {
  const userId = req.syncUser?.userId
  const run = async (fn, next) => {
    try {
      return textResult(await fn())
    } catch (error) {
      return errorResult(error, next)
    }
  }
  // `summaryText` picks the human sentence out of the shape of the result,
  // which stops working once two tools answer with the same shape.  The
  // suggestion tools say which sentence they want instead of adding more
  // guesswork to that chain.
  const runSummarised = async (summarise, fn, next) => {
    try {
      const data = await fn()
      return textResult(data, summarise(data))
    } catch (error) {
      return errorResult(error, next)
    }
  }

  server.tool('list_projects', 'List projects', {}, async () =>
    run(async () => {
      const all = await services.ProjectGetter.promises.findAllUsersProjects(
        userId,
        'name lastUpdated'
      )
      const output = []
      for (const [key, projects] of Object.entries(all || {})) {
        for (const project of projects || []) {
          const id = String(project._id || project.id || project.projectId)
          const write =
            key === 'owned' ||
            key === 'readAndWrite' ||
            key === 'tokenReadAndWrite'
          output.push({
            project_id: id,
            url: services.ProjectRef.urlFor(id),
            name: project.name,
            permissions: write ? 'write' : 'read',
          })
        }
      }
      return { projects: output, count: output.length }
    })
  )

  server.tool(
    'get_project',
    'Get project metadata',
    { project: z.string() },
    async ({ project }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id)
        const projectData = await services.ProjectGetter.promises.getProject(
          id,
          {
            name: 1,
            rootDoc_id: 1,
          }
        )
        const tree = await services.SnapshotService.getFileTree(id)
        const version = await services.VersionService.getLatestVersion(id)
        let permissions = 'read'
        try {
          await services.ProjectRef.requireAccess(userId, id, 'write')
          permissions = 'write'
        } catch (error) {
          if (error?.code === 'not_found') throw error
        }
        let root
        if (projectData?.rootDoc_id) {
          try {
            const paths =
              await services.ProjectEntityHandler.promises.getAllDocPathsFromProjectById(
                id
              )
            root =
              paths[String(projectData.rootDoc_id)] ||
              paths[projectData.rootDoc_id]
          } catch {}
        }
        root ||= tree.find(file => file.kind === 'doc')?.path
        return {
          project_id: id,
          url: services.ProjectRef.urlFor(id),
          name: projectData?.name,
          root_doc_path: root,
          project_version: version.version,
          permissions,
          files: tree,
        }
      })
  )

  server.tool(
    'read_file',
    'Read a text file',
    {
      project: z.string(),
      path: z.string(),
      start_line: z.number().optional(),
      end_line: z.number().optional(),
    },
    async ({ project, path, start_line, end_line }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id)
        const document = await services.SnapshotService.readDoc(id, path, {
          startLine: start_line,
          endLine: end_line,
        })
        const lines = document.lines
          .map((line, index) => `${(start_line || 1) + index}: ${line}`)
          .join('\n')
        const latest = await services.VersionService.getLatestVersion(id)
        return {
          path: document.path,
          content: lines,
          lines: document.lines,
          project_version: latest.version,
          doc_version: document.docVersion,
          sha256: document.sha256,
          total_lines: document.totalLines,
        }
      })
  )

  server.tool(
    'get_outline',
    'Get LaTeX outline',
    { project: z.string(), path: z.string().optional() },
    async ({ project, path }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id)
        const tree = await services.SnapshotService.getFileTree(id)
        const root = path || tree.find(file => file.kind === 'doc')?.path
        const documents = []
        if (root) documents.push(root)
        if (!path && root) {
          const rootDocument = await services.SnapshotService.readDoc(
            id,
            root,
            {}
          )
          for (const line of rootDocument.lines) {
            const match = line.match(/\\(?:input|include)\{([^}]+)\}/)
            if (match) {
              documents.push(
                match[1].endsWith('.tex') ? match[1] : `${match[1]}.tex`
              )
            }
          }
        }
        const output = []
        for (const documentPath of documents) {
          try {
            const document = await services.SnapshotService.readDoc(
              id,
              documentPath,
              {}
            )
            document.lines.forEach((line, index) => {
              const match = line.match(
                /^\s*\\(part|chapter|section|subsection|subsubsection)\*?\{([^}]*)\}/
              )
              if (match) {
                output.push({
                  path: documentPath,
                  line: index + 1,
                  level: match[1],
                  title: match[2],
                })
              }
            })
          } catch {}
        }
        return { headings: output, count: output.length }
      })
  )

  server.tool(
    'search',
    'Search project files',
    {
      project: z.string(),
      query: z.string(),
      regex: z.boolean().optional(),
      max_results: z.number().optional(),
    },
    async ({ project, query, regex, max_results = 50 }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id)
        const tree = await services.SnapshotService.getFileTree(id)
        const expression = regex ? new RegExp(query) : null
        const output = []
        let totalMatches = 0
        for (const file of tree.filter(item => item.kind === 'doc')) {
          const document = await services.SnapshotService.readDoc(
            id,
            file.path,
            {}
          )
          document.lines.forEach((text, index) => {
            if (expression ? expression.test(text) : text.includes(query)) {
              totalMatches += 1
              if (output.length < max_results)
                output.push({ path: file.path, line: index + 1, text })
            }
          })
        }
        return {
          matches: output,
          count: totalMatches,
          truncated: totalMatches > output.length,
        }
      })
  )

  server.tool(
    'list_history',
    'List project history',
    { project: z.string(), limit: z.number().optional() },
    async ({ project, limit = 50 }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id)
        const labels = await services.LabelService.listLabels(id)
        const updatesResponse = await services.fetchJson(
          `${services.settings.apis.project_history.url}/project/${id}/updates?min_count=${limit}`
        )
        const updates = Array.isArray(updatesResponse)
          ? updatesResponse
          : updatesResponse?.updates || []
        const normalizedLabels = (labels || []).map(label => ({
          type: 'label',
          version: label.version,
          comment: label.comment,
          user: label.user || label.user_id,
          created_at: label.created_at || label.createdAt || label.timestamp,
        }))
        const normalizedUpdates = updates.map(update => ({
          type: 'update',
          from_version: update.from_version ?? update.fromVersion,
          to_version: update.to_version ?? update.toVersion,
          origin: update.origin,
          users: update.users || (update.user_id ? [update.user_id] : []),
          timestamp: update.timestamp,
          pathnames: update.pathnames || update.paths,
        }))
        const entries = [...normalizedLabels, ...normalizedUpdates]
          .sort(
            (left, right) =>
              new Date(right.created_at || right.timestamp || 0) -
              new Date(left.created_at || left.timestamp || 0)
          )
          .slice(0, limit)
        return { entries, count: entries.length }
      })
  )

  server.tool(
    'diff',
    'Compare project versions',
    {
      project: z.string(),
      from_version: z.number(),
      to_version: z.number(),
      path: z.string().optional(),
    },
    async ({ project, from_version, to_version, path }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id)
        const url = path
          ? `${services.settings.apis.project_history.url}/project/${id}/diff?pathname=${encodeURIComponent(path)}&from=${from_version}&to=${to_version}`
          : `${services.settings.apis.project_history.url}/project/${id}/filetree/diff?from=${from_version}&to=${to_version}`
        const result = await services.fetchJson(url)
        return Array.isArray(result)
          ? { diff: result, count: result.length }
          : result
      })
  )

  server.tool(
    'write_files',
    'Write project files',
    {
      project: z.string(),
      message: z.string(),
      files: z.array(
        z.object({
          path: z.string(),
          content: z.string().optional(),
          contentBase64: z.string().optional(),
          delete: z.boolean().optional(),
        })
      ),
      base_version: z.number().optional(),
      agent: z.string().optional(),
    },
    async ({ project, message, files, base_version, agent }) => {
      try {
        const id = projectId(project, services)
        await access(services, req, id, 'write')
        const result = await services.WriteService.writeFiles(id, userId, {
          baseVersion: base_version,
          message,
          agent: agent || clientName || 'mcp',
          files,
        })
        return writeResult(result, files.length)
      } catch (error) {
        return errorResult(
          error,
          error.code === 'version_conflict'
            ? `re-read changed files and retry with base_version=${error.actualVersion}`
            : undefined
        )
      }
    }
  )
  server.tool(
    'revert_to',
    'Revert a project or file to a historical version',
    {
      project: z.string(),
      version: z.number().int().nonnegative(),
      path: z.string().optional(),
      message: z.string().optional(),
      agent: z.string().optional(),
    },
    async ({ project, version, path, message, agent }) => {
      try {
        const id = projectId(project, services)
        const result = await services.RevertService.revertTo(id, userId, {
          version,
          path,
          message,
          agent: agent || clientName || 'mcp',
        })
        return writeResult(result)
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.tool(
    'edit_file',
    'Apply structured edits to a text document',
    {
      project: z.string(),
      path: z.string(),
      base_version: z.number().int().nonnegative(),
      edits: z.array(editSchema),
      message: z.string(),
      agent: z.string().optional(),
    },
    async ({ project, path, base_version, edits, message, agent }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id, 'write')
        const document = await services.SnapshotService.readDoc(id, path)
        const { lines, changes } = applyStructuredEdits(document.lines, edits)
        assertDocumentFits(lines, services)
        const before = document.lines.join('\n')
        const content = lines.join('\n')
        // Snapshot the comment ranges the write is about to transform, so the
        // ones it detaches can be put back on the replacement text.  Never let
        // this stop the edit.
        const snapshot = await commentSnapshot(services, id, path)
        let result
        try {
          result = await services.WriteService.writeFiles(id, userId, {
            baseVersion: base_version,
            message,
            agent: agent || clientName || 'mcp',
            files: [{ path, content }],
          })
        } catch (error) {
          throw withVersionConflictHint(error)
        }
        const { reanchored, failed } = await reanchorDetachedComments(
          services,
          id,
          userId,
          { snapshot, changes, lines, result, path }
        )
        return {
          path,
          project_version: result.version,
          label: result.label,
          comments_affected: result.comments_affected,
          ...(reanchored.length ? { reanchored } : {}),
          ...(failed.length ? { reanchor_failed: failed } : {}),
          diff: createTwoFilesPatch(path, path, before, content),
        }
      })
  )

  server.tool(
    'create_branch',
    'Create a project branch',
    { project: z.string(), name: z.string() },
    async ({ project, name }) =>
      run(async () => {
        const id = projectId(project, services)
        return services.BranchService.createBranch(id, userId, { name })
      })
  )

  server.tool(
    'list_branches',
    'List project branches',
    { project: z.string() },
    async ({ project }) =>
      run(async () => {
        const id = projectId(project, services)
        return services.BranchService.listBranches(id, userId)
      })
  )

  server.tool(
    'diff_branch',
    'Compare a branch with its parent',
    { branch: z.string() },
    async ({ branch }) =>
      run(async () => {
        const id = projectId(branch, services)
        return services.BranchService.diffBranch(id, userId)
      })
  )

  server.tool(
    'merge_branch',
    'Merge a branch into its parent',
    {
      branch: z.string(),
      dry_run: z.boolean().optional(),
      message: z.string().optional(),
      agent: z.string().optional(),
    },
    async ({ branch, dry_run = true, message, agent }) => {
      try {
        const id = projectId(branch, services)
        const result = await services.BranchService.mergeBranch(id, userId, {
          dryRun: dry_run,
          message,
          agent: agent || clientName || 'mcp',
        })
        return { isError: false, ...textResult(result) }
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.tool(
    'archive_branch',
    'Archive a project branch',
    { branch: z.string() },
    async ({ branch }) =>
      run(async () => {
        const id = projectId(branch, services)
        return services.BranchService.archiveBranch(id, userId)
      })
  )

  server.tool(
    'list_comments',
    'List review comments with their anchored text and messages',
    {
      project: z.string(),
      path: z.string().optional(),
      include_resolved: z.boolean().optional(),
    },
    async ({ project, path, include_resolved = false }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id)
        const { comments } = await loadProjectComments(services, id, path)
        const visible = include_resolved
          ? comments
          : comments.filter(comment => !comment.resolved)
        return {
          comments: visible,
          count: visible.length,
          resolved_hidden: comments.length - visible.length,
        }
      })
  )

  server.tool(
    'get_review_queue',
    'List the unresolved comments of a project with their surrounding lines',
    { project: z.string(), context_lines: z.number().int().optional() },
    async ({ project, context_lines = 3 }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id)
        const { comments, linesByPath, suggestionCount } =
          await loadProjectComments(services, id, undefined)
        const open = comments.filter(comment => !comment.resolved)
        const files = []
        const detached = []
        for (const comment of open) {
          if (comment.detached) {
            detached.push(comment)
            continue
          }
          const lines = linesByPath.get(comment.path) || []
          const entry = {
            ...comment,
            context: contextFor(lines, comment.line, context_lines),
          }
          const file = files.find(item => item.path === comment.path)
          if (file) file.comments.push(entry)
          else files.push({ path: comment.path, comments: [entry] })
        }
        for (const file of files) file.count = file.comments.length
        return {
          files,
          count: open.length - detached.length,
          detached,
          detached_count: detached.length,
          pending_suggestions: suggestionCount,
        }
      })
  )

  server.tool(
    'reply_comment',
    'Reply to a review comment thread',
    {
      project: z.string(),
      thread_id: z.string(),
      content: z.string(),
      act_as_agent: z.boolean().optional(),
    },
    async ({ project, thread_id, content, act_as_agent = true }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id, 'write')
        const comment = await findCommentThread(services, id, thread_id)
        const actor = await resolveActor(services, id, userId, act_as_agent)
        const message = await services.ReviewService.sendComment(
          id,
          thread_id,
          actor.userId,
          content
        )
        return {
          thread_id,
          path: comment.path,
          message_id: message?.id,
          acted_as: actor.acted_as,
          ...(actor.reason ? { reason: actor.reason } : {}),
        }
      })
  )

  const threadStateTool = (name, description, resolved) =>
    server.tool(
      name,
      description,
      {
        project: z.string(),
        thread_id: z.string(),
        act_as_agent: z.boolean().optional(),
      },
      async ({ project, thread_id, act_as_agent = true }) =>
        run(async () => {
          const id = projectId(project, services)
          await access(services, req, id, 'write')
          const comment = await findCommentThread(services, id, thread_id)
          const actor = await resolveActor(services, id, userId, act_as_agent)
          const apply = resolved
            ? services.ReviewService.resolveThread
            : services.ReviewService.reopenThread
          await apply(id, comment.doc_id, thread_id, actor.userId)
          return {
            thread_id,
            path: comment.path,
            resolved,
            acted_as: actor.acted_as,
            ...(actor.reason ? { reason: actor.reason } : {}),
          }
        })
    )

  threadStateTool('resolve_comment', 'Resolve a review comment thread', true)
  threadStateTool('reopen_comment', 'Reopen a review comment thread', false)

  const anchorSchema = z.object({
    exact: z.string().optional(),
    start_with_ellipsis: z.string().optional(),
    start_line: z.number().int().optional(),
    end_line: z.number().int().optional(),
  })

  server.tool(
    'add_comment',
    'Anchor a new review comment to a passage of a document',
    {
      project: z.string(),
      path: z.string(),
      anchor: anchorSchema,
      content: z.string(),
      act_as_agent: z.boolean().optional(),
    },
    async ({ project, path, anchor, content, act_as_agent = true }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id, 'write')
        const doc = await resolveDoc(services, id, path)
        const document = await services.ReviewService.getDocRanges(
          id,
          doc.docId
        )
        const lines = document?.lines || []
        const range = resolveAnchor(lines, anchor)
        const actor = await resolveActor(services, id, userId, act_as_agent)
        const result = await services.ReviewService.createComment(
          id,
          doc.docId,
          actor.userId,
          { position: range.position, text: range.text, content }
        )
        return commentPlacement(lines, doc.path, result, range, actor, {
          doc_id: doc.docId,
          message_id: result.message?.id,
        })
      })
  )

  server.tool(
    'reanchor_comment',
    'Move a detached or drifted review comment onto new text',
    {
      project: z.string(),
      thread_id: z.string(),
      path: z.string(),
      anchor: anchorSchema,
      act_as_agent: z.boolean().optional(),
    },
    async ({ project, thread_id, path, anchor, act_as_agent = true }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id, 'write')
        const doc = await resolveDoc(services, id, path)
        const document = await services.ReviewService.getDocRanges(
          id,
          doc.docId
        )
        const lines = document?.lines || []
        const range = resolveAnchor(lines, anchor)
        const actor = await resolveActor(services, id, userId, act_as_agent)
        const result = await services.ReviewService.reanchorComment(
          id,
          doc.docId,
          actor.userId,
          thread_id,
          { position: range.position, text: range.text }
        )
        return commentPlacement(lines, doc.path, result, range, actor, {
          doc_id: doc.docId,
          reanchored: true,
        })
      })
  )

  server.tool(
    'suggest_edits',
    'Offer structured edits to a document as tracked changes a human accepts or rejects, instead of writing them straight into the document',
    {
      project: z.string(),
      path: z.string(),
      base_version: z.number().int().nonnegative(),
      edits: z.array(editSchema),
      message: z.string(),
      agent: z.string().optional(),
      act_as_agent: z.boolean().optional(),
    },
    async ({
      project,
      path,
      base_version,
      edits,
      message,
      agent,
      act_as_agent = true,
    }) =>
      runSummarised(suggestEditsSummary, async () => {
        const id = projectId(project, services)
        await access(services, req, id, 'write')
        const doc = await resolveDoc(services, id, path)
        const document = await services.SnapshotService.readDoc(id, path)
        const { lines } = applyStructuredEdits(document.lines, edits)
        assertDocumentFits(lines, services)
        const before = document.lines.join('\n')
        const content = lines.join('\n')
        const actor = await resolveActor(services, id, userId, act_as_agent)
        let result
        try {
          result = await services.SuggestionService.suggestDocContent(
            id,
            doc.docId,
            actor.userId,
            {
              lines,
              agent: agent || clientName || 'mcp',
              message,
              baseVersion: base_version,
            }
          )
        } catch (error) {
          throw withVersionConflictHint(error)
        }
        return {
          path: doc.path,
          doc_id: doc.docId,
          project_version: result.version,
          label: result.label,
          change_ids: result.change_ids,
          suggestions: await describeSuggestions(
            services,
            id,
            doc.docId,
            result.change_ids
          ),
          acted_as: actor.acted_as,
          ...(actor.reason ? { reason: actor.reason } : {}),
          diff: createTwoFilesPatch(path, path, before, content),
        }
      })
  )

  server.tool(
    'list_suggestions',
    'List the tracked changes waiting for someone to accept or reject them',
    { project: z.string(), path: z.string().optional() },
    async ({ project, path }) =>
      runSummarised(suggestionListSummary, async () => {
        const id = projectId(project, services)
        await access(services, req, id)
        const doc = path == null ? null : await resolveDoc(services, id, path)
        const { files, count } =
          await services.SuggestionService.listSuggestions(id, doc?.docId)
        return { files, count }
      })
  )

  // Accepting and rejecting is the human's decision, so these act as the user
  // whose token the agent is using, never as the agent service user.
  const suggestionActionTool = (name, description, action) =>
    server.tool(
      name,
      description,
      {
        project: z.string(),
        path: z.string(),
        change_ids: z.array(z.string()).optional(),
        all: z.boolean().optional(),
      },
      async ({ project, path, change_ids, all = false }) =>
        runSummarised(suggestionActionSummary, async () => {
          const id = projectId(project, services)
          await access(services, req, id, 'write')
          const doc = await resolveDoc(services, id, path)
          const ids = requestedChangeIds(change_ids, all)
          const result =
            action === 'accept'
              ? await services.SuggestionService.acceptSuggestions(
                  id,
                  doc.docId,
                  ids,
                  userId
                )
              : await services.SuggestionService.rejectSuggestions(
                  id,
                  doc.docId,
                  ids,
                  userId
                )
          return {
            action,
            path: doc.path,
            doc_id: doc.docId,
            change_ids: result.change_ids,
            remaining: result.remaining,
          }
        })
    )

  suggestionActionTool(
    'accept_suggestions',
    'Accept tracked changes, applying them to the document',
    'accept'
  )
  suggestionActionTool(
    'reject_suggestions',
    'Reject tracked changes, undoing them',
    'reject'
  )

  return server
}

export function createMcpServer(options = {}) {
  const server = new McpServer({ name: 'overleaf-mcp', version: '1.0.0' })
  registerTools(server, options)
  return server
}
