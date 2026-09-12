import { describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../../../app/src/McpTools.mjs'

const projectId = 'a'.repeat(24)
const mainDocId = 'd'.repeat(24)
const partDocId = 'e'.repeat(24)

// "\\section{Intro}" is 15 characters, so line 2 starts at offset 16 and line 3
// at offset 28.
const mainLines = ['\\section{Intro}', 'Alpha beta.', 'Gamma delta.']
const partLines = ['One', 'Two', 'Three']

function comment(id, threadId, text, position, metadata) {
  return {
    id,
    op: { c: text, p: position, t: threadId },
    ...(metadata ? { metadata } : {}),
  }
}

function defaultDocuments() {
  return {
    [mainDocId]: {
      lines: mainLines,
      ranges: {
        comments: [
          comment('c1', 't-alpha', 'Alpha', 16, { user_id: 'u-1', ts: 100 }),
          comment('c2', 't-beta', 'beta', 22),
          comment('c3', 't-detached', '', 28),
        ],
      },
    },
    [partDocId]: {
      lines: partLines,
      ranges: { comments: [comment('c4', 't-two', 'Two', 4)] },
    },
  }
}

function defaultThreads() {
  return {
    't-alpha': {
      messages: [
        {
          id: 'm-1',
          content: 'Tighten this',
          timestamp: 100,
          user_id: 'u-1',
          user: { id: 'u-1', first_name: 'Ada', email: 'ada@example.com' },
        },
      ],
    },
    't-beta': {
      messages: [{ id: 'm-2', content: 'Cite it', timestamp: 200 }],
      resolved: true,
      resolved_at: 300,
      resolved_by_user_id: 'u-2',
      resolved_by_user: { id: 'u-2', first_name: 'Bob' },
    },
    't-detached': {
      messages: [{ id: 'm-3', content: 'Gone', timestamp: 400 }],
    },
    't-two': { messages: [{ id: 'm-4', content: 'Check', timestamp: 500 }] },
  }
}

function setup(overrides = {}) {
  const documents = overrides.documents || defaultDocuments()
  const threads = overrides.threads || defaultThreads()
  const reviewService = {
    listThreads: vi.fn(async () => threads),
    getDocRanges: vi.fn(async (_id, docId) => documents[docId]),
    sendComment: vi.fn(async () => ({ id: 'm-new' })),
    resolveThread: vi.fn(async () => {}),
    reopenThread: vi.fn(async () => {}),
    ...(overrides.ReviewService || {}),
  }
  const agentUser = {
    ensureAgentIsCollaborator: vi.fn(async () => ({
      ok: true,
      agentUserId: 'agent-1',
      added: false,
    })),
    ...(overrides.AgentUser || {}),
  }
  const services = {
    ProjectRef: {
      parse: vi.fn(() => ({ projectId })),
      urlFor: id => `/project/${id}`,
      requireAccess: vi.fn(async () => {}),
    },
    ProjectEntityHandler: {
      promises: {
        getAllDocPathsFromProjectById: vi.fn(async () => ({
          [mainDocId]: '/main.tex',
          [partDocId]: '/parts/one.tex',
        })),
      },
    },
    ReviewService: reviewService,
    AgentUser: agentUser,
    settings: {},
  }
  const server = createMcpServer({
    services,
    req: { syncUser: { userId: 'u-token' } },
  })
  return { server, services, reviewService, agentUser }
}

describe('MCP comment tools', () => {
  it('computes 1-based line and column for each comment range', async () => {
    const { server } = setup()
    const result = await server._registeredTools.list_comments.handler({
      project: projectId,
      path: 'main.tex',
    })
    const comments = result.structuredContent.comments
    expect(
      comments.map(item => [item.thread_id, item.line, item.column])
    ).toEqual([
      ['t-alpha', 2, 1],
      ['t-detached', 3, 1],
    ])
    expect(comments[0].quoted_text).toBe('Alpha')
    expect(comments[0].author).toEqual({
      id: 'u-1',
      name: 'Ada',
      email: 'ada@example.com',
    })
    expect(comments[0].messages).toEqual([
      {
        id: 'm-1',
        content: 'Tighten this',
        timestamp: 100,
        user: { id: 'u-1', name: 'Ada', email: 'ada@example.com' },
      },
    ])
    expect(comments[0].created_at).toBe(100)
  })

  it('places a comment that follows a multi-line insert on the right line', async () => {
    const lines = ['one', 'two', 'three', 'four']
    const { server } = setup({
      documents: {
        [mainDocId]: {
          lines,
          // "one\ntwo\n" is 8 characters, so the range starts line 3 column 1.
          ranges: { comments: [comment('c1', 't-alpha', 'three', 8)] },
        },
        [partDocId]: { lines: [], ranges: {} },
      },
    })
    const result = await server._registeredTools.list_comments.handler({
      project: projectId,
      path: 'main.tex',
    })
    expect(result.structuredContent.comments[0]).toMatchObject({
      line: 3,
      column: 1,
      quoted_text: 'three',
    })
  })

  it('marks a fully deleted range as detached', async () => {
    const { server } = setup()
    const result = await server._registeredTools.list_comments.handler({
      project: projectId,
    })
    const detached = result.structuredContent.comments.find(
      item => item.thread_id === 't-detached'
    )
    expect(detached.detached).toBe(true)
    expect(detached.quoted_text).toBe('')
    const anchored = result.structuredContent.comments.find(
      item => item.thread_id === 't-alpha'
    )
    expect(anchored.detached).toBe(false)
  })

  it('hides resolved comments unless they are asked for', async () => {
    const { server } = setup()
    const hidden = await server._registeredTools.list_comments.handler({
      project: projectId,
    })
    expect(hidden.structuredContent.count).toBe(3)
    expect(hidden.structuredContent.resolved_hidden).toBe(1)
    expect(hidden.structuredContent.comments.some(item => item.resolved)).toBe(
      false
    )
    const shown = await server._registeredTools.list_comments.handler({
      project: projectId,
      include_resolved: true,
    })
    expect(shown.structuredContent.count).toBe(4)
    expect(shown.structuredContent.resolved_hidden).toBe(0)
    const resolved = shown.structuredContent.comments.find(
      item => item.thread_id === 't-beta'
    )
    expect(resolved).toMatchObject({
      resolved: true,
      resolved_at: 300,
      resolved_by: { id: 'u-2', name: 'Bob' },
    })
  })

  it('sorts comments by path then line', async () => {
    const { server } = setup()
    const result = await server._registeredTools.list_comments.handler({
      project: projectId,
      include_resolved: true,
    })
    expect(
      result.structuredContent.comments.map(item => [item.path, item.line])
    ).toEqual([
      ['main.tex', 2],
      ['main.tex', 2],
      ['main.tex', 3],
      ['parts/one.tex', 2],
    ])
  })

  it('reports an unknown path instead of returning nothing', async () => {
    const { server } = setup()
    const result = await server._registeredTools.list_comments.handler({
      project: projectId,
      path: 'missing.tex',
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('doc_not_found')
  })

  it('groups the review queue by file with surrounding context', async () => {
    const { server } = setup()
    const result = await server._registeredTools.get_review_queue.handler({
      project: projectId,
      context_lines: 1,
    })
    const data = result.structuredContent
    expect(data.count).toBe(2)
    expect(data.files.map(file => [file.path, file.count])).toEqual([
      ['main.tex', 1],
      ['parts/one.tex', 1],
    ])
    expect(data.files[0].comments[0].context).toEqual({
      before: ['\\section{Intro}'],
      line: 'Alpha beta.',
      after: ['Gamma delta.'],
    })
    expect(data.files[1].comments[0].context).toEqual({
      before: ['One'],
      line: 'Two',
      after: ['Three'],
    })
    expect(data.detached_count).toBe(1)
    expect(data.detached[0].thread_id).toBe('t-detached')
    expect(result.content[0].text).toContain('2 open comments in 2 files')
  })

  it('clamps the context window at the edges of a document', async () => {
    const { server } = setup()
    const result = await server._registeredTools.get_review_queue.handler({
      project: projectId,
      context_lines: 5,
    })
    expect(result.structuredContent.files[1].comments[0].context).toEqual({
      before: ['One'],
      line: 'Two',
      after: ['Three'],
    })
  })

  it('replies as the agent user when it can join the project', async () => {
    const { server, reviewService, agentUser } = setup()
    const result = await server._registeredTools.reply_comment.handler({
      project: projectId,
      thread_id: 't-alpha',
      content: 'Fixed in the latest revision',
    })
    expect(agentUser.ensureAgentIsCollaborator).toHaveBeenCalledWith(
      projectId,
      'u-token'
    )
    expect(reviewService.sendComment).toHaveBeenCalledWith(
      projectId,
      't-alpha',
      'agent-1',
      'Fixed in the latest revision'
    )
    expect(result.structuredContent).toMatchObject({
      thread_id: 't-alpha',
      path: 'main.tex',
      message_id: 'm-new',
      acted_as: 'agent',
    })
  })

  it('falls back to the token user when it does not own the project', async () => {
    const { server, reviewService } = setup({
      AgentUser: {
        ensureAgentIsCollaborator: vi.fn(async () => ({
          ok: false,
          reason: 'not_owner',
          agentUserId: 'agent-1',
        })),
      },
    })
    const result = await server._registeredTools.reply_comment.handler({
      project: projectId,
      thread_id: 't-alpha',
      content: 'Fixed',
    })
    expect(reviewService.sendComment).toHaveBeenCalledWith(
      projectId,
      't-alpha',
      'u-token',
      'Fixed'
    )
    expect(result.structuredContent).toMatchObject({
      acted_as: 'token_user',
      reason: 'not_owner',
    })
  })

  it('posts as the token user when act_as_agent is off', async () => {
    const { server, reviewService, agentUser } = setup()
    const result = await server._registeredTools.reply_comment.handler({
      project: projectId,
      thread_id: 't-alpha',
      content: 'Fixed',
      act_as_agent: false,
    })
    expect(agentUser.ensureAgentIsCollaborator).not.toHaveBeenCalled()
    expect(reviewService.sendComment).toHaveBeenCalledWith(
      projectId,
      't-alpha',
      'u-token',
      'Fixed'
    )
    expect(result.structuredContent.acted_as).toBe('token_user')
  })

  it('reports an unknown thread', async () => {
    const { server } = setup()
    const result = await server._registeredTools.reply_comment.handler({
      project: projectId,
      thread_id: 't-missing',
      content: 'Fixed',
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('thread_not_found')
    expect(result.structuredContent.next_action).toContain('list_comments')
  })

  it('resolves and reopens a thread against the document holding its range', async () => {
    const { server, reviewService, services } = setup()
    const resolved = await server._registeredTools.resolve_comment.handler({
      project: projectId,
      thread_id: 't-two',
    })
    expect(reviewService.resolveThread).toHaveBeenCalledWith(
      projectId,
      partDocId,
      't-two',
      'agent-1'
    )
    expect(resolved.structuredContent).toMatchObject({
      thread_id: 't-two',
      path: 'parts/one.tex',
      resolved: true,
      acted_as: 'agent',
    })
    expect(services.ProjectRef.requireAccess).toHaveBeenCalledWith(
      'u-token',
      projectId,
      'write'
    )
    const reopened = await server._registeredTools.reopen_comment.handler({
      project: projectId,
      thread_id: 't-alpha',
      act_as_agent: false,
    })
    expect(reviewService.reopenThread).toHaveBeenCalledWith(
      projectId,
      mainDocId,
      't-alpha',
      'u-token'
    )
    expect(reopened.structuredContent.resolved).toBe(false)
  })
})
