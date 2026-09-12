import OError from '@overleaf/o-error'

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
  constructor(message = 'personal access token does not have the required scope', properties = {}) {
    super(message, properties)
    this.code = 'insufficient_scope'
  }
}

export { TokenInvalidError, TokenExpiredError, InsufficientScopeError }

export default {
  TokenInvalidError,
  TokenExpiredError,
  InsufficientScopeError,
}
