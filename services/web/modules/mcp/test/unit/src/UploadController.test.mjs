import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUploadHandler } from '../../../app/src/UploadController.mjs'

const MAX_BYTES = 16
const record = {
  projectId: 'a'.repeat(24),
  userId: 'u',
  tokenId: 't',
  path: 'figures/a.pdf',
  overwrite: false,
  message: 'add figure',
  agent: 'claude',
  label: false,
}

function requestWith(chunks, headers = {}) {
  const req = Readable.from(chunks.map(chunk => Buffer.from(chunk)))
  req.headers = { authorization: 'Bearer olu_ticket', ...headers }
  return req
}

function responseRecorder() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code
      return res
    },
    json(body) {
      res.body = body
    },
  }
  return res
}

describe('upload handler', () => {
  let dumpFolder
  let services
  let writtenBytes

  beforeEach(async () => {
    dumpFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-upload-'))
    writtenBytes = null
    services = {
      settings: { maxUploadSize: MAX_BYTES, path: { dumpFolder } },
      UploadService: {
        claim: vi.fn(async () => record),
        release: vi.fn(async () => {}),
        consume: vi.fn(async () => {}),
      },
      TokenService: {
        promises: { isTokenActive: vi.fn(async () => true) },
      },
      ProjectRef: { requireAccess: vi.fn(async () => true) },
      SnapshotService: { getFileTree: vi.fn(async () => []) },
      WriteService: {
        writeFiles: vi.fn(async (_id, _user, { files }) => {
          writtenBytes = await fs.readFile(files[0].contentPath)
          return { version: 7, label: null, applied: [files[0].path] }
        }),
      },
    }
  })

  afterEach(async () => {
    await fs.rm(dumpFolder, { recursive: true })
  })

  async function send(req) {
    const res = responseRecorder()
    await createUploadHandler(services)(req, res)
    return res
  }

  async function expectNothingWritten() {
    expect(services.WriteService.writeFiles).not.toHaveBeenCalled()
    await expectNoTempFiles()
  }

  async function expectNoTempFiles() {
    expect(await fs.readdir(dumpFolder)).toEqual([])
  }

  it('writes the bytes as they arrived and spends the ticket', async () => {
    const res = await send(requestWith(['%PDF', '\u0000binary']))
    const expected = Buffer.from('%PDF\u0000binary')
    expect(writtenBytes.equals(expected)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      path: 'figures/a.pdf',
      bytes: expected.length,
      sha256: crypto.createHash('sha256').update(expected).digest('hex'),
      project_version: 7,
      label: null,
    })
    const [projectId, userId, options] =
      services.WriteService.writeFiles.mock.calls[0]
    expect(projectId).toBe(record.projectId)
    expect(userId).toBe('u')
    expect(options).toMatchObject({ message: 'add figure', agent: 'claude' })
    expect(services.UploadService.consume).toHaveBeenCalledWith('olu_ticket')
    expect(services.UploadService.release).not.toHaveBeenCalled()
    await expectNoTempFiles()
  })

  it('answers an unusable ticket without reading the body', async () => {
    services.UploadService.claim = vi.fn(async () => {
      throw Object.assign(new Error('invalid'), {
        code: 'upload_ticket_invalid',
      })
    })
    const res = await send(requestWith(['data']))
    expect(res.statusCode).toBe(401)
    expect(res.body.code).toBe('upload_ticket_invalid')
    expect(res.body.next_action).toContain('create_upload')
    expect(services.UploadService.release).not.toHaveBeenCalled()
    await expectNothingWritten()
  })

  it.each([
    ['application/x-www-form-urlencoded'],
    ['application/json; charset=utf-8'],
    ['multipart/form-data; boundary=x'],
  ])('refuses %s and gives the ticket back', async contentType => {
    const res = await send(
      requestWith(['data'], { 'content-type': contentType })
    )
    expect(res.statusCode).toBe(415)
    expect(res.body.code).toBe('unsupported_content_type')
    expect(services.UploadService.release).toHaveBeenCalledWith('olu_ticket')
    await expectNothingWritten()
  })

  it('accepts a type web has no parser for', async () => {
    const res = await send(
      requestWith(['data'], { 'content-type': 'application/pdf' })
    )
    expect(res.statusCode).toBe(200)
  })

  it('refuses a declared size over the limit before reading', async () => {
    const res = await send(
      requestWith(['data'], { 'content-length': String(MAX_BYTES + 1) })
    )
    expect(res.statusCode).toBe(413)
    expect(res.body.code).toBe('file_too_large')
    expect(services.UploadService.release).toHaveBeenCalled()
    await expectNothingWritten()
  })

  it('refuses a body that outgrows the limit while streaming', async () => {
    const res = await send(requestWith(['0123456789', '0123456789']))
    expect(res.statusCode).toBe(413)
    expect(services.UploadService.release).toHaveBeenCalled()
    await expectNothingWritten()
  })

  it('takes a body of exactly the limit', async () => {
    const res = await send(requestWith(['0'.repeat(MAX_BYTES)]))
    expect(res.statusCode).toBe(200)
    expect(res.body.bytes).toBe(MAX_BYTES)
  })

  it('refuses an empty body', async () => {
    const res = await send(requestWith([]))
    expect(res.statusCode).toBe(400)
    expect(res.body.code).toBe('empty_file')
    expect(services.UploadService.release).toHaveBeenCalled()
    await expectNothingWritten()
  })

  it('stops working once the token is revoked', async () => {
    services.TokenService.promises.isTokenActive = vi.fn(async () => false)
    const res = await send(requestWith(['data']))
    expect(res.statusCode).toBe(401)
    expect(services.TokenService.promises.isTokenActive).toHaveBeenCalledWith(
      't'
    )
    await expectNothingWritten()
  })

  it('stops working once write access is gone', async () => {
    services.ProjectRef.requireAccess = vi.fn(async () => {
      throw Object.assign(new Error('forbidden'), { code: 'forbidden' })
    })
    const res = await send(requestWith(['data']))
    expect(res.statusCode).toBe(403)
    expect(services.ProjectRef.requireAccess).toHaveBeenCalledWith(
      'u',
      record.projectId,
      'write'
    )
    await expectNothingWritten()
  })

  it('refuses a path that appeared since the ticket was issued', async () => {
    services.SnapshotService.getFileTree = vi.fn(async () => [
      { path: 'figures/a.pdf' },
    ])
    const res = await send(requestWith(['data']))
    expect(res.statusCode).toBe(409)
    expect(res.body.code).toBe('file_exists')
    expect(res.body.next_action).toContain('create_upload')
    await expectNothingWritten()
  })

  it('replaces the path when the ticket says overwrite', async () => {
    services.UploadService.claim = vi.fn(async () => ({
      ...record,
      overwrite: true,
    }))
    services.SnapshotService.getFileTree = vi.fn(async () => [
      { path: 'figures/a.pdf' },
    ])
    const res = await send(requestWith(['data']))
    expect(res.statusCode).toBe(200)
  })

  it('keeps the ticket when the write fails', async () => {
    services.WriteService.writeFiles = vi.fn(async () => ({
      version: 6,
      applied: [],
      failed: [{ path: 'figures/a.pdf', error: 'too many files' }],
    }))
    const res = await send(requestWith(['data']))
    expect(res.statusCode).toBe(422)
    expect(res.body).toMatchObject({
      code: 'write_failed',
      message: 'too many files',
    })
    expect(services.UploadService.consume).not.toHaveBeenCalled()
    expect(services.UploadService.release).toHaveBeenCalled()
    await expectNoTempFiles()
  })

  it('gives the ticket back when the client disconnects', async () => {
    const req = new Readable({
      read() {
        this.push(Buffer.from('part'))
        this.destroy(new Error('aborted'))
      },
    })
    req.headers = { authorization: 'Bearer olu_ticket' }
    const failure = await send(req).catch(error => error)
    expect(failure.message).toBe('aborted')
    expect(services.UploadService.release).toHaveBeenCalled()
    await expectNothingWritten()
  })
})
