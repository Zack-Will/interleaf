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
  },
  AgentUser: {
    async ensureAgentIsCollaborator() {
      return { ok: true, agentUserId: 'agent-user', added: false }
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

console.log(`tools/list: ${listed.tools.map(tool => tool.name).join(', ')}`)
console.log(`read_file: ${read.structuredContent.path}`)
console.log(`list_projects: ${projects.structuredContent.count} projects`)
console.log(`get_review_queue: ${queue.content[0].text.split('\n')[0]}`)
console.log(
  `reply_comment: message ${reply.structuredContent.message_id} as ${reply.structuredContent.acted_as}`
)

await client.close()
await server.close()
