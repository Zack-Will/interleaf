import { createHash } from 'node:crypto'
import logger from '@overleaf/logger'
import { expressify } from '@overleaf/promise-utils'
import { requireEnabled } from './LivePreviewService.mjs'

export function createLivePreviewRouter({
  settings,
  service,
  authorization,
  privateAuth,
  getUserId,
}) {
  function enabled(req, res, next) {
    try {
      requireEnabled(settings)
      next()
    } catch (error) {
      sendError(res, error)
    }
  }

  function handle(action) {
    return expressify(async (req, res) => {
      try {
        const body = await action(req)
        res.set('Cache-Control', 'no-store')
        res.json(body)
      } catch (error) {
        sendError(res, error)
      }
    })
  }

  function ticketUserId(req) {
    const userId = getUserId(req.session)
    if (userId) return userId
    // Read-authorized anonymous link viewers also have a session. Do not put
    // the raw session id in a browser-readable ticket or access token.
    if (req.sessionID) {
      const digest = createHash('sha256').update(req.sessionID).digest('hex')
      return `anonymous:${digest}`
    }
    return null
  }

  const ticket = handle(req =>
    service.issueTicket(req.params.project_id, ticketUserId(req))
  )
  const snapshot = handle(req => service.snapshot(req.params.project_id))

  function apply(webRouter, privateApiRouter) {
    webRouter.post(
      '/project/:project_id/live-preview/ticket',
      enabled,
      authorization,
      ticket
    )
    privateApiRouter.get(
      '/internal/project/:project_id/live-preview/snapshot',
      privateAuth,
      enabled,
      snapshot
    )
  }

  return { apply }
}

function sendError(res, error) {
  const status = error.status || 500
  if (status >= 500) logger.warn({ err: error }, 'live preview request failed')
  res.status(status).json({
    code: error.code || 'live_preview_failed',
    message: status === 500 ? 'Live preview request failed' : error.message,
  })
}
