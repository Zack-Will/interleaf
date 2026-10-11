export { decodeDisplayList } from '@overleaf/live-preview-protocol/DisplayList.mjs'
export { decodeFrame } from '@overleaf/live-preview-protocol/Frames.mjs'

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
