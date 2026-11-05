import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'
import SafePath from '../../../../app/src/Features/Project/SafePath.mjs'
import {
  InvalidUploadPathError,
  UploadInProgressError,
  UploadTicketInvalidError,
} from './Errors.mjs'

// An upload ticket lets a client that holds no access token send the bytes of
// one file to one path, once. The bytes travel outside the MCP conversation,
// so a figure never has to pass through the model as base64.

const rclient = RedisWrapper.client('project_sync_upload')

const TICKET_PREFIX = 'olu_'
const TICKET_RANDOM_BYTES = 24
const TICKET_PATTERN = /^olu_[A-Za-z0-9_-]{32}$/
const TICKET_TTL_SECONDS = 15 * 60
// Held while a request works on the ticket. It outlives the request only when
// the process dies, and then it gives the ticket back on its own.
const CLAIM_TTL_SECONDS = 5 * 60

function ticketKey(ticket) {
  const hash = crypto.createHash('sha256').update(ticket).digest('hex')
  return `projectSync:upload:${hash}`
}

function claimKey(ticket) {
  return `${ticketKey(ticket)}:claim`
}

function makeTicket() {
  const random = crypto.randomBytes(TICKET_RANDOM_BYTES)
  return TICKET_PREFIX + random.toString('base64url')
}

function cleanUploadPath(value) {
  const cleaned = String(value || '').replace(/^\/+/, '')
  const segments = cleaned.split('/')
  const hasRelativeSegment = segments.some(
    segment => segment === '.' || segment === '..' || segment === ''
  )
  if (!cleaned || hasRelativeSegment || !SafePath.isCleanPath(cleaned)) {
    throw new InvalidUploadPathError(`invalid project path: ${value}`)
  }
  return cleaned
}

function cleanUploadPaths(paths) {
  const cleaned = paths.map(cleanUploadPath)
  const distinct = new Set(cleaned)
  if (distinct.size !== cleaned.length) {
    throw new InvalidUploadPathError('the same path was requested twice')
  }
  return cleaned
}

async function createTickets({
  projectId,
  userId,
  tokenId,
  paths,
  overwrite = false,
  message,
  agent,
  label = false,
}) {
  const cleanedPaths = cleanUploadPaths(paths)
  const expiresAt = new Date(Date.now() + TICKET_TTL_SECONDS * 1000)
  const uploads = []
  for (const path of cleanedPaths) {
    const ticket = makeTicket()
    const record = {
      projectId,
      userId,
      tokenId,
      path,
      overwrite,
      message,
      agent,
      label,
    }
    await rclient.set(
      ticketKey(ticket),
      JSON.stringify(record),
      'EX',
      TICKET_TTL_SECONDS
    )
    uploads.push({ path, ticket })
  }
  return {
    uploads,
    upload_url: `${Settings.siteUrl}/mcp/uploads`,
    expires_at: expiresAt.toISOString(),
    max_bytes: Settings.maxUploadSize,
  }
}

// Reserves the ticket for one request, so two requests cannot both write with
// it. A failed request calls `release` and the ticket can be tried again until
// it expires; a successful one calls `consume`.
async function claim(ticket) {
  if (typeof ticket !== 'string' || !TICKET_PATTERN.test(ticket)) {
    throw new UploadTicketInvalidError()
  }
  const stored = await rclient.get(ticketKey(ticket))
  if (!stored) throw new UploadTicketInvalidError()
  const claimed = await rclient.set(
    claimKey(ticket),
    '1',
    'EX',
    CLAIM_TTL_SECONDS,
    'NX'
  )
  if (!claimed) throw new UploadInProgressError()
  return JSON.parse(stored)
}

async function release(ticket) {
  await rclient.del(claimKey(ticket))
}

async function consume(ticket) {
  await rclient.del(ticketKey(ticket))
  await rclient.del(claimKey(ticket))
}

const methods = { createTickets, claim, release, consume }

export { createTickets, claim, release, consume }
export default { ...methods, promises: methods }
