import { describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

const projectId = '68c1f9a3e4b0c2d1a5f6e7b8'
const docId = '5f6e7b868c1f9a3e4b0c2d1a'
const threadId = '6f6e7b868c1f9a3e4b0c2d1a'

// Loads the client with `fetchJson` replaced by the given stub.
async function clientWith(fetchJson) {
  vi.resetModules()
  vi.doMock('@overleaf/settings', () => ({
    default: { apis: { documentupdater: { url: 'http://docupdater.test' } } },
  }))
  vi.doMock('@overleaf/fetch-utils', () => ({ fetchJson }))
  const module = await import('../../../app/src/DocumentUpdaterClient.mjs')
  return module.default
}

function requestFailure(status, body) {
  return Object.assign(new Error('request failed'), {
    body,
    response: { status },
  })
}

describe('review document-updater client', () => {
  it('posts the comment range to the document-updater endpoint', async () => {
    const fetchJson = sinon.stub().resolves({ comment: { id: threadId } })
    const client = await clientWith(fetchJson)
    const result = await client.addCommentRange(projectId, docId, 'user-1', {
      threadId,
      position: 4,
      text: 'two',
    })
    expect(result).toEqual({ comment: { id: threadId } })
    const [url, options] = fetchJson.firstCall.args
    expect(url).toBe(
      `http://docupdater.test/project/${projectId}/doc/${docId}/comment`
    )
    expect(options.method).toBe('POST')
    expect(options.json).toEqual({
      user_id: 'user-1',
      thread_id: threadId,
      position: 4,
      text: 'two',
    })
  })

  it('turns a text_mismatch response into an error carrying the actual text', async () => {
    const fetchJson = sinon.stub().rejects(
      requestFailure(
        400,
        JSON.stringify({
          code: 'text_mismatch',
          message: 'text does not match the document at this position',
          position: 4,
          actual_text: 'thr',
        })
      )
    )
    const client = await clientWith(fetchJson)
    const error = await client
      .addCommentRange(projectId, docId, 'user-1', {
        threadId,
        position: 4,
        text: 'two',
      })
      .catch(error => error)
    expect(error.code).toBe('text_mismatch')
    expect(error.actualText).toBe('thr')
    expect(error.status).toBe(400)
    expect(error.details).toEqual({ position: 4, actual_text: 'thr' })
  })

  it('keeps the code of any other refusal', async () => {
    const fetchJson = sinon
      .stub()
      .rejects(
        requestFailure(
          422,
          JSON.stringify({ code: 'ot_type_unsupported', message: 'nope' })
        )
      )
    const client = await clientWith(fetchJson)
    const error = await client
      .addCommentRange(projectId, docId, 'user-1', {
        threadId,
        position: 0,
        text: 'x',
      })
      .catch(error => error)
    expect(error.code).toBe('ot_type_unsupported')
    expect(error.message).toBe('nope')
    expect(error.status).toBe(422)
  })

  it('asks setDoc to record the diff as tracked changes', async () => {
    const fetchJson = sinon.stub().resolves({ rev: '9', change_ids: ['c1'] })
    const client = await clientWith(fetchJson)
    const source = { kind: 'mcp', agent: 'claude', suggestion: true }
    const result = await client.setDocumentTracked(
      projectId,
      docId,
      'user-1',
      ['one', 'two'],
      source
    )
    expect(result).toEqual({ rev: '9', change_ids: ['c1'] })
    const [url, options] = fetchJson.firstCall.args
    expect(url).toBe(`http://docupdater.test/project/${projectId}/doc/${docId}`)
    expect(options.method).toBe('POST')
    expect(options.json).toEqual({
      lines: ['one', 'two'],
      source,
      user_id: 'user-1',
      track_changes: true,
    })
  })

  it('reports no change ids when setDoc answers without them', async () => {
    const fetchJson = sinon.stub().resolves({ rev: '9' })
    const client = await clientWith(fetchJson)
    const result = await client.setDocumentTracked(
      projectId,
      docId,
      'user-1',
      ['one'],
      'mcp'
    )
    expect(result.change_ids).toEqual([])
  })

  it('turns a refusal of the tracked write into an error carrying its code', async () => {
    const fetchJson = sinon.stub().rejects(
      requestFailure(
        422,
        JSON.stringify({
          code: 'ot_type_unsupported',
          message: 'tracked changes are only supported on sharejs documents',
        })
      )
    )
    const client = await clientWith(fetchJson)
    const error = await client
      .setDocumentTracked(projectId, docId, 'user-1', ['one'], 'mcp')
      .catch(error => error)
    expect(error.code).toBe('ot_type_unsupported')
    expect(error.message).toBe(
      'tracked changes are only supported on sharejs documents'
    )
  })

  it('types a failure with no JSON body by its status and body text', async () => {
    const fetchJson = sinon
      .stub()
      .rejects(requestFailure(500, 'Oops, something went wrong'))
    const client = await clientWith(fetchJson)
    const error = await client
      .addCommentRange(projectId, docId, 'user-1', {
        threadId,
        position: 0,
        text: 'x',
      })
      .catch(error => error)
    expect(error.code).toBe('document_updater_request_failed')
    expect(error.status).toBe(500)
    expect(error.message).toBe(
      'the request failed with status 500: Oops, something went wrong'
    )
  })

  it('types a coded failure of the tracked write with its status and details', async () => {
    const fetchJson = sinon.stub().rejects(
      requestFailure(
        422,
        JSON.stringify({
          code: 'ot_type_unsupported',
          message: 'tracked changes need a sharejs document',
          ot_type: 'history-ot',
        })
      )
    )
    const client = await clientWith(fetchJson)
    const error = await client
      .setDocumentTracked(projectId, docId, 'user-1', ['one'], 'mcp')
      .catch(error => error)
    expect(error.code).toBe('ot_type_unsupported')
    expect(error.status).toBe(422)
    expect(error.details).toEqual({ ot_type: 'history-ot' })
  })

  it('types an uncoded failure of the tracked write too', async () => {
    const fetchJson = sinon.stub().rejects(requestFailure(503, ''))
    const client = await clientWith(fetchJson)
    const error = await client
      .setDocumentTracked(projectId, docId, 'user-1', ['one'], 'mcp')
      .catch(error => error)
    expect(error.code).toBe('document_updater_request_failed')
    expect(error.status).toBe(503)
    expect(error.details).toBeUndefined()
  })

  it('leaves a timeout or socket error alone', async () => {
    const original = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    })
    const fetchJson = sinon.stub().rejects(original)
    const client = await clientWith(fetchJson)
    const error = await client
      .addCommentRange(projectId, docId, 'user-1', {
        threadId,
        position: 0,
        text: 'x',
      })
      .catch(error => error)
    expect(error).toBe(original)
  })
})
