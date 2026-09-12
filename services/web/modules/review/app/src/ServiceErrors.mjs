// Everything this module calls out to — document-updater, chat — reports a
// refusal through `@overleaf/fetch-utils`, which raises the same
// `RequestFailedError('request failed')` whatever went wrong: the status sits
// on the response, and the service's own JSON body arrives as raw text.  An
// agent cannot act on "request failed", so every call site turns one of those
// into a typed error carrying the status, the service's stable `code` and
// whatever else the body said.
import { ServiceRequestError } from './Errors.mjs'

function statusOf(error) {
  return error?.response?.status ?? error?.info?.status
}

function parseBody(error) {
  if (error?.body && typeof error.body === 'object') return error.body
  try {
    return JSON.parse(error?.body)
  } catch {
    return null
  }
}

/**
 * The status and the parsed JSON body of a failed `fetch-utils` request.  A
 * `status` of undefined means this was not a refusal at all — a timeout or a
 * socket error — and the original error is the one worth reporting.
 *
 * @param {Error} error
 * @return {{status: number|undefined, body: object|null}}
 */
function describeRequestFailure(error) {
  return { status: statusOf(error), body: parseBody(error) }
}

/**
 * Everything the body carried apart from the two fields that have a home of
 * their own on the error, so that a field a service adds later (`actual_text`,
 * `position`, …) still reaches the agent without being named here.
 *
 * @param {object|null} body
 * @return {object|undefined}
 */
function detailsOf(body) {
  if (!body) return undefined
  const rest = { ...body }
  delete rest.code
  delete rest.message
  return Object.keys(rest).length ? rest : undefined
}

function summarise(error, status) {
  const text = typeof error?.body === 'string' ? error.body.trim() : ''
  const excerpt = text ? `: ${text.slice(0, 200)}` : ''
  return `the request failed with status ${status}${excerpt}`
}

/**
 * The fallback typed error, for a service that refused without a code of its
 * own.  Anything that is not a request failure is handed back untouched.
 *
 * @param {Error} error
 * @param {string} code
 * @return {Error}
 */
function serviceRequestError(error, code) {
  const { status, body } = describeRequestFailure(error)
  if (status == null) return error
  return new ServiceRequestError(body?.message || summarise(error, status), {
    code,
    status,
    details: detailsOf(body),
  })
}

export { describeRequestFailure, detailsOf, serviceRequestError }

export default { describeRequestFailure, detailsOf, serviceRequestError }
