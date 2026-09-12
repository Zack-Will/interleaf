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

// A refusal from the document-updater `setDoc` endpoint when it was asked to
// turn the write into tracked changes, e.g. a history-OT document, which has
// no ranges to hold them.
class TrackedWriteError extends OError {
  constructor(
    message = 'document-updater refused the tracked write',
    properties = {}
  ) {
    super(message, properties)
    this.code = properties.code || 'tracked_write_failed'
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
  CommentTextMismatchError,
  CommentRangeError,
  ThreadNotFoundError,
  TrackedWriteError,
  SuggestionNotFoundError,
}

export default {
  CommentTextMismatchError,
  CommentRangeError,
  ThreadNotFoundError,
  TrackedWriteError,
  SuggestionNotFoundError,
}
