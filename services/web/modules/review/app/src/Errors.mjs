import OError from '@overleaf/o-error'

// The quoted text no longer matches the document at that position.  Carries
// the text that is actually there so the caller can retry without a round trip.
class CommentTextMismatchError extends OError {
  constructor(
    message = 'text does not match the document at this position',
    properties = {}
  ) {
    super(message, properties)
    this.code = 'text_mismatch'
    this.actualText = properties.actualText
  }
}

// Any other refusal from the document-updater comment endpoint.
class CommentRangeError extends OError {
  constructor(
    message = 'document-updater refused the comment range',
    properties = {}
  ) {
    super(message, properties)
    this.code = properties.code || 'comment_range_failed'
  }
}

class ThreadNotFoundError extends OError {
  constructor(message = 'comment thread not found', properties = {}) {
    super(message, properties)
    this.code = 'thread_not_found'
  }
}

export { CommentTextMismatchError, CommentRangeError, ThreadNotFoundError }

export default {
  CommentTextMismatchError,
  CommentRangeError,
  ThreadNotFoundError,
}
