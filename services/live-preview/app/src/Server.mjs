import http from 'node:http'
import express from 'express'
import { expressify } from '@overleaf/promise-utils'
import { WebSocketServer } from 'ws'
import { verifyTicket, verifyAccessToken, validateProject } from './Tickets.mjs'
import { createSocketAccess } from './SocketAccess.mjs'
import { encodeFrame } from './Frames.mjs'
import { PreviewError } from './Errors.mjs'

export function createServer({ settings, manager, fonts, onError = () => {} }) {
  const app = express()
  app.disable('x-powered-by')
  const server = http.createServer(app)
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
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
      const file = manager.sessions
        .get(projectId)
        ?.pdfs.get(Number(layoutVersion))
      if (!file) {
        throw new PreviewError(
          'pdf_not_found',
          'Layout PDF is no longer available',
          404
        )
      }
      res.set('Cache-Control', 'private, max-age=60')
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
      const glyphs = await fonts.glyphs(claims.project, req.params.fontKey, ids)
      res.set('Cache-Control', 'private, max-age=31536000, immutable')
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
      websocket.handleUpgrade(request, socket, head, ws => {
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
