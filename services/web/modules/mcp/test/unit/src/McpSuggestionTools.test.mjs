import { describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../../../app/src/McpTools.mjs'

const projectId = 'a'.repeat(24)
const mainDocId = 'd'.repeat(24)

// "\\section{Intro}" is 15 characters, so line 2 starts at offset 16.
const mainLines = ['\\section{Intro}', 'Alpha beta.']

function suggestion(changeId, overrides = {}) {
  return {
    change_id: changeId,
    doc_id: mainDocId,
    path: 'main.tex',
    type: 'insert',
    text: 'Hi ',
    position: 16,
    line: 2,
    column: 1,
    author: { id: 'agent-1', name: 'Agent MCP' },
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function setup(overrides = {}) {
  const suggestions = overrides.suggestions || [suggestion('change-1')]
  const suggestionService = {
    suggestDocContent: vi.fn(async () => ({
      change_ids: ['change-1'],
      version: 9,
      label: { id: 'label-1', comment: 'Suggest: tighten it' },
    })),
    listSuggestions: vi.fn(async () => ({
      files: suggestions.length
        ? [
            {
              path: 'main.tex',
              doc_id: mainDocId,
              suggestions,
              count: suggestions.length,
            },
          ]
        : [],
      suggestions,
      count: suggestions.length,
    })),
    acceptSuggestions: vi.fn(async (_id, _docId, changeIds) => ({
      change_ids: changeIds ?? ['change-1'],
      remaining: 0,
    })),
    rejectSuggestions: vi.fn(async (_id, _docId, changeIds) => ({
      change_ids: changeIds ?? ['change-1'],
      remaining: 2,
    })),
    ...(overrides.SuggestionService || {}),
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
        })),
      },
    },
    SnapshotService: {
      readDoc: vi.fn(async () => ({
        path: 'main.tex',
        lines: mainLines,
        totalLines: mainLines.length,
        sha256: 'hash',
        docVersion: 4,
      })),
    },
    AgentUser: {
      ensureAgentIsCollaborator: vi.fn(async () => ({
        ok: true,
        agentUserId: 'agent-1',
        added: false,
      })),
    },
    SuggestionService: suggestionService,
    settings: { max_doc_length: 100000 },
    ...(overrides.services || {}),
  }
  const server = createMcpServer({
    services,
    req: { syncUser: { userId: 'u-token' } },
    clientName: 'claude',
  })
  return { server, services, suggestionService }
}

describe('suggest_edits', () => {
  const call = (server, overrides = {}) =>
    server._registeredTools.suggest_edits.handler({
      project: projectId,
      path: 'main.tex',
      base_version: 4,
      edits: [{ type: 'replace_anchor', anchor: 'Alpha', new_text: 'Beta' }],
      message: 'tighten it',
      ...overrides,
    })

  it('offers the edited content as tracked changes attributed to the agent', async () => {
    const { server, suggestionService } = setup()
    const result = await call(server)
    const [id, docId, userId, request] =
      suggestionService.suggestDocContent.mock.calls[0]
    expect(id).toBe(projectId)
    expect(docId).toBe(mainDocId)
    expect(userId).toBe('agent-1')
    expect(request.lines).toEqual(['\\section{Intro}', 'Beta beta.'])
    expect(request.baseVersion).toBe(4)
    expect(request.agent).toBe('claude')
    expect(result.structuredContent.acted_as).toBe('agent')
    expect(result.structuredContent.project_version).toBe(9)
    expect(result.structuredContent.change_ids).toEqual(['change-1'])
    expect(result.structuredContent.diff).toContain('Beta beta.')
  })

  it('describes each suggestion it created by line and text', async () => {
    const { server } = setup()
    const result = await call(server)
    expect(result.structuredContent.suggestions).toEqual([
      { change_id: 'change-1', type: 'insert', line: 2, text: 'Hi ' },
    ])
    expect(result.content[0].text).toContain('1 suggestion pending in main.tex')
  })

  it('leaves out suggestions this call did not create', async () => {
    const { server } = setup({
      suggestions: [suggestion('change-1'), suggestion('change-0')],
    })
    const result = await call(server)
    expect(
      result.structuredContent.suggestions.map(item => item.change_id)
    ).toEqual(['change-1'])
  })

  it('falls back to the token user when the agent cannot join the project', async () => {
    const { server, suggestionService } = setup({
      services: {
        AgentUser: {
          ensureAgentIsCollaborator: vi.fn(async () => ({
            ok: false,
            reason: 'not_owner',
          })),
        },
      },
    })
    const result = await call(server)
    expect(suggestionService.suggestDocContent.mock.calls[0][2]).toBe('u-token')
    expect(result.structuredContent.acted_as).toBe('token_user')
    expect(result.structuredContent.reason).toBe('not_owner')
  })

  it('reports an ambiguous anchor the way edit_file does', async () => {
    const { server, suggestionService } = setup()
    const result = await call(server, {
      edits: [{ type: 'replace_anchor', anchor: 'e', new_text: 'x' }],
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('anchor_ambiguous')
    expect(suggestionService.suggestDocContent).not.toHaveBeenCalled()
  })

  it('tells the caller which version to retry a stale write with', async () => {
    const conflict = Object.assign(new Error('project version conflict'), {
      code: 'version_conflict',
      expectedVersion: 4,
      actualVersion: 7,
    })
    const { server } = setup({
      SuggestionService: {
        suggestDocContent: vi.fn(async () => {
          throw conflict
        }),
      },
    })
    const result = await call(server)
    expect(result.structuredContent.code).toBe('version_conflict')
    expect(result.structuredContent.actual_version).toBe(7)
    expect(result.structuredContent.next_action).toContain('base_version=7')
  })

  it('refuses a document that would outgrow the size limit', async () => {
    const { server } = setup({ services: { settings: { max_doc_length: 5 } } })
    const result = await call(server)
    expect(result.structuredContent.code).toBe('file_too_large')
  })
})

describe('list_suggestions', () => {
  it('groups the pending suggestions by file', async () => {
    const { server, suggestionService } = setup()
    const result = await server._registeredTools.list_suggestions.handler({
      project: projectId,
    })
    expect(suggestionService.listSuggestions.mock.calls[0][1]).toBe(undefined)
    expect(result.structuredContent.count).toBe(1)
    expect(result.structuredContent.files[0].path).toBe('main.tex')
    expect(result.content[0].text).toContain('1 pending suggestion in 1 file')
  })

  it('limits the listing to one document when given a path', async () => {
    const { server, suggestionService } = setup()
    await server._registeredTools.list_suggestions.handler({
      project: projectId,
      path: 'main.tex',
    })
    expect(suggestionService.listSuggestions.mock.calls[0][1]).toBe(mainDocId)
  })

  it('refuses a path the project does not have', async () => {
    const { server } = setup()
    const result = await server._registeredTools.list_suggestions.handler({
      project: projectId,
      path: 'missing.tex',
    })
    expect(result.structuredContent.code).toBe('doc_not_found')
  })
})

describe('accept_suggestions and reject_suggestions', () => {
  it('accepts the named suggestions as the token user and reports what is left', async () => {
    const { server, suggestionService } = setup()
    const result = await server._registeredTools.accept_suggestions.handler({
      project: projectId,
      path: 'main.tex',
      change_ids: ['change-1'],
    })
    expect(suggestionService.acceptSuggestions.mock.calls[0]).toEqual([
      projectId,
      mainDocId,
      ['change-1'],
      'u-token',
    ])
    expect(result.structuredContent.remaining).toBe(0)
    expect(result.content[0].text).toContain(
      'Accepted 1 suggestion in main.tex'
    )
  })

  it('passes a null id list when asked for all of them', async () => {
    const { server, suggestionService } = setup()
    const result = await server._registeredTools.reject_suggestions.handler({
      project: projectId,
      path: 'main.tex',
      all: true,
    })
    expect(suggestionService.rejectSuggestions.mock.calls[0][2]).toBe(null)
    expect(result.content[0].text).toContain(
      '2 suggestions still pending there'
    )
  })

  it('refuses a call that names neither ids nor all', async () => {
    const { server, suggestionService } = setup()
    const result = await server._registeredTools.accept_suggestions.handler({
      project: projectId,
      path: 'main.tex',
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('invalid_request')
    expect(suggestionService.acceptSuggestions).not.toHaveBeenCalled()
  })

  it('requires write access', async () => {
    const requireAccess = vi.fn(async (_userId, _id, level) => {
      if (level === 'write')
        throw Object.assign(new Error('forbidden'), { code: 'forbidden' })
    })
    const { server } = setup({
      services: {
        ProjectRef: {
          parse: () => ({ projectId }),
          urlFor: id => id,
          requireAccess,
        },
      },
    })
    const result = await server._registeredTools.accept_suggestions.handler({
      project: projectId,
      path: 'main.tex',
      all: true,
    })
    expect(result.structuredContent.code).toBe('forbidden')
  })
})
