import { once } from 'node:events'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import sinon from 'sinon'
import WebSocket from 'ws'
import { createServer } from '../../app/src/Server.mjs'
import {
  createTicket,
  createAccessToken,
  verifyAccessToken,
} from '../../app/src/Tickets.mjs'
import { encodeFrame, decodeFrame } from '../../app/src/Frames.mjs'
import { createHttpClients } from '../../app/src/HttpClients.mjs'
import { createService } from '../../app/src/Service.mjs'
import { settingsFromEnv } from '../../config/settings.defaults.mjs'

describe('HTTP and WebSocket', () => {
  const project = 'a'.repeat(24)
  let service
  let url
  let ticket
  let access
  let manager
  beforeEach(async () => {
    ticket = createTicket(project, 'alice', 'secret')
    access = createAccessToken(project, 'alice', 'secret')
    manager = {
      sessions: new Map(),
      open: sinon.stub().callsFake(async (projectId, socket, getAccess) => {
        socket.send(encodeFrame('hello', getAccess()))
        return {}
      }),
      send: (socket, frame) => socket.send(frame),
      resync: sinon.spy(),
    }
    service = createServer({
      settings: settingsFromEnv({ LIVE_PREVIEW_TICKET_SECRET: 'secret' }),
      manager,
      fonts: {
        glyphs: async () => ({ glyphs: { 1: { path: 'M0 0Z', advance: 10 } } }),
      },
    })
    service.server.listen(0, '127.0.0.1')
    await once(service.server, 'listening')
    url = `http://127.0.0.1:${service.server.address().port}`
  })
  afterEach(async () => service.close())
  it('requires access tokens for PDF and glyph routes, serves health', async () => {
    expect((await fetch(`${url}/live-preview/health`)).status).toBe(200)
    expect((await fetch(`${url}/live-preview/pdf/${project}/1`)).status).toBe(
      401
    )
    expect((await fetch(`${url}/live-preview/glyphs/key?ids=1`)).status).toBe(
      401
    )
    expect(
      (await fetch(`${url}/live-preview/pdf/${project}/1?ticket=${access}`))
        .status
    ).toBe(404)
    const response = await fetch(
      `${url}/live-preview/glyphs/key?ids=1&ticket=${access}`
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('immutable')
  })
  it('rejects opening tickets on HTTP and access tokens on WS even with a sixty-second TTL', async () => {
    for (const route of [`pdf/${project}/1`, 'glyphs/key?ids=1']) {
      const separator = route.includes('?') ? '&' : '?'
      expect(
        (
          await fetch(
            `${url}/live-preview/${route}${separator}ticket=${ticket}`
          )
        ).status
      ).toBe(401)
    }
    const shortAccess = createAccessToken(
      project,
      'alice',
      'secret',
      Date.now(),
      60000
    )
    const bad = new WebSocket(
      `${url.replace('http:', 'ws:')}/live-preview/ws?project=${project}&ticket=${shortAccess}`
    )
    const [error] = await once(bad, 'error')
    expect(error.message).toContain('401')
    expect(manager.open.called).toBe(false)
  })
  it('returns project/user access credentials in hello after an authorized handshake', async () => {
    const socket = new WebSocket(
      `${url.replace('http:', 'ws:')}/live-preview/ws?project=${project}&ticket=${ticket}`
    )
    const [bytes] = await once(socket, 'message')
    const hello = decodeFrame(bytes)
    expect(hello.type).toBe('hello')
    expect(verifyAccessToken(hello.header.access, 'secret', project).user).toBe(
      'alice'
    )
    expect(hello.header.access_expiry).toBeGreaterThan(Date.now() + 890000)
    socket.close()
    await once(socket, 'close')
  })
  it('opens only authorized sockets and rejects text edits', async () => {
    const socket = new WebSocket(
      `${url.replace('http:', 'ws:')}/live-preview/ws?project=${project}&ticket=${ticket}`
    )
    await once(socket, 'open')
    expect(manager.open.calledOnce).toBe(true)
    socket.send(JSON.stringify({ cmd: 'resync' }))
    socket.send(JSON.stringify({ cmd: 'edit', text: 'forbidden' }))
    const [code] = await once(socket, 'close')
    expect(code).toBe(1008)
    expect(manager.resync.calledOnce).toBe(true)
    const bad = new WebSocket(
      `${url.replace('http:', 'ws:')}/live-preview/ws?project=${project}&ticket=bad`
    )
    const [error] = await once(bad, 'error')
    expect(error.message).toContain('401')
  })
  it('sends a busy frame when the session budget is full', async () => {
    manager.open.rejects(Object.assign(new Error('budget'), { code: 'busy' }))
    const socket = new WebSocket(
      `${url.replace('http:', 'ws:')}/live-preview/ws?project=${project}&ticket=${ticket}`
    )
    const [bytes] = await once(socket, 'message')
    expect(decodeFrame(bytes).header.code).toBe('busy')
    await once(socket, 'close')
  })
})

describe('service clients and defaults', () => {
  it('uses only snapshot and read-only document endpoints with scoped auth', async () => {
    const fetchUrl = sinon.stub().resolves({
      ok: true,
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    })
    const settings = {
      webUrl: 'http://web',
      webUser: 'user',
      webPassword: 'pass',
      documentUpdaterUrl: 'http://du',
    }
    const clients = createHttpClients(settings, fetchUrl)
    await clients.fetchSnapshot('p')
    await clients.fetchDocument('p', 'd', 3)
    await clients.fetchBinary('http://filestore/blob')
    expect(fetchUrl.firstCall.args[0]).toBe(
      'http://web/internal/project/p/live-preview/snapshot'
    )
    expect(fetchUrl.secondCall.args[0].toString()).toBe(
      'http://du/project/p/doc/d?fromVersion=3'
    )
    expect(fetchUrl.thirdCall.args[1].headers).toEqual({})
    fetchUrl.resolves({ ok: false, status: 500 })
    await expect(clients.fetchDocument('p', 'd')).rejects.toMatchObject({
      code: 'upstream_failed',
    })
  })
  it('defaults to local 3060 and rejects missing ticket secrets', async () => {
    const settings = settingsFromEnv({})
    expect(settings.port).toBe(3060)
    expect(settings.host).toBe('127.0.0.1')
    expect(
      settingsFromEnv({ PUBSUB_REDIS_HOST: 'pubsub', REDIS_HOST: 'data' }).redis
        .host
    ).toBe('pubsub')
    await expect(createService({ settings })).rejects.toMatchObject({
      code: 'invalid_config',
    })
  })
})
