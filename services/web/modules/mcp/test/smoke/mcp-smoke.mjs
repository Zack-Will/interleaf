#!/usr/bin/env node
/* eslint-disable no-console */

// A dependency-light smoke check for the MCP wiring.  It uses the SDK's
// in-memory transport, so no web process (or Docker services) are required.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { createMcpServer } from '../../app/src/McpTools.mjs'

const projectId = '0123456789abcdef01234567'
const docId = '76543210fedcba9876543210'

const services = {
  ProjectRef: {
    parse(value) {
      if (
        value === projectId ||
        value === `https://example.test/project/${projectId}`
      ) {
        return { projectId }
      }
      throw new Error(`invalid project: ${value}`)
    },
    urlFor(id) {
      return `https://example.test/project/${id}`
    },
    async requireAccess() {},
  },
  VersionService: {
    async getLatestVersion() {
      return { version: 3, timestamp: new Date().toISOString() }
    },
  },
  BranchService: {
    async createBranch() {
      return {}
    },
    async listBranches() {
      return { branches: [], count: 0 }
    },
    async diffBranch() {
      return {}
    },
    async mergeBranch() {
      return { mergeable: true, files: [], conflicts: [] }
    },
    async archiveBranch() {
      return {}
    },
  },
  RevertService: {
    async revertTo() {
      return { version: 4, project_version: 4, label: null }
    },
  },
  WriteService: {
    async writeFiles() {
      return { version: 4, label: null }
    },
  },
  ProjectGetter: {
    promises: {
      async findAllUsersProjects() {
        return { owned: [{ _id: projectId, name: 'Smoke project' }] }
      },
    },
  },
  settings: { max_doc_length: 2000000 },
  ProjectEntityHandler: {
    promises: {
      async getAllDocPathsFromProjectById() {
        return { [docId]: '/main.tex' }
      },
    },
  },
  ReviewService: {
    async listThreads() {
      return {
        'thread-1': {
          messages: [
            {
              id: 'message-1',
              content: 'Please tighten this sentence.',
              timestamp: 1700000000000,
              user_id: 'reviewer-1',
              user: { id: 'reviewer-1', first_name: 'Rev' },
            },
          ],
        },
      }
    },
    async getDocRanges() {
      return {
        lines: [
          '\\section{Introduction}',
          'Hello from the smoke test.',
          'Done.',
        ],
        ranges: {
          comments: [
            {
              id: 'comment-1',
              op: { c: 'Hello', p: 23, t: 'thread-1' },
            },
          ],
        },
        version: 3,
      }
    },
    async sendComment() {
      return { id: 'message-2' }
    },
    async resolveThread() {},
    async reopenThread() {},
    async createComment(_projectId, _docId, _userId, { position, text }) {
      return {
        threadId: 'thread-2',
        comment: {
          id: 'thread-2',
          op: { c: text, p: position, t: 'thread-2' },
        },
        version: 4,
        message: { id: 'message-3' },
      }
    },
    async reanchorComment(_projectId, _docId, _userId, threadId, range) {
      return {
        threadId,
        comment: {
          id: threadId,
          op: { c: range.text, p: range.position, t: threadId },
        },
        version: 5,
      }
    },
  },
  AgentUser: {
    async ensureAgentIsCollaborator() {
      return { ok: true, agentUserId: 'agent-user', added: false }
    },
  },
  SuggestionService: {
    async suggestDocContent(_projectId, _docId, _userId, { message }) {
      return {
        change_ids: ['change-1'],
        version: 5,
        label: { id: 'label-1', comment: `Suggest: ${message}` },
      }
    },
    async listSuggestions() {
      const suggestion = {
        change_id: 'change-1',
        doc_id: docId,
        path: 'main.tex',
        type: 'insert',
        text: 'Hi',
        position: 23,
        line: 2,
        column: 1,
        author: { id: 'agent-user', name: 'Agent MCP' },
        created_at: '2026-01-01T00:00:00.000Z',
      }
      return {
        files: [
          {
            path: 'main.tex',
            doc_id: docId,
            suggestions: [suggestion],
            count: 1,
          },
        ],
        suggestions: [suggestion],
        count: 1,
      }
    },
    async acceptSuggestions(_projectId, _docId, changeIds) {
      return { change_ids: changeIds ?? ['change-1'], remaining: 0 }
    },
    async rejectSuggestions(_projectId, _docId, changeIds) {
      return { change_ids: changeIds ?? ['change-1'], remaining: 0 }
    },
  },
  GithubBackupService: {
    promises: {
      async getStatus() {
        return {
          linked: true,
          project_id: projectId,
          owner: 'octocat',
          repo: 'thesis-backup',
          branch: 'main',
          repoUrl: 'https://github.com/octocat/thesis-backup',
          status: 'ok',
          lastSyncedVersion: 3,
          lastPushedCommit: 'abcdef1234567890',
          lastError: null,
          inProgress: false,
        }
      },
      async syncNow() {
        return {
          linked: true,
          project_id: projectId,
          owner: 'octocat',
          repo: 'thesis-backup',
          branch: 'main',
          repoUrl: 'https://github.com/octocat/thesis-backup',
          status: 'ok',
          lastSyncedVersion: 4,
          lastPushedCommit: '1234567890abcdef',
          lastError: null,
          inProgress: false,
        }
      },
    },
  },
  SnapshotService: {
    async readDoc(_id, path, { startLine = 1, endLine } = {}) {
      const lines = [
        '\\section{Introduction}',
        'Hello from the smoke test.',
        'Done.',
      ]
      const first = Math.max(1, startLine)
      const last = Math.min(lines.length, endLine ?? lines.length)
      return {
        path,
        lines: lines.slice(first - 1, last),
        totalLines: lines.length,
        sha256: 'smoke-sha256',
        docVersion: 3,
      }
    },
  },
}

const server = createMcpServer({
  services,
  req: { syncUser: { userId: 'smoke-user' } },
  clientName: 'smoke-client',
})

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'smoke-client', version: '1.0.0' })

await server.connect(serverTransport)
await client.connect(clientTransport)

const listed = await client.listTools()
const read = await client.callTool(
  {
    name: 'read_file',
    arguments: {
      project: projectId,
      path: 'main.tex',
      start_line: 2,
      end_line: 2,
    },
  },
  CallToolResultSchema
)

const requiredTools = [
  'edit_file',
  'revert_to',
  'create_branch',
  'list_branches',
  'diff_branch',
  'merge_branch',
  'archive_branch',
  'list_comments',
  'get_review_queue',
  'reply_comment',
  'resolve_comment',
  'reopen_comment',
  'add_comment',
  'reanchor_comment',
  'suggest_edits',
  'list_suggestions',
  'accept_suggestions',
  'reject_suggestions',
  'get_backup_status',
  'backup_now',
]
for (const name of requiredTools) {
  if (!listed.tools.some(tool => tool.name === name))
    throw new Error(`missing tool: ${name}`)
}
const projects = await client.callTool(
  { name: 'list_projects', arguments: {} },
  CallToolResultSchema
)
if (
  Array.isArray(projects.structuredContent) ||
  !Array.isArray(projects.structuredContent.projects) ||
  projects.structuredContent.count !== 1
)
  throw new Error('list_projects returned an invalid structuredContent shape')
const queue = await client.callTool(
  { name: 'get_review_queue', arguments: { project: projectId } },
  CallToolResultSchema
)
const queued = queue.structuredContent.files?.[0]?.comments?.[0]
if (!queued || queued.line !== 2 || queued.column !== 1)
  throw new Error('get_review_queue did not place the comment on line 2')
const reply = await client.callTool(
  {
    name: 'reply_comment',
    arguments: {
      project: projectId,
      thread_id: 'thread-1',
      content: 'Tightened in the latest revision.',
    },
  },
  CallToolResultSchema
)
if (reply.structuredContent.acted_as !== 'agent')
  throw new Error('reply_comment did not post as the agent user')
// "\\section{Introduction}" is 22 characters, so line 2 starts at offset 23
// and line 3 at offset 50.
const added = await client.callTool(
  {
    name: 'add_comment',
    arguments: {
      project: projectId,
      path: 'main.tex',
      anchor: { start_with_ellipsis: 'Hello...smoke test.' },
      content: 'Is this still true?',
    },
  },
  CallToolResultSchema
)
if (
  added.structuredContent.position !== 23 ||
  added.structuredContent.line !== 2 ||
  added.structuredContent.quoted_text !== 'Hello from the smoke test.'
)
  throw new Error('add_comment did not resolve the ellipsis anchor')
const reanchored = await client.callTool(
  {
    name: 'reanchor_comment',
    arguments: {
      project: projectId,
      thread_id: 'thread-1',
      path: 'main.tex',
      anchor: { start_line: 3, end_line: 3 },
    },
  },
  CallToolResultSchema
)
if (
  reanchored.structuredContent.position !== 50 ||
  reanchored.structuredContent.quoted_text !== 'Done.'
)
  throw new Error('reanchor_comment did not resolve the line anchor')
const ambiguous = await client.callTool(
  {
    name: 'add_comment',
    arguments: {
      project: projectId,
      path: 'main.tex',
      anchor: { exact: 'e' },
      content: 'nope',
    },
  },
  CallToolResultSchema
)
if (
  ambiguous.structuredContent.code !== 'anchor_ambiguous' ||
  !Array.isArray(ambiguous.structuredContent.candidate_lines)
)
  throw new Error('an ambiguous anchor did not report its candidate lines')
const suggested = await client.callTool(
  {
    name: 'suggest_edits',
    arguments: {
      project: projectId,
      path: 'main.tex',
      base_version: 3,
      edits: [{ type: 'replace_range', start_line: 2, new_text: 'Hi there.' }],
      message: 'tighten the intro',
    },
  },
  CallToolResultSchema
)
if (
  suggested.structuredContent.acted_as !== 'agent' ||
  suggested.structuredContent.change_ids.length !== 1 ||
  suggested.structuredContent.suggestions[0]?.line !== 2 ||
  !suggested.structuredContent.diff.includes('Hi there.')
)
  throw new Error('suggest_edits did not report the tracked changes it created')
const listedSuggestions = await client.callTool(
  { name: 'list_suggestions', arguments: { project: projectId } },
  CallToolResultSchema
)
if (
  listedSuggestions.structuredContent.count !== 1 ||
  listedSuggestions.structuredContent.files[0]?.path !== 'main.tex'
)
  throw new Error('list_suggestions did not group the suggestions by file')
const accepted = await client.callTool(
  {
    name: 'accept_suggestions',
    arguments: { project: projectId, path: 'main.tex', all: true },
  },
  CallToolResultSchema
)
if (accepted.structuredContent.remaining !== 0)
  throw new Error('accept_suggestions did not report the remaining count')
const rejected = await client.callTool(
  {
    name: 'reject_suggestions',
    arguments: {
      project: projectId,
      path: 'main.tex',
      change_ids: ['change-1'],
    },
  },
  CallToolResultSchema
)
if (rejected.structuredContent.change_ids[0] !== 'change-1')
  throw new Error('reject_suggestions did not act on the requested ids')
const unspecified = await client.callTool(
  {
    name: 'reject_suggestions',
    arguments: { project: projectId, path: 'main.tex' },
  },
  CallToolResultSchema
)
if (unspecified.structuredContent.code !== 'invalid_request')
  throw new Error('reject_suggestions accepted a call naming no suggestions')

const backupStatus = await client.callTool(
  { name: 'get_backup_status', arguments: { project: projectId } },
  CallToolResultSchema
)
if (
  backupStatus.structuredContent.repoUrl !==
  'https://github.com/octocat/thesis-backup'
)
  throw new Error('get_backup_status did not report the linked repository')
const backedUp = await client.callTool(
  { name: 'backup_now', arguments: { project: projectId } },
  CallToolResultSchema
)
if (backedUp.structuredContent.lastSyncedVersion !== 4)
  throw new Error('backup_now did not report the version it pushed')

console.log(`tools/list: ${listed.tools.map(tool => tool.name).join(', ')}`)
console.log(`read_file: ${read.structuredContent.path}`)
console.log(`list_projects: ${projects.structuredContent.count} projects`)
console.log(`get_review_queue: ${queue.content[0].text.split('\n')[0]}`)
console.log(
  `reply_comment: message ${reply.structuredContent.message_id} as ${reply.structuredContent.acted_as}`
)
console.log(`add_comment: ${added.content[0].text}`)
console.log(`reanchor_comment: ${reanchored.content[0].text}`)
console.log(
  `anchor_ambiguous: candidate lines ${ambiguous.structuredContent.candidate_lines.join(', ')}`
)
console.log(`suggest_edits: ${suggested.content[0].text}`)
console.log(`list_suggestions: ${listedSuggestions.content[0].text}`)
console.log(`accept_suggestions: ${accepted.content[0].text}`)
console.log(`reject_suggestions: ${rejected.content[0].text}`)
console.log(`reject_suggestions without ids: ${unspecified.content[0].text}`)
console.log(`get_backup_status: ${backupStatus.content[0].text}`)
console.log(`backup_now: ${backedUp.content[0].text}`)

await client.close()
await server.close()
