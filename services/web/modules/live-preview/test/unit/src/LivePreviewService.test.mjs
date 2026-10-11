import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import sinon from 'sinon'
import { createLivePreviewService } from '../../../app/src/LivePreviewService.mjs'
import {
  verifyTicket,
  verifyAccessToken,
} from '@overleaf/live-preview-protocol/Tickets.mjs'

const PROJECT = '0123456789abcdef01234567'
const USER = 'abcdef0123456789abcdef01'
const SECRET = 'live-preview-unit-test-secret'
const NOW = 1791676800000

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected rejection')
}

describe('LivePreviewService', () => {
  let settings, project, deps, service

  beforeEach(() => {
    settings = { enabled: true, ticketSecret: SECRET }
    project = {
      compiler: 'lualatex',
      rootDoc_id: 'root',
      overleaf: { history: { id: 'history-id' } },
    }
    deps = {
      settings,
      getProject: sinon.stub().resolves(project),
      getEntities: sinon.stub().returns({
        docs: [
          { path: '/sections/main.tex', doc: { _id: 'root' } },
          { path: '/intro.tex', doc: { _id: 'intro' } },
        ],
        files: [
          { path: '/figures/plot.pdf', file: { _id: 'plot', hash: 'hash-a' } },
        ],
      }),
      getDocument: sinon.stub(),
      getBlobUrl: sinon
        .stub()
        .callsFake(
          (history, hash) =>
            `http://filestore:3009/history/project/${history}/hash/${hash}`
        ),
      now: () => NOW,
    }
    deps.getDocument
      .withArgs(PROJECT, 'root', -1)
      .resolves({ lines: ['unsaved', '实时文本'], version: 42 })
    deps.getDocument
      .withArgs(PROJECT, 'intro', -1)
      .resolves({ lines: ['Introduction'], version: 7 })
    service = createLivePreviewService(deps)
  })

  afterEach(() => sinon.restore())

  it('issues open tickets accepted by the real P1 verifier and rejected for HTTP access', async () => {
    const result = await service.issueTicket(PROJECT, USER)
    expect(result.expiry).to.equal(NOW + 60000)
    expect(verifyTicket(result.ticket, SECRET, PROJECT, NOW)).to.deep.equal({
      project: PROJECT,
      user: USER,
      kind: 'open',
      expiry: NOW + 60000,
    })
    expect(() =>
      verifyAccessToken(result.ticket, SECRET, PROJECT, NOW)
    ).to.throw('Ticket is invalid')
    expect(() =>
      verifyTicket(result.ticket, SECRET, PROJECT, NOW + 60000)
    ).to.throw('Ticket is invalid')
    expect(() =>
      verifyTicket(result.ticket, 'wrong-secret', PROJECT, NOW)
    ).to.throw('Ticket is invalid')
    expect(() => verifyTicket(result.ticket, SECRET, USER, NOW)).to.throw(
      'Ticket is invalid'
    )
  })

  it('matches a fixed HMAC vector shared with the service issuer', async () => {
    const { ticket } = await service.issueTicket(PROJECT, USER)
    // Explicit vector checks encoding, property order, expiry units and signing
    // the encoded payload rather than its decoded JSON.
    expect(ticket).to.equal(
      'eyJwcm9qZWN0IjoiMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3IiwidXNlciI6ImFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMSIsImtpbmQiOiJvcGVuIiwiZXhwaXJ5IjoxNzkxNjc2ODYwMDAwfQ.RHYjgeuWoNgk1ZqUmzm-OVgdA0uTt6dyjMa7c7POpqI'
    )
  })

  it('rejects disabled requests before reading project storage', async () => {
    settings.enabled = false
    const error = await rejection(service.issueTicket(PROJECT, USER))
    expect(error).to.include({ code: 'live_preview_disabled', status: 404 })
    expect(deps.getProject.called).to.equal(false)
    expect((await rejection(service.snapshot(PROJECT))).code).to.equal(
      'live_preview_disabled'
    )
  })

  it('rejects non-LuaLaTeX projects', async () => {
    project.compiler = 'pdflatex'
    expect(await rejection(service.issueTicket(PROJECT, USER))).to.include({
      code: 'compiler_not_lualatex',
      status: 409,
    })
  })

  it('rejects missing users and unconfigured secrets', async () => {
    expect((await rejection(service.issueTicket(PROJECT, null))).code).to.equal(
      'login_required'
    )
    settings.ticketSecret = ''
    expect((await rejection(service.issueTicket(PROJECT, USER))).code).to.equal(
      'ticket_secret_missing'
    )
  })

  it('rejects invalid ids and missing projects', async () => {
    expect((await rejection(service.snapshot('../bad'))).code).to.equal(
      'invalid_project'
    )
    expect(deps.getProject.called).to.equal(false)
    deps.getProject.resolves(null)
    expect((await rejection(service.snapshot(PROJECT))).code).to.equal(
      'project_not_found'
    )
  })

  it('returns authoritative updater content, versions, nested root and immutable blob URLs', async () => {
    const snapshot = await service.snapshot(PROJECT)
    expect(snapshot).to.deep.equal({
      projectId: PROJECT,
      compiler: 'lualatex',
      rootDoc: 'sections/main.tex',
      docs: [
        {
          id: 'root',
          path: 'sections/main.tex',
          content: 'unsaved\n实时文本',
          version: 42,
        },
        { id: 'intro', path: 'intro.tex', content: 'Introduction', version: 7 },
      ],
      files: [
        {
          id: 'plot',
          path: 'figures/plot.pdf',
          blobUrl:
            'http://filestore:3009/history/project/history-id/hash/hash-a',
        },
      ],
    })
    expect(deps.getDocument.callCount).to.equal(2)
    expect(deps.getDocument.getCall(0).args).to.deep.equal([
      PROJECT,
      'root',
      -1,
    ])
    const entities = deps.getEntities.returnValues[0]
    entities.files[0].file.hash = 'hash-b'
    expect((await service.snapshot(PROJECT)).files[0].blobUrl).to.contain(
      'hash-b'
    )
  })

  it('uses CLSI root fallbacks only when no root is specified', async () => {
    delete project.rootDoc_id
    deps.getEntities.returns({
      docs: [{ path: '/main.tex', doc: { _id: 'root' } }],
      files: [],
    })
    expect((await service.snapshot(PROJECT)).rootDoc).to.equal('main.tex')
    deps.getEntities.returns({
      docs: [{ path: '/only.tex', doc: { _id: 'root' } }],
      files: [],
    })
    expect((await service.snapshot(PROJECT)).rootDoc).to.equal('only.tex')
    project.rootDoc_id = 'deleted'
    expect((await rejection(service.snapshot(PROJECT))).code).to.equal(
      'root_doc_missing'
    )
  })

  it('refuses files with no usable blob', async () => {
    delete project.overleaf.history.id
    expect((await rejection(service.snapshot(PROJECT))).code).to.equal(
      'blob_missing'
    )
  })
  it('rejects unsafe paths and excess entities before contacting document-updater', async () => {
    deps.getEntities.returns({
      docs: [{ doc: { _id: 'root' }, path: '/../secret' }],
      files: [],
    })
    expect((await rejection(service.snapshot(PROJECT))).code).to.equal(
      'invalid_path'
    )
    expect(deps.getDocument.called).to.equal(false)
    deps.getEntities.returns({
      docs: Array(2001).fill({ doc: { _id: 'root' }, path: '/main.tex' }),
      files: [],
    })
    expect((await rejection(service.snapshot(PROJECT))).code).to.equal(
      'snapshot_too_large'
    )
    expect(deps.getDocument.called).to.equal(false)
  })
  it('bounds UTF-8 document and aggregate snapshot bytes', async () => {
    settings.maxFileBytes = 10
    expect((await rejection(service.snapshot(PROJECT))).code).to.equal(
      'snapshot_too_large'
    )
    settings.maxFileBytes = 32
    settings.maxResponseBytes = 20
    expect((await rejection(service.snapshot(PROJECT))).code).to.equal(
      'snapshot_too_large'
    )
  })
})
