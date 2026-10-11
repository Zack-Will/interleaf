export { decodeDisplayList } from '../../../../../live-preview/app/src/DisplayList.mjs'

const types = [
  'hello',
  'paragraph',
  'layout',
  'background',
  'diagnostics',
  'engine',
  'busy',
  'access',
]
const decoder = new TextDecoder('utf-8', { fatal: true })

export function decodeFrame(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.length < 5) throw new Error('Truncated preview frame')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = types[bytes[0] - 1]
  const end = 5 + view.getUint32(1, true)
  if (!type || end > bytes.length) throw new Error('Invalid preview frame')
  const header = JSON.parse(decoder.decode(bytes.subarray(5, end)))
  if (!header || typeof header !== 'object' || Array.isArray(header))
    throw new Error('Invalid preview header')
  if (type !== 'paragraph' && end !== bytes.length)
    throw new Error('Unexpected preview body')
  return { type, header, body: bytes.subarray(end) }
}

export function accessUrl(path, access) {
  const url = new URL(path, window.location.origin)
  if (
    url.origin !== window.location.origin ||
    !url.pathname.startsWith('/live-preview/')
  )
    throw new Error('Invalid preview URL')
  url.searchParams.set('ticket', access)
  return url.pathname + url.search
}

export function socketUrl(project, ticket, location = window.location) {
  const url = new URL('/live-preview/ws', location.origin)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('project', project)
  url.searchParams.set('ticket', ticket)
  return url.href
}

export function reconnectDelay(attempt) {
  return Math.min(30000, 500 * 2 ** Math.min(attempt, 6))
}
