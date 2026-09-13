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
    createComment: vi.fn(async (_id, _docId, _userId, { position, text }) => ({
      threadId: 't-new',
      comment: { id: 't-new', op: { c: text, p: position, t: 't-new' } },
      version: 9,
      message: { id: 'm-new' },
    })),
    reanchorComment: vi.fn(
      async (_id, _docId, _userId, threadId, { position, text }) => ({
        threadId,
        comment: { id: threadId, op: { c: text, p: position, t: threadId } },
        version: 10,
      })
    ),
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
    ...(overrides.services || {}),
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

describe('MCP comment anchoring tools', () => {
  const addComment = (server, anchor, overrides = {}) =>
    server._registeredTools.add_comment.handler({
      project: projectId,
      path: 'main.tex',
      anchor,
      content: 'please rephrase',
      ...overrides,
    })

  it('anchors a comment on an exact quote', async () => {
    const { server, reviewService } = setup()
    const result = await addComment(server, { exact: 'Alpha beta.' })
    expect(reviewService.createComment).toHaveBeenCalledWith(
      projectId,
      mainDocId,
      'agent-1',
      { position: 16, text: 'Alpha beta.', content: 'please rephrase' }
    )
    expect(result.structuredContent).toMatchObject({
      thread_id: 't-new',
      path: 'main.tex',
      line: 2,
      column: 1,
      quoted_text: 'Alpha beta.',
      acted_as: 'agent',
      message_id: 'm-new',
    })
    expect(result.content[0].text).toBe(
      'Added comment t-new at main.tex:2:1 as agent'
    )
  })

  it('anchors a comment on a first-words...last-words quote', async () => {
    const { server, reviewService } = setup()
    await addComment(server, { start_with_ellipsis: 'Alpha...beta.' })
    expect(reviewService.createComment).toHaveBeenCalledWith(
      projectId,
      mainDocId,
      'agent-1',
      { position: 16, text: 'Alpha beta.', content: 'please rephrase' }
    )
  })

  it('anchors a comment on a line range', async () => {
    const { server, reviewService } = setup()
    await addComment(server, { start_line: 2, end_line: 3 })
    expect(reviewService.createComment).toHaveBeenCalledWith(
      projectId,
      mainDocId,
      'agent-1',
      {
        position: 16,
        text: 'Alpha beta.\nGamma delta.',
        content: 'please rephrase',
      }
    )
  })

  it('reports an ambiguous anchor with the lines it matched', async () => {
    const { server, reviewService } = setup({
      documents: {
        [mainDocId]: {
          lines: ['Repeat me', 'filler', 'Repeat me'],
          ranges: { comments: [] },
        },
        [partDocId]: { lines: partLines, ranges: { comments: [] } },
      },
    })
    const result = await addComment(server, { exact: 'Repeat me' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('anchor_ambiguous')
    expect(result.structuredContent.candidate_lines).toEqual([1, 3])
    expect(reviewService.createComment).not.toHaveBeenCalled()
  })

  it('reports an anchor that is not in the document', async () => {
    const { server } = setup()
    const result = await addComment(server, { exact: 'nowhere' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('anchor_not_found')
  })

  it('rejects an anchor that mixes two forms', async () => {
    const { server } = setup()
    const result = await addComment(server, { exact: 'Alpha', start_line: 2 })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('invalid_anchor')
  })

  it('rejects a line range outside the document', async () => {
    const { server } = setup()
    const result = await addComment(server, { start_line: 9, end_line: 9 })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('invalid_anchor')
  })

  it('reports an unknown path', async () => {
    const { server } = setup()
    const result = await server._registeredTools.add_comment.handler({
      project: projectId,
      path: 'missing.tex',
      anchor: { exact: 'Alpha' },
      content: 'x',
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('doc_not_found')
  })

  it('passes a text mismatch back with the text that is there now', async () => {
    const { server } = setup({
      ReviewService: {
        createComment: vi.fn(async () => {
          throw Object.assign(new Error('text mismatch'), {
            code: 'text_mismatch',
            actualText: 'Alpha gamma.',
          })
        }),
      },
    })
    const result = await addComment(server, { exact: 'Alpha beta.' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      code: 'text_mismatch',
      actual_text: 'Alpha gamma.',
    })
    expect(result.structuredContent.next_action).toContain('re-read')
  })

  it('re-anchors an existing thread onto new text', async () => {
    const { server, reviewService } = setup()
    const result = await server._registeredTools.reanchor_comment.handler({
      project: projectId,
      thread_id: 't-detached',
      path: 'main.tex',
      anchor: { exact: 'Gamma delta.' },
    })
    expect(reviewService.reanchorComment).toHaveBeenCalledWith(
      projectId,
      mainDocId,
      'agent-1',
      't-detached',
      { position: 28, text: 'Gamma delta.' }
    )
    expect(result.structuredContent).toMatchObject({
      thread_id: 't-detached',
      line: 3,
      column: 1,
      quoted_text: 'Gamma delta.',
      reanchored: true,
    })
    expect(result.content[0].text).toBe(
      'Re-anchored comment t-detached at main.tex:3:1 as agent'
    )
  })

  it('reports a thread that no longer exists', async () => {
    const { server } = setup({
      ReviewService: {
        reanchorComment: vi.fn(async () => {
          throw Object.assign(new Error('comment thread not found'), {
            code: 'thread_not_found',
          })
        }),
      },
    })
    const result = await server._registeredTools.reanchor_comment.handler({
      project: projectId,
      thread_id: 't-gone',
      path: 'main.tex',
      anchor: { exact: 'Gamma delta.' },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('thread_not_found')
  })

  it('tells the agent to re-anchor the detached comments of the queue', async () => {
    const { server } = setup()
    const result = await server._registeredTools.get_review_queue.handler({
      project: projectId,
    })
    expect(result.content[0].text).toContain('reanchor_comment')
  })
})

describe('edit_file re-anchoring', () => {
  // `writeFiles` reports which comments the write transformed; only the ones
  // it detached, and only where the edit replaced their text, are moved.
  function editSetup({ commentsAffected, ReviewService } = {}) {
    const writeFiles = vi.fn(async () => ({
      version: 6,
      label: { comment: 'edit' },
      comments_affected: commentsAffected ?? [
        { thread_id: 't-alpha', path: 'main.tex', state: 'detached' },
        { thread_id: 't-beta', path: 'main.tex', state: 'shrunk' },
      ],
    }))
    const context = setup({
      ReviewService,
      services: {
        SnapshotService: {
          readDoc: vi.fn(async () => ({
            path: 'main.tex',
            lines: mainLines,
            totalLines: mainLines.length,
          })),
        },
        WriteService: { writeFiles },
        settings: { max_doc_length: 100000 },
      },
    })
    return { ...context, writeFiles }
  }

  const edit = (server, edits) =>
    server._registeredTools.edit_file.handler({
      project: projectId,
      path: 'main.tex',
      base_version: 4,
      edits,
      message: 'edit',
    })

  it('moves a comment the edit detached onto the replacement text', async () => {
    const { server, reviewService } = editSetup()
    const result = await edit(server, [
      {
        type: 'replace_anchor',
        anchor: 'Alpha beta.',
        new_text: 'Alpha gamma.',
      },
    ])
    expect(reviewService.reanchorComment).toHaveBeenCalledTimes(1)
    expect(reviewService.reanchorComment).toHaveBeenCalledWith(
      projectId,
      mainDocId,
      'u-token',
      't-alpha',
      { position: 16, text: 'Alpha gamma.' }
    )
    expect(result.structuredContent.reanchored).toEqual([
      { thread_id: 't-alpha', line: 2, column: 1 },
    ])
    expect(result.structuredContent.reanchor_failed).toBeUndefined()
  })

  it('maps offsets through the earlier edits of the same call', async () => {
    const { server, reviewService } = editSetup()
    const result = await edit(server, [
      { type: 'replace_range', start_line: 1, end_line: 1, new_text: 'A\nB' },
      {
        type: 'replace_anchor',
        anchor: 'Alpha beta.',
        new_text: 'Alpha gamma.',
      },
    ])
    // The comment sat at offset 16 of the original document and the
    // replacement sits at offset 4 of the written one.
    expect(reviewService.reanchorComment).toHaveBeenCalledWith(
      projectId,
      mainDocId,
      'u-token',
      't-alpha',
      { position: 4, text: 'Alpha gamma.' }
    )
    expect(result.structuredContent.reanchored).toEqual([
      { thread_id: 't-alpha', line: 3, column: 1 },
    ])
  })

  it('leaves a detached comment alone when the edit replaced other text', async () => {
    const { server, reviewService } = editSetup()
    const result = await edit(server, [
      {
        type: 'replace_anchor',
        anchor: 'Gamma delta.',
        new_text: 'Gamma epsilon.',
      },
    ])
    expect(reviewService.reanchorComment).not.toHaveBeenCalled()
    expect(result.structuredContent.reanchored).toBeUndefined()
  })

  it('does not move a comment a line range edit detached', async () => {
    const { server, reviewService } = editSetup()
    await edit(server, [
      { type: 'replace_range', start_line: 2, end_line: 2, new_text: 'Other.' },
    ])
    expect(reviewService.reanchorComment).not.toHaveBeenCalled()
  })

  it('reports a failed re-anchor without failing the edit', async () => {
    const { server } = editSetup({
      ReviewService: {
        reanchorComment: vi.fn(async () => {
          throw Object.assign(new Error('text mismatch'), {
            code: 'text_mismatch',
          })
        }),
      },
    })
    const result = await edit(server, [
      {
        type: 'replace_anchor',
        anchor: 'Alpha beta.',
        new_text: 'Alpha gamma.',
      },
    ])
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent.project_version).toBe(6)
    expect(result.structuredContent.reanchor_failed).toEqual([
      { thread_id: 't-alpha', code: 'text_mismatch', message: 'text mismatch' },
    ])
  })

  it('skips re-anchoring when the write detached nothing', async () => {
    const { server, reviewService } = editSetup({
      commentsAffected: [
        { thread_id: 't-alpha', path: 'main.tex', state: 'grown' },
      ],
    })
    await edit(server, [
      {
        type: 'replace_anchor',
        anchor: 'Alpha beta.',
        new_text: 'Alpha gamma.',
      },
    ])
    expect(reviewService.reanchorComment).not.toHaveBeenCalled()
  })

  it('still edits when the review service cannot re-anchor', async () => {
    const { server } = editSetup({
      ReviewService: { reanchorComment: undefined },
    })
    const result = await edit(server, [
      {
        type: 'replace_anchor',
        anchor: 'Alpha beta.',
        new_text: 'Alpha gamma.',
      },
    ])
    expect(result.structuredContent.project_version).toBe(6)
    expect(result.structuredContent.reanchored).toBeUndefined()
  })
})
