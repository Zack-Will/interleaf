import { createHmac, timingSafeEqual } from 'node:crypto'
import { ProtocolError as PreviewError } from './Errors.mjs'

export function validateProject(project) {
  if (!/^[a-f0-9]{24}$/i.test(project || '')) {
    throw new PreviewError('invalid_project', 'Expected a project id', 400)
  }
}

function signature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest()
}

function createToken(project, user, secret, kind, now, ttlMs) {
  validateProject(project)
  const payload = Buffer.from(
    JSON.stringify({ project, user, kind, expiry: now + ttlMs })
  ).toString('base64url')
  return `${payload}.${signature(payload, secret).toString('base64url')}`
}

export function createTicket(project, user, secret, now = Date.now()) {
  return createToken(project, user, secret, 'open', now, 60000)
}

export function createAccessToken(
  project,
  user,
  secret,
  now = Date.now(),
  ttlMs = 900000
) {
  return createToken(project, user, secret, 'access', now, ttlMs)
}

export function verifyTicket(ticket, secret, project, now = Date.now()) {
  return verifyToken(ticket, secret, project, now, 60000, 'open')
}

export function verifyAccessToken(
  token,
  secret,
  project,
  now = Date.now(),
  ttlMs = 900000
) {
  return verifyToken(token, secret, project, now, ttlMs, 'access')
}

function verifyToken(ticket, secret, project, now, ttlMs, kind) {
  try {
    if (!secret || typeof ticket !== 'string' || ticket.length > 2048) {
      throw new Error('missing ticket')
    }
    const parts = ticket.split('.')
    if (parts.length !== 2) {
      throw new Error('invalid ticket')
    }
    const supplied = Buffer.from(parts[1], 'base64url')
    const expected = signature(parts[0], secret)
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new Error('invalid signature')
    }
    const claims = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8')
    )
    validateProject(claims.project)
    if (
      typeof claims.user !== 'string' ||
      !claims.user ||
      !Number.isSafeInteger(claims.expiry) ||
      claims.expiry <= now ||
      claims.expiry > now + ttlMs ||
      (claims.kind !== kind &&
        !(kind === 'open' && claims.kind === undefined)) ||
      (project && claims.project !== project)
    ) {
      throw new Error('invalid claims')
    }
    return claims
  } catch {
    throw new PreviewError(
      'invalid_ticket',
      'Ticket is invalid or expired',
      401
    )
  }
}
