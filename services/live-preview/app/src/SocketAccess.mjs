import { createAccessToken } from './Tickets.mjs'
import { encodeFrame } from './Frames.mjs'

export function createSocketAccess({ socket, claims, settings, send }) {
  const ttlMs = settings.accessTtlMs
  let timer
  socket.once('close', () => clearTimeout(timer))

  function getAccess() {
    clearTimeout(timer)
    const now = Date.now()
    const access = createAccessToken(
      claims.project,
      claims.user,
      settings.ticketSecret,
      now,
      ttlMs
    )
    if (socket.readyState === 1) {
      timer = setTimeout(renew, Math.floor(ttlMs * 0.8))
      timer.unref?.()
    }
    return { access, access_expiry: now + ttlMs }
  }

  function renew() {
    if (socket.readyState === 1) {
      send(socket, encodeFrame('access', getAccess()))
    }
  }

  return getAccess
}
