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
} from '../../../project-sync/app/src/Errors.mjs'
// Pure helper, safe to import here: it pulls in nothing that talks to a
// database, so the smoke script still runs without one.
import { positionToLineColumn } from '../../../review/app/src/TextPositions.mjs'
import {
  applyStructuredEdits,
  EDITS_DESCRIPTION,
  editsSchema,
} from './StructuredEdits.mjs'

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
  // Individual edits no longer leave a label behind, so the agent has to be
  // told where the milestone of a review round belongs.
  parts.push(
    'When a review round is complete, call create_label to mark it as a saved version.'
  )
  return parts.join('\n')
}

// One line per edit, so a client that only shows the text still learns what
// each edit replaced and whether any of them looks larger than intended.
function editReportLines(data) {
  const lines = []
  for (const [index, report] of (data.edits || []).entries()) {
    if (report.replaced_lines)
      lines.push(
        `edits[${index}] ${report.type}: replaced lines ${report.replaced_lines[0]}-${report.replaced_lines[1]}`
      )
    else if (report.inserted_at_line)
      lines.push(
        `edits[${index}] ${report.type}: inserted at line ${report.inserted_at_line}`
      )
  }
  for (const warning of data.warnings || []) lines.push(`warning: ${warning}`)
  return lines
}

function editFileSummary(data) {
  const lines = [
    `Edited ${data.path}; project_version: ${data.project_version}`,
    ...editReportLines(data),
  ]
  const affected = (data.comments_affected || []).filter(
    entry => entry.state !== 'unchanged'
  )
  if (affected.length)
    lines.push(
      `comments affected: ${affected.map(entry => `${entry.thread_id} ${entry.state}`).join(', ')}`
    )
  if (data.label?.comment) lines.push(`label: ${data.label.comment}`)
  return lines.join('\n')
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
  return [parts.join('; '), ...editReportLines(data)].join('\n')
}

// Unified diffs everywhere use the same 3 lines of context, so the output of
// diff, diff_branch and edit_file reads alike.
function unifiedDiff(path, before, after) {
  return createTwoFilesPatch(path, path, before, after, undefined, undefined, {
    context: 3,
  })
}

// project-history answers a file diff as the whole document cut into
// unchanged (u), inserted (i) and deleted (d) parts.
function historyDiffTexts(parts) {
  let before = ''
  let after = ''
  for (const part of Array.isArray(parts) ? parts : []) {
    if (part.u != null) {
      before += part.u
      after += part.u
    } else if (part.i != null) after += part.i
    else if (part.d != null) before += part.d
  }
  return { before, after }
}

function fileTreeChange(entry) {
  const renamed = entry.newPathname && entry.newPathname !== entry.pathname
  return {
    path: cleanPath(renamed ? entry.newPathname : entry.pathname),
    operation: entry.operation,
    ...(renamed ? { previous_path: cleanPath(entry.pathname) } : {}),
  }
}

function diffSummary(data) {
  const range = `versions ${data.from_version}-${data.to_version}`
  if (data.path) {
    if (data.binary) return `${data.path}, ${range}: binary file`
    if (!data.changed) return `${data.path}, ${range}: no change`
    return `${data.path}, ${range}:\n${data.diff}`
  }
  const lines = [`${plural(data.count, 'file')} changed, ${range}`]
  for (const file of data.files) {
    const from = file.previous_path ? ` (from ${file.previous_path})` : ''
    lines.push(`${file.operation}: ${file.path}${from}`)
  }
  return lines.join('\n')
}

function readFileSummary(data) {
  const lines = [
    `${data.path}; project_version: ${data.project_version}; ${data.total_lines} lines`,
  ]
  if (data.pending_suggestions && !data.suggestions)
    lines.push(
      `${plural(data.pending_suggestions, 'pending suggestion')} not shown: the text reads as if they were rejected, so line numbers and anchors can differ from the live document edit_file works on; pass include_suggestions:true to see them`
    )
  if (data.suggestions?.length)
    for (const suggestion of data.suggestions)
      lines.push(
        `pending ${suggestion.type} ${suggestion.change_id} at line ${suggestion.line}: ${JSON.stringify(suggestion.text)}`
      )
  lines.push(data.content)
  return lines.join('\n')
}

function suggestionListSummary(data) {
  const parts = [
    `${plural(data.count, 'pending suggestion')} in ${plural(data.files.length, 'file')}`,
  ]
  for (const file of data.files)
    parts.push(`${file.path}: ${plural(file.suggestions.length, 'suggestion')}`)
  return parts.join('\n')
}

function versionSuffix(data) {
  return data.project_version == null
    ? ''
    : `; project_version: ${data.project_version}`
}

function suggestionActionSummary(data) {
  const verb = data.action === 'accept' ? 'Accepted' : 'Rejected'
  return `${verb} ${plural(data.change_ids.length, 'suggestion')} in ${data.path}; ${plural(data.remaining, 'suggestion')} still pending there${versionSuffix(data)}`
}

function labelSummary(data) {
  return `Marked project version ${data.project_version} as a saved version: ${data.label.comment}`
}

function backupSummary(data) {
  if (!data.linked) return 'This project is not backed up to GitHub'
  const parts = [`${data.owner}/${data.repo} (${data.branch}): ${data.status}`]
  if (data.inProgress) parts.push('a backup is running right now')
  if (data.lastSyncedVersion != null)
    parts.push(`last backed up project version ${data.lastSyncedVersion}`)
  if (data.lastPushedCommit)
    parts.push(`commit ${String(data.lastPushedCommit).slice(0, 12)}`)
  if (data.lastError?.message) parts.push(data.lastError.message)
  return parts.join('; ')
}

function commentPlacementSummary(data) {
  const action = data.reanchored ? 'Re-anchored' : 'Added'
  const place = `${data.path}:${data.line}:${data.column}`
  return `${action} comment ${data.thread_id} at ${place} as ${data.acted_as}${versionSuffix(data)}`
}

function commentActionSummary(data) {
  if (data.message_id)
    return `Replied to thread ${data.thread_id} as ${data.acted_as}${versionSuffix(data)}`
  const state = data.resolved ? 'Resolved' : 'Reopened'
  return `${state} thread ${data.thread_id} as ${data.acted_as}${versionSuffix(data)}`
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

// Every write tool names the version it left the project at `project_version`,
// the name base_version is compared against.  WriteService calls it `version`,
// which write_files keeps returning as a deprecated alias for one release.
function withProjectVersion(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  if (data.project_version != null || data.version == null) return data
  return { ...data, project_version: data.version }
}

function writeResult(data, requestedCount = null) {
  const structured = normalizeStructuredContent(withProjectVersion(data))
  const applied = Array.isArray(structured.applied) ? structured.applied : []
  const failed = Array.isArray(structured.failed) ? structured.failed : []
  const allFailed =
    (requestedCount != null ? requestedCount > 0 : failed.length > 0) &&
    applied.length === 0
  if (!allFailed) return { isError: false, ...textResult(structured) }
  const failure = {
    code: 'write_failed',
    message: 'No files were written',
    next_action:
      'Fix the failed files and retry; nothing was written and the project version is unchanged',
  }
  const version = structured.project_version ?? structured.version
  const text = errorText({
    code: failure.code,
    message: failure.message,
    ...(version != null ? { project_version: version } : {}),
    failed: failed.map(entry => `${entry.path} (${entry.error})`),
    next_action: failure.next_action,
  })
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: { ...structured, ...failure },
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
  if (error.code === 'branch_not_found')
    return 'this project is not a branch; pass the branch_project_id from list_branches on the parent project'
  if (error.code === 'invalid_project_ref')
    return 'pass a project id (24 hex characters) or the project URL; list_projects shows both'
  if (error.code === 'thread_not_found')
    return 'call list_comments to see the threads of this project'
  if (error.code === 'ot_type_unsupported')
    return 'this document cannot hold tracked changes; write the change directly with edit_file instead'
  if (String(error.code).endsWith('_request_failed'))
    return 'an Overleaf service refused the request (see status and details); retry, and report it if it keeps failing'
  return 'check request'
}

// OError keeps constructor properties on `info`, so look in both places.
function errorDetail(error, name) {
  return error[name] ?? error.info?.[name]
}

function formatTextValue(value) {
  if (Array.isArray(value)) return value.map(formatTextValue).join(', ')
  if (value && typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// Some clients hand the model only the text of a tool result, never its
// structuredContent, so an error has to carry its facts in the text too: one
// `key: value` line per fact, the code first and what to do about it last.
function errorText(structured) {
  const lines = [`error: ${structured.code}`, `message: ${structured.message}`]
  for (const [key, value] of Object.entries(structured)) {
    if (['code', 'message', 'next_action', 'details'].includes(key)) continue
    lines.push(`${key}: ${formatTextValue(value)}`)
  }
  lines.push(`next_action: ${structured.next_action}`)
  return lines.join('\n')
}

const errorResult = (error, next) => {
  const candidateLines = errorDetail(error, 'candidateLines')
  const actualText = errorDetail(error, 'actualText')
  const editIndex = errorDetail(error, 'editIndex')
  const validValues = errorDetail(error, 'validValues')
  const matches = errorDetail(error, 'matches')
  // A refusal from document-updater or chat carries the status it answered
  // with and whatever else its body said; both help an agent decide whether to
  // retry, re-read or give up.
  const status = errorDetail(error, 'status')
  const details = errorDetail(error, 'details')
  const structured = {
    code: error.code || 'error',
    message: error.message || String(error),
    ...(editIndex != null ? { edit_index: editIndex } : {}),
    ...(validValues ? { valid_values: validValues } : {}),
    ...(matches ? { matches } : {}),
    ...(error.expectedVersion != null
      ? { expected_version: error.expectedVersion }
      : {}),
    ...(error.actualVersion != null
      ? {
          actual_version: error.actualVersion,
          current_version: error.actualVersion,
        }
      : {}),
    ...(error.changedPaths ? { changed_paths: error.changedPaths } : {}),
    ...(candidateLines ? { candidate_lines: candidateLines } : {}),
    ...(actualText != null ? { actual_text: actualText } : {}),
    ...(status != null ? { status } : {}),
    ...(details ? { details } : {}),
    ...(error.paths ? { paths: error.paths } : {}),
    ...(error.candidates ? { candidates: error.candidates } : {}),
    next_action: nextAction(error, next),
  }
  return {
    isError: true,
    content: [{ type: 'text', text: errorText(structured) }],
    structuredContent: structured,
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

function exactSpans(text, exact) {
  return occurrences(text, exact).map(position => ({ position, text: exact }))
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
function ellipsisSpans(text, pattern) {
  const separator = pattern.indexOf(ELLIPSIS)
  if (separator < 0) return exactSpans(text, pattern)
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
  return spans
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

// exact and start_with_ellipsis say which text to anchor to; start_line and
// end_line either are the anchor or, next to one of those two, narrow the
// search to those lines.
function textAnchorForm(anchor) {
  const forms = []
  if (anchor?.exact != null) forms.push('exact')
  if (anchor?.start_with_ellipsis != null) forms.push('ellipsis')
  if (forms.length > 1)
    throw toolError(
      'invalid_anchor',
      'anchor takes exact or start_with_ellipsis, not both',
      'pass one of them, with start_line/end_line or occurrence to tell repeated text apart'
    )
  const hasLines = anchor?.start_line != null || anchor?.end_line != null
  if (!forms.length && !hasLines)
    throw toolError(
      'invalid_anchor',
      'anchor needs exact, start_with_ellipsis or start_line/end_line',
      'pass the text to comment on as exact, or a line range'
    )
  if (!forms.length && anchor?.occurrence != null)
    throw toolError(
      'invalid_anchor',
      'occurrence picks one of several matches of exact or start_with_ellipsis',
      'drop occurrence from a line-range anchor'
    )
  return forms[0] || 'lines'
}

function describeWindow(anchor) {
  if (anchor.start_line == null && anchor.end_line == null) return ''
  const start = anchor.start_line ?? 1
  return ` between lines ${start} and ${anchor.end_line ?? start}`
}

// One of the spans the anchor text matched: the only one, or the one
// `occurrence` (1-based, in document order) picks.
function pickSpan(text, spans, anchor) {
  const where = describeWindow(anchor)
  if (!spans.length)
    throw new AnchorNotFoundError(`anchor text is not in this document${where}`)
  const candidateLines = linesOfPositions(
    text,
    spans.map(span => span.position)
  )
  if (anchor.occurrence != null) {
    if (!Number.isInteger(anchor.occurrence) || anchor.occurrence < 1)
      throw toolError(
        'invalid_anchor',
        'occurrence counts matches from 1 and must be a positive integer',
        `pass an occurrence between 1 and ${spans.length}`
      )
    if (anchor.occurrence > spans.length) {
      const error = new AnchorNotFoundError(
        `anchor text occurs ${plural(spans.length, 'time')}${where}, so there is no occurrence ${anchor.occurrence}`,
        { candidateLines }
      )
      error.next_action = `pass an occurrence between 1 and ${spans.length} (candidate_lines lists them in order)`
      throw error
    }
    return spans[anchor.occurrence - 1]
  }
  if (spans.length > 1) {
    const error = new AnchorAmbiguousError(
      `anchor text occurs ${spans.length} times${where}`,
      { candidateLines }
    )
    error.next_action =
      'pass occurrence (1-based, in the order of candidate_lines), or start_line/end_line to search only those lines'
    throw error
  }
  return spans[0]
}

// Turns an anchor into the character range the comment op needs.  Offsets are
// computed on lines.join('\n'), the same text document-updater holds.
function resolveAnchor(lines, anchor) {
  const text = lines.join('\n')
  const form = textAnchorForm(anchor)
  let range
  if (form === 'lines') range = resolveLineAnchor(lines, anchor)
  else {
    const hasLines = anchor.start_line != null || anchor.end_line != null
    const window = hasLines
      ? resolveLineAnchor(lines, {
          start_line: anchor.start_line ?? 1,
          end_line: anchor.end_line ?? anchor.start_line,
        })
      : { position: 0, text }
    const windowEnd = window.position + window.text.length
    const spans = (
      form === 'exact'
        ? exactSpans(text, String(anchor.exact))
        : ellipsisSpans(text, String(anchor.start_with_ellipsis))
    ).filter(
      span =>
        span.position >= window.position &&
        span.position + span.text.length <= windowEnd
    )
    range = pickSpan(text, spans, anchor)
  }
  if (!range.text)
    throw toolError(
      'invalid_anchor',
      'the anchor selects no text',
      'pick an anchor that covers at least one character'
    )
  return range
}

function suggestionKind(change) {
  if (typeof change.op?.i === 'string') return 'insert'
  if (typeof change.op?.d === 'string') return 'delete'
  return 'unknown'
}

// The document as it would read if every pending suggestion were rejected:
// suggested insertions are live text and come out, suggested deletions are
// only in the ranges and go back in.  Changes are applied from the end so the
// offsets of the ones before stay valid; at one offset the insertion goes
// first, since the deleted text sits where the inserted text starts.
function withoutSuggestions(lines, changes) {
  if (!changes.length) return lines
  const ordered = [...changes].sort(
    (left, right) =>
      (right.op?.p ?? 0) - (left.op?.p ?? 0) ||
      (suggestionKind(left) === 'insert' ? -1 : 1)
  )
  let text = lines.join('\n')
  for (const change of ordered) {
    const position = change.op?.p ?? 0
    const kind = suggestionKind(change)
    if (kind === 'insert')
      text = text.slice(0, position) + text.slice(position + change.op.i.length)
    else if (kind === 'delete')
      text = text.slice(0, position) + change.op.d + text.slice(position)
  }
  return text.split('\n')
}

function pendingSuggestions(lines, changes) {
  return changes
    .map(change => {
      const position = change.op?.p ?? 0
      const { line, column } = positionToLineColumn(lines, position)
      return {
        change_id: change.id,
        type: suggestionKind(change),
        text: change.op?.i ?? change.op?.d ?? '',
        line,
        column,
      }
    })
    .sort((left, right) => left.line - right.line || left.column - right.column)
}

// Timestamps leave the MCP as ISO 8601 strings, whatever the service that
// stored them used: milliseconds, a Date or a string.
function isoTime(value) {
  if (value == null || value === '') return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function userIdOf(user) {
  if (user == null) return null
  if (typeof user === 'object') return String(user.id ?? user._id ?? '')
  return String(user)
}

// One history entry, in the same shape for labels and updates, so either can
// be handed straight to diff (from_version, to_version) or revert_to.
function updateHistoryEntry(update) {
  const meta = update.meta || {}
  const origin = meta.origin || update.origin
  const users = meta.users || update.users || []
  return {
    type: 'update',
    from_version: update.fromV ?? update.from_version ?? update.fromVersion,
    to_version: update.toV ?? update.to_version ?? update.toVersion,
    created_at: isoTime(meta.end_ts ?? update.timestamp),
    authors: users.map(userIdOf).filter(Boolean),
    ...(origin?.agent ? { agent: origin.agent } : {}),
    ...(origin?.message ? { message: origin.message } : {}),
    ...(origin ? { origin } : {}),
    pathnames: update.pathnames || update.paths || [],
  }
}

function labelHistoryEntry(label) {
  const author = userIdOf(label.user_id ?? label.user)
  return {
    type: 'label',
    from_version: label.version,
    to_version: label.version,
    version: label.version,
    created_at: isoTime(label.created_at ?? label.createdAt ?? label.timestamp),
    authors: author ? [author] : [],
    message: label.comment,
    comment: label.comment,
  }
}

function newestHistoryEntryFirst(left, right) {
  const byVersion = (right.to_version ?? -1) - (left.to_version ?? -1)
  if (byVersion) return byVersion
  // A label sits on the version its update produced; list it above that
  // update, as the history panel does.
  const rank = entry => (entry.type === 'label' ? 0 : 1)
  return rank(left) - rank(right)
}

function historySummary(data) {
  const lines = [
    `${data.count} history ${data.count === 1 ? 'entry' : 'entries'}`,
  ]
  for (const entry of data.entries) {
    const versions =
      entry.type === 'label'
        ? `label at version ${entry.to_version}`
        : `versions ${entry.from_version}-${entry.to_version}`
    const who = entry.agent ? ` via ${entry.agent}` : ''
    const what = entry.message ? `: ${entry.message}` : ''
    lines.push(`${entry.created_at ?? 'unknown time'} ${versions}${who}${what}`)
  }
  return lines.join('\n')
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

// A document that outgrows the limit is refused before anything is written.
function assertDocumentFits(lines, services) {
  const size = lines.reduce((total, line) => total + line.length + 1, 0)
  if (size > (services.settings?.max_doc_length ?? Settings.max_doc_length))
    throw new FileTooLargeError()
}

// The paths that changed between two project versions, from the file tree
// diff project-history already computes for the history panel.  Best effort:
// a conflict is still reported, with the current version, if this fails.
async function changedPathsBetween(services, id, from, to) {
  if (!Number.isInteger(Number(from)) || !Number.isInteger(Number(to)))
    return null
  if (Number(from) >= Number(to)) return null
  try {
    const result = await services.fetchJson(
      `${services.settings.apis.project_history.url}/project/${id}/filetree/diff?from=${from}&to=${to}`
    )
    if (!Array.isArray(result?.diff)) return null
    return result.diff
      .filter(entry => entry.operation)
      .map(entry => cleanPath(entry.newPathname || entry.pathname))
  } catch {
    return null
  }
}

// Someone else wrote to the project since the caller read it.  The version to
// retry with is the one the project is at now, and the files to re-read are
// the ones that changed in between, so say both.
async function withVersionConflictHint(services, id, error) {
  if (error.code !== 'version_conflict') return error
  const paths = await changedPathsBetween(
    services,
    id,
    error.expectedVersion,
    error.actualVersion
  )
  if (paths) error.changedPaths = paths
  const reread = paths?.length ? paths.join(', ') : 'the files you changed'
  error.next_action = `re-read ${reread} and retry with base_version=${error.actualVersion}`
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
// An Overleaf label is a milestone: the "saved versions" list a human scans,
// and the commits the git-bridge exposes.  One label per agent write floods
// both, so writes leave their intent in the history entry and the agent marks
// milestones on purpose.  Every write tool repeats this sentence so a client
// reading a single tool description still learns the rule.
const LABEL_GUIDANCE =
  'Set label:true to mark a milestone (saved version); by default only the history entry records this change, showing your message under the author line.'

// `write_files` replaces whole files, so writing over one that already exists
// has to be asked for: a collaborator may have edited it since the caller last
// read it, and without `base_version` nothing else would notice.  The rule
// lives here rather than in WriteService because revert, merge and the
// git-bridge overwrite existing files on purpose.
async function assertNoSilentOverwrite(services, id, files, overwrite) {
  if (overwrite) return
  const tree = await services.SnapshotService.getFileTree(id)
  const existing = new Set(tree.map(file => cleanPath(file.path)))
  const clashes = files
    .filter(file => !file.delete)
    .map(file => cleanPath(file.path))
    .filter(path => existing.has(path))
  if (!clashes.length) return
  const error = toolError(
    'file_exists',
    `${plural(clashes.length, 'file')} already exist${clashes.length === 1 ? 's' : ''}: ${clashes.join(', ')}; nothing was written`,
    'to replace them pass overwrite: true, with base_version from read_file or get_project so a concurrent edit is refused; to change part of a text file use edit_file'
  )
  error.paths = clashes
  throw error
}

// The version a write that does not go through WriteService left the project
// at: comment and suggestion operations move the project history too, and the
// caller needs the new version for its next base_version.  Best effort; the
// operation itself has already happened.
async function currentProjectVersion(services, id) {
  if (!services.VersionService?.getLatestVersion) return undefined
  try {
    return (await services.VersionService.getLatestVersion(id))?.version
  } catch {
    return undefined
  }
}

function withVersion(data, version) {
  return version == null ? data : { ...data, project_version: version }
}

const agentSchema = z
  .string()
  .optional()
  .describe(
    'Who is making the change, shown in the history panel as "(via <agent>)" next to the token owner; defaults to the name of the MCP client.'
  )

const actAsAgentSchema = z
  .boolean()
  .optional()
  .describe(
    'true (default): post as the Agent service user, so the review panel tells agent comments apart from yours. false: post as the token owner. If the Agent user cannot join the project the tool posts as the token owner and acted_as says so.'
  )

const branchRefSchema = z
  .string()
  .describe(
    'The branch: its branch_project_id or URL (from create_branch or list_branches), or its name when project is given too.'
  )

const branchParentSchema = z
  .string()
  .optional()
  .describe(
    'The parent project id or URL; needed only when branch is a branch name.'
  )

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

  // Same-named projects the token user can reach, for a caller that passed a
  // project name where an id belongs.  Only looked up on that error path.
  const projectsNamed = async name => {
    const wanted = String(name).trim().toLowerCase()
    try {
      const all = await services.ProjectGetter.promises.findAllUsersProjects(
        userId,
        'name'
      )
      return Object.values(all || {})
        .flat()
        .filter(item => String(item?.name).trim().toLowerCase() === wanted)
        .map(item => ({
          project_id: String(item._id || item.id),
          name: item.name,
        }))
    } catch {
      return []
    }
  }

  // Every tool takes a project id or URL.  A name is the most common mistake,
  // so the error says what to pass instead and lists the projects of that
  // name when there are any.
  const projectIdOf = async ref => {
    try {
      return projectId(ref, services)
    } catch (error) {
      if (error?.code !== 'invalid_project_ref') throw error
      const candidates = await projectsNamed(ref)
      const refused = toolError(
        'invalid_project_ref',
        `${JSON.stringify(ref)} is not a project id or URL; pass a project id or URL`,
        candidates.length
          ? 'pass the project_id of the project you mean from candidates'
          : 'call list_projects to find the project id'
      )
      if (candidates.length) refused.candidates = candidates
      throw refused
    }
  }

  const isProjectRef = ref => {
    try {
      projectId(ref, services)
      return true
    } catch {
      return false
    }
  }

  // A branch is a project of its own, so the branch tools take its project id
  // or URL; they also take the branch name together with the parent project.
  const branchProjectIdOf = async (branch, project) => {
    if (isProjectRef(branch)) return projectId(branch, services)
    if (project == null)
      throw toolError(
        'invalid_branch_ref',
        `${JSON.stringify(branch)} is not a branch project id or URL`,
        'pass branch as the branch_project_id that create_branch or list_branches returned, or pass project (the parent project) together with the branch name'
      )
    const parentId = await projectIdOf(project)
    const { branches = [] } = await services.BranchService.listBranches(
      parentId,
      userId
    )
    const named = branches.filter(item => item.name === branch)
    const open = named.filter(item => item.status === 'open')
    const matches = open.length ? open : named
    if (matches.length === 1) return matches[0].branch_project_id
    const names = branches.map(item => item.name)
    const refused = matches.length
      ? toolError(
          'branch_ambiguous',
          `${matches.length} branches of this project are named ${JSON.stringify(branch)}`,
          'pass the branch_project_id of the one you mean (list_branches shows them)'
        )
      : toolError(
          'branch_not_found',
          `no open or merged branch named ${JSON.stringify(branch)} on this project${names.length ? `; its branches are: ${names.join(', ')}` : ''}`,
          'call list_branches to see the branch names and ids'
        )
    throw refused
  }

  server.tool(
    'list_projects',
    'List the projects this token can reach, newest first, with project_id, url, name, permissions (read or write) and last_updated (ISO 8601). Use it to find the id every other tool takes; several projects can share a name, so tell them apart by last_updated.',
    {},
    async () =>
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
              last_updated: isoTime(project.lastUpdated),
            })
          }
        }
        output.sort((left, right) =>
          String(right.last_updated ?? '').localeCompare(
            String(left.last_updated ?? '')
          )
        )
        return { projects: output, count: output.length }
      })
  )

  server.tool(
    'get_project',
    'Get one project: its name, root document, file tree, your permissions and the current project_version, which edit_file, suggest_edits and write_files take as base_version.',
    { project: z.string() },
    async ({ project }) =>
      run(async () => {
        const id = await projectIdOf(project)
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
    'Read a text document with numbered lines ("12: text"), plus the project_version to pass as base_version to edit_file or suggest_edits. start_line and end_line (1-based, inclusive) limit the lines returned. Pending tracked changes (suggestions nobody has accepted yet) are not part of the text by default: it reads as if they were all rejected, and pending_suggestions says how many there are. Pass include_suggestions:true to get the live text instead, which edit_file and suggest_edits work on, with every pending suggestion listed by line.',
    {
      project: z.string(),
      path: z.string(),
      start_line: z.number().optional(),
      end_line: z.number().optional(),
      include_suggestions: z.boolean().optional(),
    },
    async ({ project, path, start_line, end_line, include_suggestions }) =>
      runSummarised(readFileSummary, async () => {
        const id = await projectIdOf(project)
        await access(services, req, id)
        const document = await services.SnapshotService.readDoc(id, path, {})
        const changes = document.ranges?.changes || []
        const allLines = include_suggestions
          ? document.lines
          : withoutSuggestions(document.lines, changes)
        const from = Math.max(1, start_line ?? 1)
        const to = Math.min(allLines.length, end_line ?? allLines.length)
        const content = allLines
          .slice(from - 1, to)
          .map((line, index) => `${from + index}: ${line}`)
          .join('\n')
        const latest = await services.VersionService.getLatestVersion(id)
        return {
          path: document.path,
          content,
          project_version: latest.version,
          doc_version: document.docVersion,
          sha256: document.sha256,
          total_lines: allLines.length,
          pending_suggestions: changes.length,
          ...(include_suggestions
            ? { suggestions: pendingSuggestions(document.lines, changes) }
            : {}),
        }
      })
  )

  server.tool(
    'get_outline',
    'List the LaTeX headings (part to subsubsection) with their level, title, file and line, following \\input and \\include from the root document when no path is given. Use it to find the title and level for a replace_section edit.',
    { project: z.string(), path: z.string().optional() },
    async ({ project, path }) =>
      run(async () => {
        const id = await projectIdOf(project)
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
    'Search every text document of the project for a string, or a JavaScript regular expression with regex:true, and return path, line and text of each matching line (max_results, default 50).',
    {
      project: z.string(),
      query: z.string(),
      regex: z.boolean().optional(),
      max_results: z.number().optional(),
    },
    async ({ project, query, regex, max_results = 50 }) =>
      run(async () => {
        const id = await projectIdOf(project)
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
    'List the history of a project, newest first: updates (from_version, to_version, created_at, authors, and the agent and message a write recorded) and labels (saved versions). Pass from_version and to_version of an update to diff to see what it changed, or a version to revert_to.',
    { project: z.string(), limit: z.number().optional() },
    async ({ project, limit = 50 }) =>
      runSummarised(historySummary, async () => {
        const id = await projectIdOf(project)
        await access(services, req, id)
        const labels = await services.LabelService.listLabels(id)
        const updatesResponse = await services.fetchJson(
          `${services.settings.apis.project_history.url}/project/${id}/updates?min_count=${limit}`
        )
        const updates = Array.isArray(updatesResponse)
          ? updatesResponse
          : updatesResponse?.updates || []
        const entries = [
          ...(labels || []).map(labelHistoryEntry),
          ...updates.map(updateHistoryEntry),
        ]
          .sort(newestHistoryEntryFirst)
          .slice(0, limit)
        return { entries, count: entries.length }
      })
  )

  server.tool(
    'diff',
    'Compare two project versions (from_version and to_version, as list_history gives them). With path: a unified diff of that file with 3 lines of context. Without path: the files that were added, edited, renamed or removed between the two versions.',
    {
      project: z.string(),
      from_version: z.number(),
      to_version: z.number(),
      path: z.string().optional(),
    },
    async ({ project, from_version, to_version, path }) =>
      runSummarised(diffSummary, async () => {
        const id = await projectIdOf(project)
        await access(services, req, id)
        const history = services.settings.apis.project_history.url
        const versions = { from_version, to_version }
        if (path) {
          const target = cleanPath(path)
          const result = await services.fetchJson(
            `${history}/project/${id}/diff?pathname=${encodeURIComponent(target)}&from=${from_version}&to=${to_version}`
          )
          if (result?.diff?.binary)
            return { path: target, ...versions, binary: true }
          const { before, after } = historyDiffTexts(result?.diff)
          return {
            path: target,
            ...versions,
            changed: before !== after,
            diff: unifiedDiff(target, before, after),
          }
        }
        const result = await services.fetchJson(
          `${history}/project/${id}/filetree/diff?from=${from_version}&to=${to_version}`
        )
        const entries = Array.isArray(result) ? result : result?.diff || []
        const files = entries
          .filter(entry => entry.operation)
          .map(fileTreeChange)
        return {
          ...versions,
          files,
          count: files.length,
          unchanged_count: entries.length - files.length,
        }
      })
  )

  // Labels are the milestones of the project: the "saved versions" a human
  // browses and the commits the git-bridge exposes.  Writes no longer create
  // one each, so this is how an agent marks the end of a piece of work.
  server.tool(
    'create_label',
    'Mark a project version as a milestone ("saved version") that humans and Git see. Call it when a piece of work is finished — a review round handled, a section rewritten — not after every write.',
    {
      project: z.string(),
      comment: z.string(),
      version: z.number().int().nonnegative().optional(),
    },
    async ({ project, comment, version }) =>
      runSummarised(labelSummary, async () => {
        const id = await projectIdOf(project)
        await access(services, req, id, 'write')
        const latest = await services.VersionService.getLatestVersion(id)
        const at = version ?? latest.version
        const label = await services.LabelService.createLabel(
          id,
          userId,
          at,
          comment
        )
        return {
          project_version: at,
          label: {
            id: label.id ?? label._id,
            comment: label.comment ?? comment,
          },
        }
      })
  )

  server.tool(
    'write_files',
    `Create, replace or delete whole project files in one atomic write (text in content, binary in contentBase64, delete:true to remove). A path that already exists is refused unless you pass overwrite:true; new files and deletes need nothing. Pass base_version too when overwriting, so a concurrent edit is refused instead of lost; to change part of a text file prefer edit_file. Returns project_version, the version the project is at after the write (the older name version is a deprecated alias, kept for one release), and the files applied, unchanged or failed. ${LABEL_GUIDANCE}`,
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
      overwrite: z.boolean().optional(),
      agent: agentSchema,
      label: z.boolean().optional(),
    },
    async ({
      project,
      message,
      files,
      base_version,
      overwrite = false,
      agent,
      label = false,
    }) => {
      let id
      try {
        id = await projectIdOf(project)
        await access(services, req, id, 'write')
        await assertNoSilentOverwrite(services, id, files, overwrite)
        const result = await services.WriteService.writeFiles(id, userId, {
          baseVersion: base_version,
          message,
          agent: agent || clientName || 'mcp',
          files,
          label,
        })
        return writeResult(result, files.length)
      } catch (error) {
        return errorResult(await withVersionConflictHint(services, id, error))
      }
    }
  )
  server.tool(
    'revert_to',
    'Revert a project or file to a historical version. A revert is a milestone, so it always creates a label (saved version) of its own.',
    {
      project: z.string(),
      version: z.number().int().nonnegative(),
      path: z.string().optional(),
      message: z.string().optional(),
      agent: agentSchema,
    },
    async ({ project, version, path, message, agent }) => {
      try {
        const id = await projectIdOf(project)
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
    `Change part of a text document with structured edits, applied atomically against base_version (the project_version read_file or get_project returned). Returns the new project_version, the lines each edit replaced, a unified diff and the comments the change affected.\n${EDITS_DESCRIPTION}\n${LABEL_GUIDANCE}`,
    {
      project: z.string(),
      path: z.string(),
      base_version: z.number().int().nonnegative(),
      edits: editsSchema,
      message: z.string(),
      agent: agentSchema,
      label: z.boolean().optional(),
    },
    async ({
      project,
      path,
      base_version,
      edits,
      message,
      agent,
      label = false,
    }) =>
      runSummarised(editFileSummary, async () => {
        const id = await projectIdOf(project)
        await access(services, req, id, 'write')
        const document = await services.SnapshotService.readDoc(id, path)
        const { lines, changes, reports, warnings } = applyStructuredEdits(
          document.lines,
          edits
        )
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
            label,
          })
        } catch (error) {
          throw await withVersionConflictHint(services, id, error)
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
          edits: reports,
          ...(warnings.length ? { warnings } : {}),
          diff: unifiedDiff(path, before, content),
        }
      })
  )

  server.tool(
    'create_branch',
    'Create a branch: a copy of the project, recorded against the version it started from, that can later be compared with diff_branch and merged back with merge_branch. Returns branch_project_id, the id the branch tools and every other tool take for the branch.',
    { project: z.string(), name: z.string() },
    async ({ project, name }) =>
      run(async () => {
        const id = await projectIdOf(project)
        return services.BranchService.createBranch(id, userId, { name })
      })
  )

  server.tool(
    'list_branches',
    'List the open and merged branches of a project with their name, branch_project_id, base_version and status.',
    { project: z.string() },
    async ({ project }) =>
      run(async () => {
        const id = await projectIdOf(project)
        return services.BranchService.listBranches(id, userId)
      })
  )

  server.tool(
    'diff_branch',
    'Compare a branch with its parent project: every file with its state since the branch was made (unchanged, branch_only, parent_only, both_same, both_differ).',
    { branch: branchRefSchema, project: branchParentSchema },
    async ({ branch, project }) =>
      run(async () => {
        const id = await branchProjectIdOf(branch, project)
        return services.BranchService.diffBranch(id, userId)
      })
  )

  server.tool(
    'merge_branch',
    'Merge a branch into its parent. dry_run defaults to true: it reports mergeable and the conflicts and writes nothing. With dry_run:false a clean merge is written in one atomic write and returns project_version. Landing a branch is a milestone, so a successful merge always creates a label (saved version) of its own.',
    {
      branch: branchRefSchema,
      project: branchParentSchema,
      dry_run: z.boolean().optional(),
      message: z.string().optional(),
      agent: agentSchema,
    },
    async ({ branch, project, dry_run = true, message, agent }) => {
      try {
        const id = await branchProjectIdOf(branch, project)
        const result = await services.BranchService.mergeBranch(id, userId, {
          dryRun: dry_run,
          message,
          agent: agent || clientName || 'mcp',
        })
        return { isError: false, ...textResult(withProjectVersion(result)) }
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.tool(
    'archive_branch',
    'Archive a branch: hide its project and take it out of list_branches. Needs write access to the parent project.',
    { branch: branchRefSchema, project: branchParentSchema },
    async ({ branch, project }) =>
      run(async () => {
        const id = await branchProjectIdOf(branch, project)
        return services.BranchService.archiveBranch(id, userId)
      })
  )

  server.tool(
    'list_comments',
    'List the review comments of a project, or of one file with path: each thread with its id, the text it is anchored to, line and column, messages, and whether it is resolved. Resolved threads are left out unless include_resolved:true.',
    {
      project: z.string(),
      path: z.string().optional(),
      include_resolved: z.boolean().optional(),
    },
    async ({ project, path, include_resolved = false }) =>
      run(async () => {
        const id = await projectIdOf(project)
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
    'The work list of a review round: the unresolved comments grouped by file, each with context_lines (default 3) of the surrounding text, the comments whose text is gone (detached), and how many suggestions are still pending.',
    { project: z.string(), context_lines: z.number().int().optional() },
    async ({ project, context_lines = 3 }) =>
      run(async () => {
        const id = await projectIdOf(project)
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
    'Reply to a review comment thread (thread_id from list_comments or get_review_queue).',
    {
      project: z.string(),
      thread_id: z.string(),
      content: z.string(),
      act_as_agent: actAsAgentSchema,
    },
    async ({ project, thread_id, content, act_as_agent = true }) =>
      run(async () => {
        const id = await projectIdOf(project)
        await access(services, req, id, 'write')
        const comment = await findCommentThread(services, id, thread_id)
        const actor = await resolveActor(services, id, userId, act_as_agent)
        const message = await services.ReviewService.sendComment(
          id,
          thread_id,
          actor.userId,
          content
        )
        return withVersion(
          {
            thread_id,
            path: comment.path,
            message_id: message?.id,
            acted_as: actor.acted_as,
            ...(actor.reason ? { reason: actor.reason } : {}),
          },
          await currentProjectVersion(services, id)
        )
      })
  )

  const threadStateTool = (name, description, resolved) =>
    server.tool(
      name,
      description,
      {
        project: z.string(),
        thread_id: z.string(),
        act_as_agent: actAsAgentSchema,
      },
      async ({ project, thread_id, act_as_agent = true }) =>
        run(async () => {
          const id = await projectIdOf(project)
          await access(services, req, id, 'write')
          const comment = await findCommentThread(services, id, thread_id)
          const actor = await resolveActor(services, id, userId, act_as_agent)
          const apply = resolved
            ? services.ReviewService.resolveThread
            : services.ReviewService.reopenThread
          await apply(id, comment.doc_id, thread_id, actor.userId)
          return withVersion(
            {
              thread_id,
              path: comment.path,
              resolved,
              acted_as: actor.acted_as,
              ...(actor.reason ? { reason: actor.reason } : {}),
            },
            await currentProjectVersion(services, id)
          )
        })
    )

  threadStateTool(
    'resolve_comment',
    'Mark a review comment thread as resolved, once the change it asked for is made.',
    true
  )
  threadStateTool(
    'reopen_comment',
    'Reopen a resolved review comment thread, for example when a later change undid the fix it asked for.',
    false
  )

  const anchorSchema = z
    .object({
      exact: z
        .string()
        .optional()
        .describe('Exact text to comment on, as it appears in the document.'),
      start_with_ellipsis: z
        .string()
        .optional()
        .describe(
          'A long passage given by its ends: "first words...last words".'
        ),
      start_line: z
        .number()
        .int()
        .optional()
        .describe(
          'Alone: the first line to comment on (1-based). With exact or start_with_ellipsis: search only from this line.'
        ),
      end_line: z
        .number()
        .int()
        .optional()
        .describe(
          'Last line, inclusive; defaults to start_line. With exact or start_with_ellipsis: search only up to this line.'
        ),
      occurrence: z
        .number()
        .int()
        .optional()
        .describe(
          'Which match of exact or start_with_ellipsis to use, counted from 1 in document order (within start_line/end_line when given).'
        ),
    })
    .describe(
      'Where the comment goes: exact or start_with_ellipsis, optionally narrowed by start_line/end_line and occurrence; or a line range alone.'
    )

  server.tool(
    'add_comment',
    'Start a review comment thread on a passage of a document. The anchor is the exact text (optionally narrowed with occurrence, counted from 1, or start_line/end_line), a "first words...last words" passage, or a line range. Returns the thread_id and where the comment landed.',
    {
      project: z.string(),
      path: z.string(),
      anchor: anchorSchema,
      content: z.string(),
      act_as_agent: actAsAgentSchema,
    },
    async ({ project, path, anchor, content, act_as_agent = true }) =>
      run(async () => {
        const id = await projectIdOf(project)
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
          project_version: await currentProjectVersion(services, id),
        })
      })
  )

  server.tool(
    'reanchor_comment',
    'Move a review comment thread onto new text, for a comment whose text was rewritten or deleted (detached). Takes the same anchor as add_comment.',
    {
      project: z.string(),
      thread_id: z.string(),
      path: z.string(),
      anchor: anchorSchema,
      act_as_agent: actAsAgentSchema,
    },
    async ({ project, thread_id, path, anchor, act_as_agent = true }) =>
      run(async () => {
        const id = await projectIdOf(project)
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
          project_version: await currentProjectVersion(services, id),
        })
      })
  )

  server.tool(
    'suggest_edits',
    `Offer structured edits to a document as tracked changes a human accepts or rejects in the review panel, instead of writing them straight into the document. Takes the same edits as edit_file and returns the ids of the suggestions it created.\n${EDITS_DESCRIPTION}\n${LABEL_GUIDANCE}`,
    {
      project: z.string(),
      path: z.string(),
      base_version: z.number().int().nonnegative(),
      edits: editsSchema,
      message: z.string(),
      agent: agentSchema,
      act_as_agent: actAsAgentSchema,
      label: z.boolean().optional(),
    },
    async ({
      project,
      path,
      base_version,
      edits,
      message,
      agent,
      act_as_agent = true,
      label = false,
    }) =>
      runSummarised(suggestEditsSummary, async () => {
        const id = await projectIdOf(project)
        await access(services, req, id, 'write')
        const doc = await resolveDoc(services, id, path)
        const document = await services.SnapshotService.readDoc(id, path)
        const { lines, reports, warnings } = applyStructuredEdits(
          document.lines,
          edits
        )
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
              label,
            }
          )
        } catch (error) {
          throw await withVersionConflictHint(services, id, error)
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
          edits: reports,
          ...(warnings.length ? { warnings } : {}),
          diff: unifiedDiff(path, before, content),
        }
      })
  )

  server.tool(
    'list_suggestions',
    'List the pending tracked changes (suggestions) of a project, or of one file with path: change_id, insert or delete, the text, line and column, author and time.',
    { project: z.string(), path: z.string().optional() },
    async ({ project, path }) =>
      runSummarised(suggestionListSummary, async () => {
        const id = await projectIdOf(project)
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
          const id = await projectIdOf(project)
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
          return withVersion(
            {
              action,
              path: doc.path,
              doc_id: doc.docId,
              change_ids: result.change_ids,
              remaining: result.remaining,
            },
            await currentProjectVersion(services, id)
          )
        })
    )

  suggestionActionTool(
    'accept_suggestions',
    'Accept pending suggestions of one file, as the token owner: the ids in change_ids, or every pending one with all:true. The text becomes part of the document.',
    'accept'
  )
  suggestionActionTool(
    'reject_suggestions',
    'Reject pending suggestions of one file, as the token owner: the ids in change_ids, or every pending one with all:true. Suggested insertions are removed and suggested deletions restored.',
    'reject'
  )

  // Linking and unlinking need a GitHub token, which stays in the browser
  // flow: an agent can only look at the backup and ask for one to run.
  function backupService() {
    if (!services.GithubBackupService)
      throw toolError(
        'backup_disabled',
        'GitHub backup is not enabled on this server',
        'ask the server administrator to set GITHUB_BACKUP_ENABLED'
      )
    return services.GithubBackupService
  }

  server.tool(
    'get_backup_status',
    'Report whether this project is mirrored to a GitHub repository, and how the last backup went',
    { project: z.string() },
    async ({ project }) =>
      runSummarised(backupSummary, async () => {
        const id = await projectIdOf(project)
        await access(services, req, id)
        return await backupService().promises.getStatus(id)
      })
  )

  server.tool(
    'backup_now',
    'Push the latest saved project history to the linked GitHub repository now',
    { project: z.string() },
    async ({ project }) =>
      runSummarised(
        backupSummary,
        async () => {
          const id = await projectIdOf(project)
          await access(services, req, id, 'write')
          return await backupService().promises.syncNow(id, { force: true })
        },
        'check with get_backup_status that the project is linked to a GitHub repository and that you have write access; linking is done by the owner in the editor Integrations panel'
      )
  )

  return server
}

export function createMcpServer(options = {}) {
  const server = new McpServer({ name: 'overleaf-mcp', version: '1.0.0' })
  registerTools(server, options)
  return server
}
