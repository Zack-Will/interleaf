import { createHmac, timingSafeEqual } from 'node:crypto'
import { PreviewError } from './Errors.mjs'

export function validateProject(project) {
  if (!/^[a-f0-9]{24}$/i.test(project || '')) {
    throw new PreviewError('invalid_project', 'Expected a project id', 400)
  }
}

function signature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest()
}

export function createTicket(project, user, secret, now = Date.now()) {
  validateProject(project)
  const payload = Buffer.from(
    JSON.stringify({ project, user, expiry: now + 60000 })
  ).toString('base64url')
  return `${payload}.${signature(payload, secret).toString('base64url')}`
}

export function verifyTicket(ticket, secret, project, now = Date.now()) {
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
      claims.expiry > now + 60000 ||
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
