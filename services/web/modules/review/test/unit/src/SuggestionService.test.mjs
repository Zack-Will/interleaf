import { beforeEach, describe, expect, it } from 'vitest'
import sinon from 'sinon'
import { createSuggestionService } from '../../../app/src/SuggestionService.mjs'

const projectId = '68c1f9a3e4b0c2d1a5f6e7b8'
const docId = '5f6e7b868c1f9a3e4b0c2d1a'
const otherDocId = '4f6e7b868c1f9a3e4b0c2d1b'

// '\\section{Intro}' is 15 characters, so line 2 starts at offset 16.
const lines = ['\\section{Intro}', 'Hello world.']

function insertChange(id, position, text, userId = 'agent-user') {
  return {
    id,
    op: { i: text, p: position },
    metadata: { user_id: userId, ts: '2026-01-01T00:00:00.000Z' },
  }
}

function deleteChange(id, position, text, userId = 'agent-user') {
  return {
    id,
    op: { d: text, p: position },
    metadata: { user_id: userId, ts: '2026-01-02T00:00:00.000Z' },
  }
}

describe('suggestion service', () => {
  beforeEach(ctx => {
    ctx.changes = [insertChange('change-2', 16, 'Hi ')]
    ctx.documentUpdater = {
      promises: {
        acceptChanges: sinon.stub().resolves(),
        rejectChanges: sinon.stub().resolves({ rejectedChangeIds: [] }),
      },
    }
    ctx.documentUpdaterClient = {
      promises: {
        setDocumentTracked: sinon
          .stub()
          .resolves({ rev: '7', change_ids: ['change-2'] }),
      },
    }
    ctx.projectEntityHandler = {
      promises: {
        getAllDocPathsFromProjectById: sinon
          .stub()
          .resolves({ [docId]: '/main.tex', [otherDocId]: '/refs.tex' }),
      },
    }
    ctx.reviewService = {
      getDocRanges: sinon.stub().callsFake(async (_projectId, id) => ({
        lines,
        ranges: { changes: id === docId ? ctx.changes : [] },
        version: 7,
      })),
    }
    ctx.userInfoManager = {
      promises: { getPersonalInfo: sinon.stub().resolves({ _id: 'agent' }) },
    }
    ctx.userInfoController = {
      formatPersonalInfo: sinon
        .stub()
        .returns({ id: 'agent-user', first_name: 'Agent', last_name: 'MCP' }),
    }
    ctx.versionService = {
      promises: { getLatestVersion: sinon.stub().resolves({ version: 9 }) },
    }
    ctx.writeService = {
      promises: {
        withProjectWriteLock: sinon
          .stub()
          .callsFake(async (_projectId, _baseVersion, run) =>
            run({ version: 8 })
          ),
        createWriteLabel: sinon
          .stub()
          .resolves({ id: 'label-1', comment: 'Suggest: tighten the intro' }),
      },
    }
    ctx.service = createSuggestionService({
      DocumentUpdaterHandler: ctx.documentUpdater,
      DocumentUpdaterClient: ctx.documentUpdaterClient,
      ProjectEntityHandler: ctx.projectEntityHandler,
      ReviewService: ctx.reviewService,
      UserInfoController: ctx.userInfoController,
      UserInfoManager: ctx.userInfoManager,
      VersionService: ctx.versionService,
      WriteService: ctx.writeService,
    })
  })

  describe('suggestDocContent', () => {
    it('writes the document as tracked changes under the project write lock', async ctx => {
      const result = await ctx.service.suggestDocContent(
        projectId,
        docId,
        'agent-user',
        {
          lines: ['\\section{Intro}', 'Hi Hello world.'],
          agent: 'claude',
          message: 'tighten the intro',
          baseVersion: 8,
        }
      )
      const [lockedProject, baseVersion] =
        ctx.writeService.promises.withProjectWriteLock.firstCall.args
      expect(lockedProject).toBe(projectId)
      expect(baseVersion).toBe(8)
      const [, , userId, written, source] =
        ctx.documentUpdaterClient.promises.setDocumentTracked.firstCall.args
      expect(userId).toBe('agent-user')
      expect(written).toEqual(['\\section{Intro}', 'Hi Hello world.'])
      expect(source).toEqual({
        kind: 'mcp',
        agent: 'claude',
        message: 'tighten the intro',
        suggestion: true,
      })
      expect(result).toEqual({
        change_ids: ['change-2'],
        version: 9,
        label: { id: 'label-1', comment: 'Suggest: tighten the intro' },
      })
    })

    it('labels the history entry with the suggestion message', async ctx => {
      await ctx.service.suggestDocContent(projectId, docId, 'agent-user', {
        lines,
        message: 'tighten the intro',
      })
      expect(ctx.writeService.promises.createWriteLabel.firstCall.args).toEqual(
        [projectId, 'agent-user', 9, 'Suggest: tighten the intro']
      )
    })

    it('does not label a write that suggested nothing', async ctx => {
      ctx.documentUpdaterClient.promises.setDocumentTracked.resolves({
        change_ids: [],
      })
      const result = await ctx.service.suggestDocContent(
        projectId,
        docId,
        'agent-user',
        { lines, message: 'no change' }
      )
      expect(result.label).toBe(null)
      expect(ctx.writeService.promises.createWriteLabel.called).toBe(false)
    })
  })

  describe('listSuggestions', () => {
    it('reports each pending tracked change with its place and author', async ctx => {
      ctx.changes = [
        insertChange('change-2', 16, 'Hi '),
        deleteChange('change-3', 22, 'world'),
      ]
      const result = await ctx.service.listSuggestions(projectId)
      expect(result.count).toBe(2)
      expect(result.files).toHaveLength(1)
      expect(result.files[0].path).toBe('main.tex')
      expect(result.files[0].suggestions[0]).toEqual({
        change_id: 'change-2',
        doc_id: docId,
        path: 'main.tex',
        type: 'insert',
        text: 'Hi ',
        position: 16,
        line: 2,
        column: 1,
        author: { id: 'agent-user', name: 'Agent MCP' },
        created_at: '2026-01-01T00:00:00.000Z',
      })
      expect(result.files[0].suggestions[1]).toMatchObject({
        change_id: 'change-3',
        type: 'delete',
        text: 'world',
        line: 2,
        column: 7,
      })
    })

    it('looks each author up once', async ctx => {
      ctx.changes = [
        insertChange('change-2', 16, 'Hi '),
        insertChange('change-3', 20, 'there '),
      ]
      await ctx.service.listSuggestions(projectId)
      expect(ctx.userInfoManager.promises.getPersonalInfo.callCount).toBe(1)
    })

    it('leaves out documents with nothing pending', async ctx => {
      const result = await ctx.service.listSuggestions(projectId)
      expect(result.files.map(file => file.path)).toEqual(['main.tex'])
    })

    it('limits the listing to one document when asked', async ctx => {
      const result = await ctx.service.listSuggestions(projectId, otherDocId)
      expect(result.count).toBe(0)
      expect(ctx.reviewService.getDocRanges.callCount).toBe(1)
    })

    it('still reports a suggestion whose author cannot be read', async ctx => {
      ctx.userInfoManager.promises.getPersonalInfo.rejects(new Error('boom'))
      const result = await ctx.service.listSuggestions(projectId)
      expect(result.suggestions[0].author).toEqual({ id: 'agent-user' })
    })
  })

  describe('acceptSuggestions and rejectSuggestions', () => {
    it('accepts the named changes and counts what is left', async ctx => {
      ctx.changes = [
        insertChange('change-2', 16, 'Hi '),
        insertChange('change-3', 20, 'there '),
      ]
      ctx.reviewService.getDocRanges.onSecondCall().resolves({
        lines,
        ranges: { changes: [insertChange('change-3', 20, 'there ')] },
      })
      const result = await ctx.service.acceptSuggestions(
        projectId,
        docId,
        ['change-2'],
        'human-1'
      )
      expect(ctx.documentUpdater.promises.acceptChanges.firstCall.args).toEqual(
        [projectId, docId, ['change-2'], 'human-1']
      )
      expect(result).toEqual({ change_ids: ['change-2'], remaining: 1 })
    })

    it('treats a null change id list as every pending suggestion', async ctx => {
      ctx.changes = [
        insertChange('change-2', 16, 'Hi '),
        insertChange('change-3', 20, 'there '),
      ]
      ctx.reviewService.getDocRanges
        .onSecondCall()
        .resolves({ lines, ranges: { changes: [] } })
      const result = await ctx.service.rejectSuggestions(
        projectId,
        docId,
        null,
        'human-1'
      )
      expect(ctx.documentUpdater.promises.rejectChanges.firstCall.args).toEqual(
        [projectId, docId, ['change-2', 'change-3'], 'human-1']
      )
      expect(result.remaining).toBe(0)
    })

    it('refuses a change id that is not pending', async ctx => {
      const error = await ctx.service
        .acceptSuggestions(projectId, docId, ['change-9'], 'human-1')
        .catch(error => error)
      expect(error.code).toBe('suggestion_not_found')
      expect(error.missingChangeIds).toEqual(['change-9'])
      expect(ctx.documentUpdater.promises.acceptChanges.called).toBe(false)
    })

    it('does not call document-updater when there is nothing pending', async ctx => {
      ctx.changes = []
      const result = await ctx.service.acceptSuggestions(
        projectId,
        docId,
        null,
        'human-1'
      )
      expect(result).toEqual({ change_ids: [], remaining: 0 })
      expect(ctx.documentUpdater.promises.acceptChanges.called).toBe(false)
    })
  })
})
