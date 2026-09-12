import { describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

const docId = 'd'.repeat(24)

function comment(threadId, text, position) {
  return { id: `c-${threadId}`, op: { c: text, p: position, t: threadId } }
}

// Loads WriteService with document-updater returning `before` for the read
// taken ahead of the write and `after` for the one taken afterwards.
async function writeWith({ before, after, files, docPaths }) {
  vi.resetModules()
  const getDocument = sinon.stub()
  getDocument.onFirstCall().resolves(before)
  getDocument.onSecondCall().resolves(after)
  vi.doMock('@overleaf/settings', () => ({
    default: { path: { dumpFolder: '/tmp' } },
  }))
  vi.doMock('../../../../../app/src/infrastructure/LockManager.mjs', () => ({
    default: { promises: { runWithLock: async (_n, _id, fn) => fn() } },
  }))
  vi.doMock(
    '../../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs',
    () => ({
      default: {
        promises: { _mergeUpdate: sinon.stub(), deleteUpdate: sinon.stub() },
      },
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
    () => ({
      default: {
        promises: {
          getAllEntities: sinon.stub().resolves({ docs: [], files: [] }),
          getAllDocPathsFromProjectById: sinon
            .stub()
            .resolves(docPaths ?? { [docId]: '/main.tex' }),
        },
      },
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
    () => ({ default: { promises: { getDocument } } })
  )
  vi.doMock('../../../app/src/VersionService.mjs', () => ({
    default: {
      promises: { getLatestVersion: sinon.stub().resolves({ version: 4 }) },
    },
  }))
  vi.doMock('../../../app/src/LabelService.mjs', () => ({
    default: {
      promises: { createLabel: sinon.stub().resolves({ id: 'l' }) },
    },
  }))
  const { default: WriteService } =
    await import('../../../app/src/WriteService.mjs')
  const result = await WriteService.writeFiles('p', 'u', {
    message: 'm',
    files: files ?? [{ path: 'main.tex', content: 'new content' }],
  })
  return { result, getDocument }
}

async function stateOf(beforeComment, afterComments) {
  const { result } = await writeWith({
    before: { lines: ['old content'], ranges: { comments: [beforeComment] } },
    after: { lines: ['new content'], ranges: { comments: afterComments } },
  })
  return result.comments_affected
}

describe('WriteService comment tracking', () => {
  it('reports an untouched range as unchanged', async () => {
    expect(
      await stateOf(comment('t1', 'abc', 10), [comment('t1', 'abc', 10)])
    ).toEqual([{ thread_id: 't1', path: 'main.tex', state: 'unchanged' }])
  })

  it('reports a range pushed along by an earlier edit as moved', async () => {
    expect(
      await stateOf(comment('t1', 'abc', 10), [comment('t1', 'abc', 24)])
    ).toEqual([{ thread_id: 't1', path: 'main.tex', state: 'moved' }])
  })

  it('reports an extended range as grown', async () => {
    expect(
      await stateOf(comment('t1', 'abc', 10), [comment('t1', 'abcdef', 10)])
    ).toEqual([{ thread_id: 't1', path: 'main.tex', state: 'grown' }])
  })

  it('reports a partly deleted range as shrunk', async () => {
    expect(
      await stateOf(comment('t1', 'abc', 10), [comment('t1', 'a', 10)])
    ).toEqual([{ thread_id: 't1', path: 'main.tex', state: 'shrunk' }])
  })

  it('reports an emptied range as detached', async () => {
    expect(
      await stateOf(comment('t1', 'abc', 10), [comment('t1', '', 10)])
    ).toEqual([{ thread_id: 't1', path: 'main.tex', state: 'detached' }])
  })

  it('reports a range that disappeared entirely as detached', async () => {
    expect(await stateOf(comment('t1', 'abc', 10), [])).toEqual([
      { thread_id: 't1', path: 'main.tex', state: 'detached' },
    ])
  })

  it('classifies every range of a document in one write', async () => {
    const { result } = await writeWith({
      before: {
        lines: ['old content'],
        ranges: {
          comments: [
            comment('t1', 'abc', 10),
            comment('t2', 'abc', 20),
            comment('t3', 'abc', 30),
          ],
        },
      },
      after: {
        lines: ['new content'],
        ranges: {
          comments: [
            comment('t1', 'abc', 10),
            comment('t2', 'abcd', 20),
            comment('t3', '', 30),
          ],
        },
      },
    })
    expect(result.comments_affected.map(item => item.state)).toEqual([
      'unchanged',
      'grown',
      'detached',
    ])
  })

  it('does not read the document again when it had no comments', async () => {
    const { result, getDocument } = await writeWith({
      before: { lines: ['old content'], ranges: {} },
      after: { lines: ['new content'], ranges: {} },
    })
    expect(result.comments_affected).toEqual([])
    sinon.assert.calledOnce(getDocument)
  })

  it('skips binary files and paths with no document', async () => {
    const { result, getDocument } = await writeWith({
      before: { lines: ['old'], ranges: { comments: [comment('t1', 'a', 0)] } },
      after: { lines: ['new'], ranges: { comments: [comment('t1', 'a', 0)] } },
      files: [
        { path: 'image.png', contentBase64: 'aGk=' },
        { path: 'unknown.tex', content: 'hello' },
      ],
    })
    expect(result.comments_affected).toEqual([])
    sinon.assert.notCalled(getDocument)
  })
})
