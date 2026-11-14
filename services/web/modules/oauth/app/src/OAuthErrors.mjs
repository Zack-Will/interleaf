import OError from '@overleaf/o-error'

// An error the token, revocation or authorize endpoints report to the client
// as an RFC 6749 error. `code` is the RFC error code.
class OAuthError extends OError {
  constructor(code, description, status = 400) {
    super(description, { code })
    this.code = code
    this.status = status
  }

  toResponseObject() {
    return { error: this.code, error_description: this.message }
  }
}

class InvalidRequestError extends OAuthError {
  constructor(description) {
    super('invalid_request', description)
  }
}

class InvalidClientError extends OAuthError {
  constructor(description = 'client authentication failed') {
    super('invalid_client', description, 401)
  }
}

class InvalidGrantError extends OAuthError {
  constructor(description) {
    super('invalid_grant', description)
  }
}

class UnsupportedGrantTypeError extends OAuthError {
  constructor(description = 'grant_type is not supported') {
    super('unsupported_grant_type', description)
  }
}

class InvalidScopeError extends OAuthError {
  constructor(description = 'the only supported scope is mcp') {
    super('invalid_scope', description)
  }
}

class InvalidTargetError extends OAuthError {
  constructor(description) {
    super('invalid_target', description)
  }
}

class UnsupportedResponseTypeError extends OAuthError {
  constructor(description = 'response_type must be code') {
    super('unsupported_response_type', description)
  }
}

// The authorize request cannot be answered with a redirect: the client or the
// redirect URI is unknown, or the user may not use the client. Shown as a page.
class AuthorizePageError extends OError {
  constructor(messageKey, status = 400) {
    super(messageKey, { messageKey })
    this.code = 'authorize_error'
    this.messageKey = messageKey
    this.status = status
  }
}

export {
  OAuthError,
  InvalidRequestError,
  InvalidClientError,
  InvalidGrantError,
  UnsupportedGrantTypeError,
  InvalidScopeError,
  InvalidTargetError,
  UnsupportedResponseTypeError,
  AuthorizePageError,
}
