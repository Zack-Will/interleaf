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
    parts.push(`${plural(data.detached_count, 'detached comment')}`)
  return parts.join('\n')
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
  return 'check request'
}

const errorResult = (error, next) => ({
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
    ...(error.candidateLines ? { candidate_lines: error.candidateLines } : {}),
    next_action: nextAction(error, next),
  },
})

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

// Comment offsets are character positions in `lines.join('\n')`; turn one into
// the 1-based line and column an agent can act on.
function positionToLineColumn(lines, position) {
  let remaining = Math.max(0, position)
  for (let index = 0; index < lines.length; index += 1) {
    const length = lines[index].length
    if (remaining <= length) return { line: index + 1, column: remaining + 1 }
    remaining -= length + 1
  }
  const lastIndex = Math.max(0, lines.length - 1)
  return {
    line: lines.length || 1,
    column: (lines[lastIndex]?.length ?? 0) + 1,
  }
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

// Joins the live comment ranges of every document with the chat threads that
// hold their messages and resolved state.
async function loadProjectComments(services, id, path) {
  const docPaths =
    await services.ProjectEntityHandler.promises.getAllDocPathsFromProjectById(
      id
    )
  const docs = Object.entries(docPaths || {}).map(([docId, pathname]) => ({
    docId,
    path: cleanPath(pathname),
  }))
  const target = path == null ? null : cleanPath(path)
  const wanted = target ? docs.filter(doc => doc.path === target) : docs
  if (target && !wanted.length)
    throw toolError(
      'doc_not_found',
      `no document at ${target}`,
      'call get_project to list the document paths'
    )
  const threads = await services.ReviewService.listThreads(id)
  const comments = []
  const linesByPath = new Map()
  for (const doc of wanted) {
    const document = await services.ReviewService.getDocRanges(id, doc.docId)
    const lines = document?.lines || []
    linesByPath.set(doc.path, lines)
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
  return { comments, linesByPath }
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

function contextFor(lines, line, contextLines) {
  const index = line - 1
  return {
    before: lines.slice(Math.max(0, index - contextLines), index),
    line: lines[index] ?? '',
    after: lines.slice(index + 1, index + 1 + contextLines),
  }
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
      edits: z.array(
        z.object({
          type: z.string(),
          start_line: z.number().optional(),
          end_line: z.number().optional(),
          new_text: z.string().optional(),
          anchor: z.string().optional(),
          occurrence: z.number().optional(),
          title: z.string().optional(),
          level: z.string().optional(),
        })
      ),
      message: z.string(),
      agent: z.string().optional(),
    },
    async ({ project, path, base_version, edits, message, agent }) =>
      run(async () => {
        const id = projectId(project, services)
        await access(services, req, id, 'write')
        const document = await services.SnapshotService.readDoc(id, path)
        let lines = [...document.lines]
        const split = text => String(text ?? '').split(/\r\n|\n|\r/)
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
            if (levelIndex < 0)
              throw new InvalidEditError('invalid section level')
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
            lines.splice(start, end - start, ...replacementLines)
          } else throw new InvalidEditError(`unknown edit type ${edit.type}`)
        }
        const size = lines.reduce((total, line) => total + line.length + 1, 0)
        if (
          size > (services.settings?.max_doc_length ?? Settings.max_doc_length)
        )
          throw new FileTooLargeError()
        const before = document.lines.join('\n')
        const content = lines.join('\n')
        let result
        try {
          result = await services.WriteService.writeFiles(id, userId, {
            baseVersion: base_version,
            message,
            agent: agent || clientName || 'mcp',
            files: [{ path, content }],
          })
        } catch (error) {
          if (error.code === 'version_conflict') {
            error.next_action = `re-read changed files and retry with base_version=${error.actualVersion}`
          }
          throw error
        }
        return {
          path,
          project_version: result.version,
          label: result.label,
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
        const { comments, linesByPath } = await loadProjectComments(
          services,
          id,
          undefined
        )
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

  return server
}

export function createMcpServer(options = {}) {
  const server = new McpServer({ name: 'overleaf-mcp', version: '1.0.0' })
  registerTools(server, options)
  return server
}
