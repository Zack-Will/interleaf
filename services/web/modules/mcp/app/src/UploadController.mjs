import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertNoSilentOverwrite } from './McpTools.mjs'

const NEW_TICKET = 'call create_upload for a new ticket'

// Web's body parsers have already consumed these by the time the route runs,
// and a multipart body would be stored with its envelope around the file.
const REFUSED_CONTENT_TYPES = new Set([
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
])

const STATUS_BY_CODE = {
  upload_ticket_invalid: 401,
  forbidden: 403,
  not_found: 404,
  upload_in_progress: 409,
  file_exists: 409,
}

const NEXT_ACTION_BY_CODE = {
  upload_ticket_invalid: `the ticket is unknown, expired or already used; ${NEW_TICKET}`,
  upload_in_progress:
    'another request is using this ticket; wait for it to finish',
  forbidden: 'the token owner cannot write to this project any more',
  not_found: 'the project no longer exists',
}

function uploadError(status, code, message, nextAction) {
  return Object.assign(new Error(message), {
    status,
    code,
    next_action: nextAction,
  })
}

function bearerTicket(req) {
  const authorization = req.headers?.authorization
  const match = String(authorization || '').match(/^Bearer\s+(\S+)$/i)
  return match ? match[1] : null
}

function contentTypeOf(req) {
  const header = String(req.headers?.['content-type'] || '')
  return header.split(';')[0].trim().toLowerCase()
}

function assertAcceptableRequest(req, maxBytes) {
  if (REFUSED_CONTENT_TYPES.has(contentTypeOf(req))) {
    throw uploadError(
      415,
      'unsupported_content_type',
      `send the raw file, not ${contentTypeOf(req)}`,
      'send it with curl -T, or with Content-Type: application/octet-stream'
    )
  }
  if (Number(req.headers?.['content-length']) > maxBytes) {
    throw tooLarge(maxBytes)
  }
}

function tooLarge(maxBytes) {
  return uploadError(
    413,
    'file_too_large',
    `the file is larger than the limit of ${maxBytes} bytes`,
    'make the file smaller, then send it again with the same ticket'
  )
}

async function assertCanStillWrite(services, record) {
  const active = await services.TokenService.promises.isTokenActive(
    record.tokenId
  )
  if (!active) {
    throw uploadError(
      401,
      'upload_ticket_invalid',
      'the access token behind this ticket has been revoked or has expired',
      'ask the user for a valid access token'
    )
  }
  await services.ProjectRef.requireAccess(
    record.userId,
    record.projectId,
    'write'
  )
}

// The iterator leaves the request open when it stops early, so a refusal can
// still be answered.
async function saveBody(req, tempPath, maxBytes) {
  const hash = crypto.createHash('sha256')
  const file = await fs.open(tempPath, 'wx', 0o600)
  let bytes = 0
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length
      if (bytes > maxBytes) throw tooLarge(maxBytes)
      hash.update(chunk)
      await file.writeFile(chunk)
    }
  } finally {
    await file.close()
  }
  if (bytes === 0) {
    throw uploadError(
      400,
      'empty_file',
      'the request carried no file content',
      'check the local path and send the file again with the same ticket'
    )
  }
  return { bytes, sha256: hash.digest('hex') }
}

async function writeUpload(services, record, tempPath) {
  const result = await services.WriteService.writeFiles(
    record.projectId,
    record.userId,
    {
      message: record.message,
      agent: record.agent,
      label: record.label,
      files: [{ path: record.path, contentPath: tempPath }],
    }
  )
  if (result.failed?.length) {
    throw uploadError(
      422,
      'write_failed',
      result.failed[0].error,
      'nothing was written; fix the cause and send the file again with the same ticket'
    )
  }
  return result
}

function refusalBody(error) {
  return {
    code: error.code,
    message: error.message,
    next_action: error.next_action || NEXT_ACTION_BY_CODE[error.code],
  }
}

function statusOf(error) {
  return error.status || STATUS_BY_CODE[error.code]
}

function refuse(req, res, error) {
  // Whatever the client is still sending is of no use now.
  req.resume()
  res.status(statusOf(error)).json(refusalBody(error))
}

export function createUploadHandler(services) {
  const { UploadService } = services
  const maxBytes = services.settings.maxUploadSize

  async function runClaimedUpload(req, record) {
    const tempPath = path.join(
      services.settings.path.dumpFolder,
      `${record.projectId}_${crypto.randomUUID()}_mcp-upload`
    )
    try {
      assertAcceptableRequest(req, maxBytes)
      await assertCanStillWrite(services, record)
      const { bytes, sha256 } = await saveBody(req, tempPath, maxBytes)
      await assertNoSilentOverwrite(
        services,
        record.projectId,
        [{ path: record.path }],
        record.overwrite,
        `${NEW_TICKET} with overwrite: true to replace it`
      )
      const result = await writeUpload(services, record, tempPath)
      return {
        path: record.path,
        bytes,
        sha256,
        project_version: result.version,
        label: result.label ?? null,
      }
    } finally {
      await fs.unlink(tempPath).catch(() => {})
    }
  }

  return async function uploadHandler(req, res) {
    const ticket = bearerTicket(req)
    let record
    try {
      record = await UploadService.claim(ticket)
    } catch (error) {
      if (!statusOf(error)) throw error
      return refuse(req, res, error)
    }
    let uploaded
    try {
      uploaded = await runClaimedUpload(req, record)
    } catch (error) {
      await UploadService.release(ticket)
      if (!statusOf(error)) throw error
      return refuse(req, res, error)
    }
    await UploadService.consume(ticket)
    res.json(uploaded)
  }
}
