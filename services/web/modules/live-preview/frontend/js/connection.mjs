import { decodeFrame, reconnectDelay, socketUrl } from './protocol.mjs'

// Injectable transport: no text or source edits ever leave this connection.
export function connectPreview({
  project,
  getTicket,
  onFrame,
  onState,
  WebSocketClass = WebSocket,
  timers = globalThis,
  location = window.location,
}) {
  let socket
  let stopped = false
  let attempt = 0
  let retry
  let ping
  let handshake
  let unavailable = false
  const abort = new AbortController()

  function schedule() {
    timers.clearInterval(ping)
    timers.clearTimeout(handshake)
    if (stopped || unavailable) return
    onState('Reconnecting')
    retry = timers.setTimeout(open, reconnectDelay(attempt++))
  }

  async function open() {
    if (stopped) return
    onState('Connecting')
    try {
      const { ticket } = await getTicket(abort.signal)
      if (stopped) return
      socket = new WebSocketClass(socketUrl(project, ticket, location))
      socket.binaryType = 'arraybuffer'
      handshake = timers.setTimeout(() => socket.close(), 20000)
      socket.onopen = () => {
        if (stopped) return
        socket.send(JSON.stringify({ cmd: 'resync' }))
        ping = timers.setInterval(() => {
          if (socket.readyState === 1)
            socket.send(JSON.stringify({ cmd: 'ping' }))
        }, 30000)
      }
      socket.onmessage = event => {
        if (stopped) return
        try {
          const frame = decodeFrame(event.data)
          if (frame.type === 'hello') {
            timers.clearTimeout(handshake)
            attempt = 0
            onState('Connected')
          }
          onFrame(frame)
          if (frame.type === 'busy') {
            unavailable = true
            timers.clearInterval(ping)
            timers.clearTimeout(handshake)
            onState('Unavailable')
          }
        } catch {
          // A malformed/unsupported frame requires a fresh session snapshot.
          socket.close(1002, 'Invalid preview frame')
        }
      }
      socket.onerror = () => socket.close()
      socket.onclose = schedule
    } catch (error) {
      if (stopped) return
      if ([403, 404, 409].includes(error.response?.status)) {
        onState('Unavailable')
        return
      }
      schedule()
    }
  }

  void open()
  return () => {
    stopped = true
    abort.abort()
    timers.clearTimeout(retry)
    timers.clearTimeout(handshake)
    timers.clearInterval(ping)
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
    }
  }
}
