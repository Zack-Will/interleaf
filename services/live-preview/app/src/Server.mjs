import http from 'node:http'
import fs from 'node:fs/promises'
import express from 'express'
import { expressify } from '@overleaf/promise-utils'
import { WebSocketServer } from 'ws'
import {
  verifyTicket,
  verifyAccessToken,
  validateProject,
} from '@overleaf/live-preview-protocol/Tickets.mjs'
import { createSocketAccess } from './SocketAccess.mjs'
import { encodeFrame } from '@overleaf/live-preview-protocol/Frames.mjs'
import { PreviewError } from './Errors.mjs'
import { assertNoSymlinks } from './Materializer.mjs'

export function createServer({ settings, manager, fonts, onError = () => {} }) {
  const app = express()
  app.disable('x-powered-by')
  const server = http.createServer(app)
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  })
  const projectConnections = new Map()
  const userConnections = new Map()
  const heartbeat = setInterval(() => {
    for (const client of websocket.clients) {
      if (!client.alive) {
        client.terminate()
      } else {
        client.alive = false
        client.ping()
      }
    }
  }, settings.heartbeatMs)
  heartbeat.unref()
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store')
    res.set('Referrer-Policy', 'no-referrer')
    next()
  })

  app.get('/live-preview/health', (req, res) =>
    res.json({ status: 'ok', sessions: manager.sessions.size })
  )
  app.get(
    '/live-preview/pdf/:projectId/:layoutVersion',
    expressify(async (req, res) => {
      const { projectId, layoutVersion } = req.params
      validateProject(projectId)
      verifyAccessToken(
        req.query.ticket,
        settings.ticketSecret,
        projectId,
        Date.now(),
        settings.accessTtlMs
      )
      const session = manager.sessions.get(projectId)
      const file = session?.pdfs.get(Number(layoutVersion))
      if (!file) {
        throw new PreviewError(
          'pdf_not_found',
          'Layout PDF is no longer available',
          404
        )
      }
      await assertNoSymlinks(fs, session.directory, file)
      // Versions restart at one after an engine/service restart. Revalidation
      // cannot safely identify the old layout by URL alone.
      res.set('Cache-Control', 'private, no-store')
      await new Promise((resolve, reject) => {
        res.sendFile(file, error => {
          // A viewer can close its PDF request during a layout switch.
          // Express also reports ECONNABORTED on an already finished response.
          if (error && error.code !== 'ECONNABORTED') {
            reject(error)
          } else {
            resolve()
          }
        })
      })
    })
  )
  app.get(
    '/live-preview/glyphs/:fontKey',
    expressify(async (req, res) => {
      const claims = verifyAccessToken(
        req.query.ticket,
        settings.ticketSecret,
        undefined,
        Date.now(),
        settings.accessTtlMs
      )
      const ids =
        typeof req.query.ids === 'string'
          ? req.query.ids
              .split(',')
              .map(value => (/^\d+$/.test(value) ? Number(value) : NaN))
          : []
      if (
        !ids.length ||
        ids.length > 1024 ||
        ids.some(id => !Number.isSafeInteger(id) || id < 0 || id > 65535)
      ) {
        throw new PreviewError(
          'invalid_glyph_ids',
          'Expected up to 1024 glyph ids',
          400
        )
      }
      const glyphs = await fonts.glyphs(claims.project, req.params.fontKey, ids)
      // The engine's font key identifies a path, not its content. A font file
      // can change on restart; require authorization on every HTTP request.
      res.set('Cache-Control', 'private, no-store')
      res.json(glyphs)
    })
  )
  app.use((error, req, res, next) => {
    onError(error)
    if (res.headersSent) {
      return next(error)
    }
    res.status(error.status || 500).json({
      code: error.code || 'internal_error',
      message: error.status ? error.message : 'Live preview request failed',
    })
  })

  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url, 'http://localhost')
      if (url.pathname !== '/live-preview/ws') {
        throw new PreviewError(
          'invalid_ws_path',
          'Unknown websocket route',
          404
        )
      }
      const projectId = url.searchParams.get('project')
      validateProject(projectId)
      const claims = verifyTicket(
        url.searchParams.get('ticket'),
        settings.ticketSecret,
        projectId
      )
      const origin = request.headers.origin
      if (origin) {
        const parsed = new URL(origin)
        const allowed = settings.allowedOrigins.length
          ? settings.allowedOrigins.includes(parsed.origin)
          : parsed.host === request.headers.host
        if (!['http:', 'https:'].includes(parsed.protocol) || !allowed) {
          throw new PreviewError(
            'invalid_origin',
            'Preview requires the site origin',
            403
          )
        }
      }
      if (
        (projectConnections.get(projectId) || 0) >=
          settings.maxProjectConnections ||
        (userConnections.get(claims.user) || 0) >= settings.maxUserConnections
      ) {
        throw new PreviewError(
          'connection_limit',
          'Too many preview connections',
          429
        )
      }
      websocket.handleUpgrade(request, socket, head, ws => {
        for (const [counts, key] of [
          [projectConnections, projectId],
          [userConnections, claims.user],
        ]) {
          counts.set(key, (counts.get(key) || 0) + 1)
          ws.once('close', () => {
            const remaining = counts.get(key) - 1
            if (remaining) counts.set(key, remaining)
            else counts.delete(key)
          })
        }
        ws.alive = true
        ws.on('pong', () => {
          ws.alive = true
        })
        connect(ws, claims).catch(onError)
      })
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error.status || 401} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
      )
    }
  })

  async function connect(ws, claims) {
    let session
    let resyncAt = 0
    ws.on('error', onError)
    ws.on('message', (bytes, binary) => {
      try {
        const command = JSON.parse(bytes.toString())
        if (
          binary ||
          !command ||
          Object.keys(command).length !== 1 ||
          !['ping', 'resync'].includes(command.cmd)
        ) {
          ws.close(1008, 'Only ping and resync are accepted')
        } else if (command.cmd === 'ping') {
          ws.pong()
        } else if (session && Date.now() - resyncAt > 1000) {
          resyncAt = Date.now()
          manager.resync(session, ws)
        }
      } catch {
        ws.close(1008, 'Invalid command')
      }
    })
    try {
      const getAccess = createSocketAccess({
        socket: ws,
        claims,
        settings,
        send: (socket, frame) => manager.send(socket, frame),
      })
      session = await manager.open(claims.project, ws, getAccess)
    } catch (error) {
      if (ws.readyState === 1) {
        ws.send(
          encodeFrame('busy', {
            code: error.code || 'session_failed',
            reason: error.message,
          })
        )
        ws.close(1013, 'Live preview unavailable')
      }
    }
  }

  async function close() {
    clearInterval(heartbeat)
    for (const client of websocket.clients) {
      client.terminate()
    }
    await new Promise(resolve => websocket.close(resolve))
    if (server.listening) {
      await new Promise(resolve => server.close(resolve))
    }
  }

  return { app, server, websocket, close }
}
