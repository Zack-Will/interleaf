import OError from '@overleaf/o-error'

// `fetch-utils` reports every refusal from an internal service as
// `RequestFailedError('request failed')`, which tells an agent nothing about
// what to do next.  These errors carry what the service actually said: the HTTP
// status, the stable `code` from its JSON body when it sent one, and whatever
// else the body held (`actual_text`, for instance) under `details`.
class ServiceRequestError extends OError {
  constructor(
    message = 'request to an internal service failed',
    properties = {}
  ) {
    super(message, properties)
    this.code = properties.code || 'service_request_failed'
    this.status = properties.status
    this.details = properties.details
  }
}

// The quoted text no longer matches the document at that position.  Carries
// the text that is actually there so the caller can retry without a round trip.
class CommentTextMismatchError extends ServiceRequestError {
  constructor(
    message = 'text does not match the document at this position',
    properties = {}
  ) {
    super(message, { ...properties, code: 'text_mismatch' })
    this.actualText = properties.actualText
  }
}

// Any other refusal from the document-updater comment endpoint.
class CommentRangeError extends ServiceRequestError {
  constructor(
    message = 'document-updater refused the comment range',
    properties = {}
  ) {
    super(message, {
      ...properties,
      code: properties.code || 'comment_range_failed',
    })
  }
}

class ThreadNotFoundError extends ServiceRequestError {
  constructor(message = 'comment thread not found', properties = {}) {
    super(message, { ...properties, code: 'thread_not_found' })
  }
}

// A refusal from the document-updater `setDoc` endpoint when it was asked to
// turn the write into tracked changes, e.g. a history-OT document, which has
// no ranges to hold them.
class TrackedWriteError extends ServiceRequestError {
  constructor(
    message = 'document-updater refused the tracked write',
    properties = {}
  ) {
    super(message, {
      ...properties,
      code: properties.code || 'tracked_write_failed',
    })
  }
}

// `change_ids` that are not pending tracked changes of this document.
class SuggestionNotFoundError extends OError {
  constructor(message = 'suggestion not found', properties = {}) {
    super(message, properties)
    this.code = 'suggestion_not_found'
    this.missingChangeIds = properties.missingChangeIds || []
  }
}

export {
  ServiceRequestError,
  CommentTextMismatchError,
  CommentRangeError,
  ThreadNotFoundError,
  TrackedWriteError,
  SuggestionNotFoundError,
}

export default {
  ServiceRequestError,
  CommentTextMismatchError,
  CommentRangeError,
  ThreadNotFoundError,
  TrackedWriteError,
  SuggestionNotFoundError,
}
