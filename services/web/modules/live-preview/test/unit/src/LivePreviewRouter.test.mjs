import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sinon from 'sinon'
import express from 'express'
import { createLivePreviewRouter } from '../../../app/src/LivePreviewRouter.mjs'
import { LivePreviewError } from '../../../app/src/Errors.mjs'

const PROJECT = '0123456789abcdef01234567'

describe('LivePreviewRouter HTTP access gates', () => {
  let server, baseUrl, settings, service, authorization, privateAuth, userId

  beforeEach(async () => {
    settings = { enabled: true }
    userId = 'viewer'
    service = {
      issueTicket: sinon.stub().resolves({ ticket: 'signed', expiry: 123 }),
      snapshot: sinon.stub().resolves({ docs: [] }),
    }
    authorization = sinon.spy((req, res, next) => {
      if (req.headers['x-can-read'] !== 'true') return res.sendStatus(403)
      next()
    })
    privateAuth = sinon.spy((req, res, next) => {
      if (req.headers.authorization !== 'Basic test') return res.sendStatus(401)
      next()
    })
    const router = createLivePreviewRouter({
      settings,
      service,
      authorization,
      privateAuth,
      getUserId: () => userId,
    })
    const app = express()
    app.use((req, res, next) => {
      req.sessionID = 'private-session-id'
      next()
    })
    const web = express.Router()
    const internal = express.Router()
    router.apply(web, internal)
    app.use(internal, web)
    server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve))
    sinon.restore()
  })

  async function ticket(headers = {}) {
    return fetch(`${baseUrl}/project/${PROJECT}/live-preview/ticket`, {
      method: 'POST',
      headers,
    })
  }

  it('returns disabled 404 before project authorization or ticket issuance', async () => {
    settings.enabled = false
    const response = await ticket()
    expect(response.status).to.equal(404)
    expect((await response.json()).code).to.equal('live_preview_disabled')
    expect(authorization.called).to.equal(false)
    expect(service.issueTicket.called).to.equal(false)
  })

  it('requires read access before issuing a ticket', async () => {
    expect((await ticket()).status).to.equal(403)
    expect(service.issueTicket.called).to.equal(false)
    const response = await ticket({ 'x-can-read': 'true' })
    expect(response.status).to.equal(200)
    expect(response.headers.get('cache-control')).to.equal('no-store')
    expect(service.issueTicket.firstCall.args).to.deep.equal([
      PROJECT,
      'viewer',
    ])
  })

  it('returns the compiler error as a coded 409', async () => {
    service.issueTicket.rejects(
      new LivePreviewError('compiler_not_lualatex', 'Requires LuaLaTeX', 409)
    )
    const response = await ticket({ 'x-can-read': 'true' })
    expect(response.status).to.equal(409)
    expect((await response.json()).code).to.equal('compiler_not_lualatex')
  })

  it('binds authorized anonymous readers to a hashed session identity', async () => {
    userId = null
    const response = await ticket({ 'x-can-read': 'true' })
    expect(response.status).to.equal(200)
    const subject = service.issueTicket.firstCall.args[1]
    expect(subject).to.match(/^anonymous:[a-f0-9]{64}$/)
    expect(subject).not.to.contain('private-session-id')
  })

  it('protects the snapshot with private API auth, including when disabled', async () => {
    const url = `${baseUrl}/internal/project/${PROJECT}/live-preview/snapshot`
    expect((await fetch(url)).status).to.equal(401)
    expect(service.snapshot.called).to.equal(false)
    const response = await fetch(url, {
      headers: { authorization: 'Basic test' },
    })
    expect(response.status).to.equal(200)
    expect(service.snapshot.firstCall.args).to.deep.equal([PROJECT])
    settings.enabled = false
    expect((await fetch(url)).status).to.equal(401)
    expect(
      (await fetch(url, { headers: { authorization: 'Basic test' } })).status
    ).to.equal(404)
  })
})
