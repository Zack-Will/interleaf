import { describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../../../app/src/McpTools.mjs'

function setup(overrides = {}) {
  const services = {
    ProjectRef: {
      parse: vi.fn(x => ({
        projectId: x.includes('/') ? 'a'.repeat(24) : x,
      })),
      urlFor: x => `/project/${x}`,
      requireAccess: vi.fn(async () => {}),
    },
    SnapshotService: {
      getFileTree: vi.fn(async () => [{ path: 'main.tex', kind: 'doc' }]),
      readDoc: vi.fn(async () => ({
        path: 'main.tex',
        lines: ['one', 'two'],
        totalLines: 2,
        sha256: 'hash',
        docVersion: 4,
      })),
    },
    VersionService: { getLatestVersion: vi.fn(async () => ({ version: 4 })) },
    LabelService: {
      listLabels: vi.fn(async () => []),
      createLabel: vi.fn(async (_projectId, _userId, version, comment) => ({
        _id: 'label-1',
        comment,
        version,
      })),
    },
    WriteService: {
      writeFiles: vi.fn(async () => ({ version: 5, applied: [], failed: [] })),
    },
    RevertService: {
      revertTo: vi.fn(async () => ({ version: 5, applied: [], failed: [] })),
    },
    BranchService: {
      createBranch: vi.fn(async () => ({ branch_project_id: 'b'.repeat(24) })),
      listBranches: vi.fn(async () => ({ branches: [], count: 0 })),
      diffBranch: vi.fn(async () => ({ files: [] })),
      mergeBranch: vi.fn(async () => ({
        mergeable: true,
        files: [],
        conflicts: [],
      })),
      archiveBranch: vi.fn(async () => ({ status: 'archived' })),
    },
    GithubBackupService: {
      promises: {
        getStatus: vi.fn(async () => ({
          linked: true,
          owner: 'octocat',
          repo: 'backup',
          branch: 'main',
          status: 'ok',
          lastSyncedVersion: 4,
        })),
        syncNow: vi.fn(async () => ({
          linked: true,
          owner: 'octocat',
          repo: 'backup',
          branch: 'main',
          status: 'ok',
          lastSyncedVersion: 4,
        })),
      },
    },
    fetchJson: vi.fn(async () => ({ updates: [] })),
    settings: { apis: { project_history: { url: 'http://history' } } },
    ProjectGetter: {
      promises: {
        findAllUsersProjects: vi.fn(async () => ({})),
        getProject: vi.fn(async () => ({ name: 'P' })),
      },
    },
    ...overrides,
  }
  const server = createMcpServer({
    services,
    req: { syncUser: { userId: 'u' } },
  })
  return { server, services }
}

describe('MCP tools', () => {
  it('parses project refs and reads line range', async () => {
    const { server, services } = setup()
    const result = await server._registeredTools.read_file.handler({
      project: 'https://x/project/' + 'a'.repeat(24),
      path: 'main.tex',
      start_line: 2,
      end_line: 2,
    })
    expect(services.ProjectRef.parse).toHaveBeenCalled()
    expect(result.structuredContent.content).toContain('two')
  })

  it('returns permission denial payload', async () => {
    const err = Object.assign(new Error('forbidden'), { code: 'forbidden' })
    const { server } = setup({
      ProjectRef: {
        parse: x => ({ projectId: x }),
        requireAccess: vi.fn(async () => {
          throw err
        }),
        urlFor: x => x,
      },
    })
    const result = await server._registeredTools.read_file.handler({
      project: 'a'.repeat(24),
      path: 'main.tex',
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('forbidden')
  })

  it('returns the project history version separately from the document version', async () => {
    const { server } = setup({
      VersionService: { getLatestVersion: vi.fn(async () => ({ version: 9 })) },
    })
    const result = await server._registeredTools.read_file.handler({
      project: 'a'.repeat(24),
      path: 'main.tex',
    })
    expect(result.structuredContent.project_version).toBe(9)
    expect(result.structuredContent.doc_version).toBe(4)
  })

  it('lists review and token read-only projects as read-only', async () => {
    const { server } = setup({
      ProjectGetter: {
        promises: {
          findAllUsersProjects: vi.fn(async () => ({
            owned: [{ _id: 'owned', name: 'Owned' }],
            review: [{ _id: 'review', name: 'Review' }],
            tokenReadOnly: [{ _id: 'token-read', name: 'Token read' }],
            tokenReadAndWrite: [{ _id: 'token-write', name: 'Token write' }],
          })),
        },
      },
    })
    const result = await server._registeredTools.list_projects.handler({})
    expect(result.structuredContent.count).toBe(4)
    expect(result.structuredContent.projects).toEqual([
      expect.objectContaining({ project_id: 'owned', permissions: 'write' }),
      expect.objectContaining({ project_id: 'review', permissions: 'read' }),
      expect.objectContaining({
        project_id: 'token-read',
        permissions: 'read',
      }),
      expect.objectContaining({
        project_id: 'token-write',
        permissions: 'write',
      }),
    ])
  })

  it('returns the outline from the root document and one input', async () => {
    const readDoc = vi.fn(async (_id, path) => {
      if (path === 'main.tex')
        return { path, lines: ['\\section{Root}', '\\input{parts/intro}'] }
      return { path, lines: ['\\subsection{Introduction}'] }
    })
    const { server } = setup({
      SnapshotService: {
        getFileTree: vi.fn(async () => [
          { path: 'main.tex', kind: 'doc' },
          { path: 'parts/intro.tex', kind: 'doc' },
        ]),
        readDoc,
      },
    })
    const result = await server._registeredTools.get_outline.handler({
      project: 'a'.repeat(24),
    })
    expect(result.structuredContent.count).toBe(2)
    expect(result.structuredContent.headings).toEqual([
      { path: 'main.tex', line: 1, level: 'section', title: 'Root' },
      {
        path: 'parts/intro.tex',
        line: 1,
        level: 'subsection',
        title: 'Introduction',
      },
    ])
  })

  it('searches plain text and regular expressions', async () => {
    const { server } = setup({
      SnapshotService: {
        getFileTree: vi.fn(async () => [{ path: 'main.tex', kind: 'doc' }]),
        readDoc: vi.fn(async () => ({
          path: 'main.tex',
          lines: ['alpha 123', 'beta'],
          totalLines: 2,
        })),
      },
    })
    const plain = await server._registeredTools.search.handler({
      project: 'a'.repeat(24),
      query: 'alpha',
    })
    const regex = await server._registeredTools.search.handler({
      project: 'a'.repeat(24),
      query: '^beta$',
      regex: true,
    })
    expect(plain.structuredContent).toMatchObject({
      count: 1,
      truncated: false,
      matches: [{ path: 'main.tex', line: 1, text: 'alpha 123' }],
    })
    expect(regex.structuredContent).toMatchObject({
      count: 1,
      truncated: false,
      matches: [{ path: 'main.tex', line: 2, text: 'beta' }],
    })
  })

  it('returns a structured error for an invalid regular expression', async () => {
    const { server } = setup()
    const result = await server._registeredTools.search.handler({
      project: 'a'.repeat(24),
      query: '[',
      regex: true,
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('error')
  })

  it('returns labels and updates as distinct history entry types', async () => {
    const { server } = setup({
      LabelService: {
        listLabels: vi.fn(async () => [
          {
            version: 4,
            comment: 'Agent change',
            user_id: 'user-1',
            created_at: '2026-01-02T00:00:00Z',
          },
        ]),
      },
      fetchJson: vi.fn(async () => ({
        updates: [
          {
            from_version: 3,
            to_version: 4,
            origin: { kind: 'mcp' },
            users: ['user-1'],
            timestamp: '2026-01-01T00:00:00Z',
            pathnames: ['main.tex'],
          },
        ],
      })),
      settings: { apis: { project_history: { url: 'http://history' } } },
    })
    const result = await server._registeredTools.list_history.handler({
      project: 'a'.repeat(24),
    })
    expect(result.structuredContent).toEqual({
      count: 2,
      entries: [
        {
          type: 'label',
          version: 4,
          comment: 'Agent change',
          user: 'user-1',
          created_at: '2026-01-02T00:00:00Z',
        },
        {
          type: 'update',
          from_version: 3,
          to_version: 4,
          origin: { kind: 'mcp' },
          users: ['user-1'],
          timestamp: '2026-01-01T00:00:00Z',
          pathnames: ['main.tex'],
        },
      ],
    })
  })

  it('returns an error when every requested write fails', async () => {
    const { server } = setup({
      WriteService: {
        writeFiles: vi.fn(async () => ({
          version: 5,
          label: null,
          applied: [],
          failed: [{ path: 'main.tex', error: 'EACCES' }],
        })),
      },
    })
    const result = await server._registeredTools.write_files.handler({
      project: 'a'.repeat(24),
      message: 'm',
      files: [{ path: 'main.tex', content: 'x' }],
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('write_failed')
    expect(result.structuredContent.failed).toEqual([
      { path: 'main.tex', error: 'EACCES' },
    ])
    expect(result.structuredContent.next_action).toContain(
      'nothing was written'
    )
  })

  it('keeps partial write failures as successful results', async () => {
    const { server } = setup({
      WriteService: {
        writeFiles: vi.fn(async () => ({
          version: 5,
          label: { comment: 'm' },
          applied: ['main.tex'],
          failed: [{ path: 'fig.png', error: 'EACCES' }],
        })),
      },
    })
    const result = await server._registeredTools.write_files.handler({
      project: 'a'.repeat(24),
      message: 'm',
      files: [
        { path: 'main.tex', content: 'x' },
        { path: 'fig.png', content: 'y' },
      ],
    })
    expect(result.isError).toBe(false)
    expect(result.structuredContent.failed).toEqual([
      { path: 'fig.png', error: 'EACCES' },
    ])
  })

  it('returns an error when every revert file fails', async () => {
    const { server } = setup({
      RevertService: {
        revertTo: vi.fn(async () => ({
          version: 5,
          label: null,
          applied: [],
          failed: [{ path: 'main.tex', error: 'EACCES' }],
        })),
      },
    })
    const result = await server._registeredTools.revert_to.handler({
      project: 'a'.repeat(24),
      version: 1,
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('write_failed')
  })

  it('returns version conflict payload for writes', async () => {
    const err = Object.assign(new Error('conflict'), {
      code: 'version_conflict',
      expectedVersion: 1,
      actualVersion: 2,
    })
    const { server } = setup({
      WriteService: {
        writeFiles: vi.fn(async () => {
          throw err
        }),
      },
    })
    const result = await server._registeredTools.write_files.handler({
      project: 'a'.repeat(24),
      message: 'm',
      files: [],
      base_version: 1,
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.actual_version).toBe(2)
  })
  it('returns plain-object structured content for every tool', async () => {
    const { server } = setup()
    const project = 'a'.repeat(24)
    const argumentsByTool = {
      list_projects: {},
      get_project: { project },
      read_file: { project, path: 'main.tex' },
      get_outline: { project },
      search: { project, query: 'one' },
      list_history: { project },
      diff: { project, from_version: 1, to_version: 2 },
      create_label: { project, comment: 'done' },
      write_files: { project, message: 'm', files: [] },
      revert_to: { project, version: 1 },
      create_branch: { project, name: 'test' },
      list_branches: { project },
      diff_branch: { branch: project },
      merge_branch: { branch: project },
      archive_branch: { branch: project },
      edit_file: {
        project,
        path: 'main.tex',
        base_version: 4,
        edits: [],
        message: 'm',
      },
      list_comments: { project },
      get_review_queue: { project },
      reply_comment: { project, thread_id: 't', content: 'c' },
      resolve_comment: { project, thread_id: 't' },
      reopen_comment: { project, thread_id: 't' },
      add_comment: {
        project,
        path: 'main.tex',
        anchor: { exact: 'one' },
        content: 'c',
      },
      reanchor_comment: {
        project,
        thread_id: 't',
        path: 'main.tex',
        anchor: { exact: 'one' },
      },
      suggest_edits: {
        project,
        path: 'main.tex',
        base_version: 4,
        edits: [],
        message: 'm',
      },
      list_suggestions: { project },
      accept_suggestions: { project, path: 'main.tex', all: true },
      reject_suggestions: { project, path: 'main.tex', all: true },
      get_backup_status: { project },
      backup_now: { project },
    }
    for (const [name, tool] of Object.entries(server._registeredTools)) {
      const result = await tool.handler(argumentsByTool[name])
      expect(typeof result.structuredContent).toBe('object')
      expect(Array.isArray(result.structuredContent)).toBe(false)
    }
  })
})

describe('github backup tools', () => {
  it('reports the linked repository and can ask for a backup', async () => {
    const { server, services } = setup()
    const project = 'a'.repeat(24)

    const status = await server._registeredTools.get_backup_status.handler({
      project,
    })
    expect(status.structuredContent.owner).toBe('octocat')
    expect(status.content[0].text).toContain('octocat/backup')

    const backedUp = await server._registeredTools.backup_now.handler({
      project,
    })
    expect(backedUp.structuredContent.status).toBe('ok')
    expect(services.GithubBackupService.promises.syncNow).toHaveBeenCalledWith(
      project,
      { force: true }
    )
    expect(services.ProjectRef.requireAccess).toHaveBeenCalledWith(
      'u',
      project,
      'write'
    )
  })

  it('says so when the server has no backup module', async () => {
    const { server } = setup({ GithubBackupService: undefined })
    const result = await server._registeredTools.get_backup_status.handler({
      project: 'a'.repeat(24),
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('backup_disabled')
  })
})

describe('edit_file', () => {
  const call = async (edit, overrides = {}, lines = ['one', 'two']) => {
    const writeFiles = vi.fn(async () => ({
      version: 5,
      label: { comment: 'm' },
    }))
    const { server } = setup({
      settings: { max_doc_length: 1000 },
      SnapshotService: {
        readDoc: vi.fn(async () => ({
          path: 'main.tex',
          lines,
          totalLines: lines.length,
        })),
      },
      WriteService: { writeFiles },
      ...overrides,
    })
    const result = await server._registeredTools.edit_file.handler({
      project: 'a'.repeat(24),
      path: 'main.tex',
      base_version: 4,
      edits: [edit],
      message: 'edit',
    })
    return { result, writeFiles }
  }

  it('replaces a line range', async () => {
    const { result, writeFiles } = await call({
      type: 'replace_range',
      start_line: 1,
      end_line: 1,
      new_text: 'new',
    })
    expect(result.structuredContent.project_version).toBe(5)
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [{ path: 'main.tex', content: 'new\ntwo' }],
      })
    )
  })

  it('inserts with an empty line range', async () => {
    const { writeFiles } = await call({
      type: 'replace_range',
      start_line: 2,
      end_line: 1,
      new_text: 'inserted',
    })
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [{ path: 'main.tex', content: 'one\ninserted\ntwo' }],
      })
    )
  })

  it('replaces the requested anchor occurrence', async () => {
    const { writeFiles } = await call(
      { type: 'replace_anchor', anchor: 'one', occurrence: 2, new_text: 'ONE' },
      {},
      ['one one', 'two one']
    )
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [{ path: 'main.tex', content: 'one ONE\ntwo one' }],
      })
    )
  })

  it('replaces a middle section and keeps the next section', async () => {
    const { writeFiles } = await call(
      {
        type: 'replace_section',
        title: 'one',
        new_text: '\\section{one}\nchanged',
      },
      {},
      [
        '\\section{one}',
        'old body',
        '\\section{two}',
        'two body',
        '\\end{document}',
      ]
    )
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [
          {
            path: 'main.tex',
            content:
              '\\section{one}\nchanged\n\\section{two}\ntwo body\n\\end{document}',
          },
        ],
      })
    )
  })

  it('stops the last section at end document', async () => {
    const { writeFiles } = await call(
      {
        type: 'replace_section',
        title: 'last',
        new_text: '\\section{last}\nnew body',
      },
      {},
      ['\\section{last}', 'old body', '\\end{document}']
    )
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [
          {
            path: 'main.tex',
            content: '\\section{last}\nnew body\n\\end{document}',
          },
        ],
      })
    )
  })

  it('stops a subsection at the next section or subsection', async () => {
    const { writeFiles } = await call(
      {
        type: 'replace_section',
        title: 'child',
        level: 'subsection',
        new_text: '\\subsection{child}\nnew child',
      },
      {},
      [
        '\\section{parent}',
        '\\subsection{child}',
        'old child',
        '\\subsection{sibling}',
        'sibling body',
        '\\section{next}',
        'next body',
        '\\subsection{later}',
        'later body',
      ]
    )
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [
          {
            path: 'main.tex',
            content:
              '\\section{parent}\n\\subsection{child}\nnew child\n\\subsection{sibling}\nsibling body\n\\section{next}\nnext body\n\\subsection{later}\nlater body',
          },
        ],
      })
    )
  })

  it('matches starred headings', async () => {
    const { writeFiles } = await call(
      {
        type: 'replace_section',
        title: 'x',
        new_text: '\\section*{x}\nnew body',
      },
      {},
      ['\\section*{x}', 'old body', '\\section{next}', 'next body']
    )
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [
          {
            path: 'main.tex',
            content: '\\section*{x}\nnew body\n\\section{next}\nnext body',
          },
        ],
      })
    )
  })

  it('surfaces the comments the write affected', async () => {
    const affected = [
      { thread_id: 't1', path: 'main.tex', state: 'shrunk' },
      { thread_id: 't2', path: 'main.tex', state: 'detached' },
    ]
    const { result } = await call(
      { type: 'replace_range', start_line: 1, end_line: 1, new_text: 'new' },
      {
        WriteService: {
          writeFiles: vi.fn(async () => ({
            version: 5,
            label: { comment: 'm' },
            comments_affected: affected,
          })),
        },
      }
    )
    expect(result.structuredContent.comments_affected).toEqual(affected)
  })

  it('rejects section replacement text without its heading', async () => {
    const { result } = await call(
      {
        type: 'replace_section',
        title: 'one',
        new_text: 'changed',
      },
      {},
      ['\\section{one}', 'old body', '\\end{document}']
    )
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('invalid_edit')
  })

  it('reports ambiguous anchors and oversized files', async () => {
    const ambiguous = await call(
      { type: 'replace_anchor', anchor: 'o', new_text: 'x' },
      {
        SnapshotService: {
          readDoc: vi.fn(async () => ({ lines: ['one', 'two'] })),
        },
      }
    )
    expect(ambiguous.result.structuredContent.code).toBe('anchor_ambiguous')
    expect(ambiguous.result.structuredContent.next_action).toContain(
      'unique anchor'
    )
    const missing = await call({
      type: 'replace_anchor',
      anchor: 'missing',
      new_text: 'x',
    })
    expect(missing.result.structuredContent.code).toBe('anchor_not_found')
    expect(missing.result.structuredContent.next_action).toContain(
      'current content'
    )
    const large = await call(
      {
        type: 'replace_range',
        start_line: 1,
        end_line: 1,
        new_text: 'x'.repeat(20),
      },
      { settings: { max_doc_length: 2 } }
    )
    expect(large.result.structuredContent.code).toBe('file_too_large')
  })
})

// Labels are milestones now: a write records its intent in the history entry
// and only marks a saved version when the agent says so.
describe('label semantics', () => {
  const project = 'a'.repeat(24)

  it('write_files does not label by default and labels on request', async () => {
    const { server, services } = setup()
    await server._registeredTools.write_files.handler({
      project,
      message: 'm',
      files: [],
    })
    expect(services.WriteService.writeFiles.mock.calls[0][2].label).toBe(false)

    await server._registeredTools.write_files.handler({
      project,
      message: 'm',
      files: [],
      label: true,
    })
    expect(services.WriteService.writeFiles.mock.calls[1][2].label).toBe(true)
  })

  it('edit_file passes the label flag through to the write', async () => {
    const writeFiles = vi.fn(async () => ({ version: 5, label: null }))
    const { server } = setup({
      settings: { max_doc_length: 1000 },
      SnapshotService: {
        readDoc: vi.fn(async () => ({ path: 'main.tex', lines: ['one'] })),
      },
      WriteService: { writeFiles },
    })
    await server._registeredTools.edit_file.handler({
      project,
      path: 'main.tex',
      base_version: 4,
      edits: [],
      message: 'm',
    })
    expect(writeFiles.mock.calls[0][2].label).toBe(false)

    await server._registeredTools.edit_file.handler({
      project,
      path: 'main.tex',
      base_version: 4,
      edits: [],
      message: 'm',
      label: true,
    })
    expect(writeFiles.mock.calls[1][2].label).toBe(true)
  })

  it('suggest_edits passes the label flag through to the suggestion', async () => {
    const suggestDocContent = vi.fn(async () => ({
      version: 5,
      label: null,
      change_ids: [],
    }))
    const { server } = setup({
      settings: { max_doc_length: 1000 },
      SnapshotService: {
        readDoc: vi.fn(async () => ({ path: 'main.tex', lines: ['one'] })),
      },
      ProjectEntityHandler: {
        promises: {
          getAllDocPathsFromProjectById: vi.fn(async () => ({
            d1: '/main.tex',
          })),
        },
      },
      SuggestionService: { suggestDocContent, listSuggestions: vi.fn() },
    })
    await server._registeredTools.suggest_edits.handler({
      project,
      path: 'main.tex',
      base_version: 4,
      edits: [],
      message: 'm',
      label: true,
    })
    expect(suggestDocContent.mock.calls[0][3].label).toBe(true)
  })

  it('create_label labels the latest version, or the one it was given', async () => {
    const { server, services } = setup()

    const latest = await server._registeredTools.create_label.handler({
      project,
      comment: 'Review round 1 handled',
    })
    expect(services.LabelService.createLabel).toHaveBeenCalledWith(
      project,
      'u',
      4,
      'Review round 1 handled'
    )
    expect(latest.structuredContent).toEqual({
      project_version: 4,
      label: { id: 'label-1', comment: 'Review round 1 handled' },
    })
    expect(latest.content[0].text).toContain('Review round 1 handled')

    await server._registeredTools.create_label.handler({
      project,
      comment: 'An earlier milestone',
      version: 2,
    })
    expect(services.LabelService.createLabel.mock.calls[1][2]).toBe(2)
  })

  it('create_label needs write access', async () => {
    const error = Object.assign(new Error('forbidden'), { code: 'forbidden' })
    const { server } = setup({
      ProjectRef: {
        parse: x => ({ projectId: x }),
        urlFor: x => x,
        requireAccess: vi.fn(async (_userId, _id, level) => {
          if (level === 'write') throw error
        }),
      },
    })
    const result = await server._registeredTools.create_label.handler({
      project,
      comment: 'nope',
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.code).toBe('forbidden')
  })

  it('tells the agent to mark a finished review round with a label', async () => {
    const { server } = setup({
      ProjectEntityHandler: {
        promises: { getAllDocPathsFromProjectById: vi.fn(async () => ({})) },
      },
      ReviewService: {
        listThreads: vi.fn(async () => ({})),
        getDocRanges: vi.fn(async () => ({ lines: [], ranges: {} })),
      },
    })
    const result = await server._registeredTools.get_review_queue.handler({
      project,
    })
    expect(result.content[0].text).toContain('call create_label')
  })
})

describe('structured errors from internal services', () => {
  const project = 'a'.repeat(24)

  it('surfaces the code, status and details of a refusal', async () => {
    const error = Object.assign(new Error('tracked changes need sharejs'), {
      code: 'ot_type_unsupported',
      status: 422,
      details: { ot_type: 'history-ot' },
    })
    const { server } = setup({
      settings: { max_doc_length: 1000 },
      SnapshotService: {
        readDoc: vi.fn(async () => ({ path: 'main.tex', lines: ['one'] })),
      },
      ProjectEntityHandler: {
        promises: {
          getAllDocPathsFromProjectById: vi.fn(async () => ({
            d1: '/main.tex',
          })),
        },
      },
      SuggestionService: {
        suggestDocContent: vi.fn(async () => {
          throw error
        }),
        listSuggestions: vi.fn(),
      },
    })
    const result = await server._registeredTools.suggest_edits.handler({
      project,
      path: 'main.tex',
      base_version: 4,
      edits: [],
      message: 'm',
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      code: 'ot_type_unsupported',
      message: 'tracked changes need sharejs',
      status: 422,
      details: { ot_type: 'history-ot' },
    })
    expect(result.structuredContent.next_action).toContain('edit_file')
  })

  it('tells the agent what to do about an uncoded service failure', async () => {
    const error = Object.assign(
      new Error('the request failed with status 503'),
      { code: 'chat_request_failed', status: 503 }
    )
    const { server } = setup({
      ProjectEntityHandler: {
        promises: {
          getAllDocPathsFromProjectById: vi.fn(async () => ({
            d1: '/main.tex',
          })),
        },
      },
      ReviewService: {
        listThreads: vi.fn(async () => {
          throw error
        }),
        getDocRanges: vi.fn(async () => ({ lines: [], ranges: {} })),
      },
    })
    const result = await server._registeredTools.list_comments.handler({
      project,
    })
    expect(result.structuredContent.status).toBe(503)
    expect(result.structuredContent.next_action).toContain('Overleaf service')
  })
})
