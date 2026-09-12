import OError from '@overleaf/o-error'
class InvalidTokenRequestError extends OError {
  constructor(
    message = 'invalid personal access token request',
    properties = {}
  ) {
    super(message, properties)
    this.code = 'invalid_request'
  }
}
class TokenInvalidError extends OError {
  constructor(message = 'invalid personal access token', properties = {}) {
    super(message, properties)
    this.code = 'token_invalid'
  }
}
class TokenExpiredError extends OError {
  constructor(message = 'personal access token has expired', properties = {}) {
    super(message, properties)
    this.code = 'token_expired'
  }
}
class InsufficientScopeError extends OError {
  constructor(
    message = 'personal access token does not have the required scope',
    properties = {}
  ) {
    super(message, properties)
    this.code = 'insufficient_scope'
  }
}
class InvalidProjectRefError extends OError {
  constructor(message = 'invalid project reference', properties = {}) {
    super(message, properties)
    this.code = 'invalid_project_ref'
  }
}
class ProjectAccessError extends OError {
  constructor(message = 'forbidden', properties = {}) {
    super(message, properties)
    this.code = 'forbidden'
  }
}
class ProjectNotFoundError extends OError {
  constructor(message = 'project not found', properties = {}) {
    super(message, properties)
    this.code = 'not_found'
  }
}
class VersionConflictError extends OError {
  constructor(message = 'project version conflict', properties = {}) {
    super(message, properties)
    this.code = 'version_conflict'
    Object.assign(this, properties)
  }
}
class NotATextFileError extends OError {
  constructor(message = 'file is not a text document', properties = {}) {
    super(message, properties)
    this.code = 'not_a_text_file'
  }
}
class FileTooLargeError extends OError {
  constructor(message = 'file is too large', properties = {}) {
    super(message, properties)
    this.code = 'file_too_large'
  }
}
class AnchorNotFoundError extends OError {
  constructor(message = 'anchor not found', properties = {}) {
    super(message, properties)
    this.code = 'anchor_not_found'
  }
}
class AnchorAmbiguousError extends OError {
  constructor(message = 'anchor is ambiguous', properties = {}) {
    super(message, properties)
    this.code = 'anchor_ambiguous'
  }
}
class NotFoundAtVersionError extends OError {
  constructor(message = 'path not found at version', properties = {}) {
    super(message, properties)
    this.code = 'not_found_at_version'
  }
}
class InvalidEditError extends OError {
  constructor(message = 'invalid edit', properties = {}) {
    super(message, properties)
    this.code = 'invalid_edit'
  }
}
export {
  InvalidTokenRequestError,
  TokenInvalidError,
  TokenExpiredError,
  InsufficientScopeError,
  InvalidProjectRefError,
  ProjectAccessError,
  ProjectNotFoundError,
  VersionConflictError,
  NotATextFileError,
  FileTooLargeError,
  AnchorNotFoundError,
  AnchorAmbiguousError,
  NotFoundAtVersionError,
  InvalidEditError,
}
export default {
  InvalidTokenRequestError,
  TokenInvalidError,
  TokenExpiredError,
  InsufficientScopeError,
  InvalidProjectRefError,
  ProjectAccessError,
  ProjectNotFoundError,
  VersionConflictError,
  NotATextFileError,
  FileTooLargeError,
  AnchorNotFoundError,
  AnchorAmbiguousError,
  NotFoundAtVersionError,
  InvalidEditError,
}
