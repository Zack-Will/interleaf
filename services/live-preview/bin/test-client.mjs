import WebSocket from 'ws'
import { decodeFrame } from '../app/src/Frames.mjs'

const [url] = process.argv.slice(2)
if (!url) {
  process.stderr.write(
    'Usage: node bin/test-client.mjs "ws://127.0.0.1:3060/live-preview/ws?project=ID&ticket=TICKET"\n'
  )
  process.exit(1)
}
const socket = new WebSocket(url)
socket.on('message', bytes => {
  const frame = decodeFrame(bytes)
  process.stdout.write(
    `${frame.type} ${JSON.stringify(frame.header)} body=${frame.body.length}\n`
  )
})
socket.on('error', error => process.stderr.write(`${error.message}\n`))
socket.on('close', () => process.exit())
process.on('SIGINT', () => socket.close())
