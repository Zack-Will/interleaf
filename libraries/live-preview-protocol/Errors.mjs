import OError from '@overleaf/o-error'

export class ProtocolError extends OError {
  constructor(code, message, status = 500) {
    super(message, { code })
    this.code = code
    this.status = status
  }
}
