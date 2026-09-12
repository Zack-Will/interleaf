'use strict'

const assert = require('check-types').assert

const Origin = require('.')

/**
 * An Origin for a Change written by an agent through the MCP endpoint.
 *
 * The plain {@link Origin} only keeps the kind, which would drop the name of
 * the client that made the write and the message it sent along with it. Both
 * are shown in the history panel, so they need to survive the round trip
 * through storage.
 */
class McpOrigin extends Origin {
  /**
   * @param {string} [agent] name of the MCP client that made the write
   * @param {string} [message] message the client sent with the write
   */
  constructor(agent, message) {
    assert.maybe.string(agent, 'McpOrigin: bad agent')
    assert.maybe.string(message, 'McpOrigin: bad message')

    super(McpOrigin.KIND)
    if (agent != null) this.agent = agent
    if (message != null) this.message = message
  }

  static fromRaw(raw) {
    return new McpOrigin(raw.agent, raw.message)
  }

  /** @inheritdoc */
  toRaw() {
    const raw = { kind: McpOrigin.KIND }
    if (this.agent != null) raw.agent = this.agent
    if (this.message != null) raw.message = this.message
    return raw
  }

  /**
   * @return {string | undefined}
   */
  getAgent() {
    return this.agent
  }

  /**
   * @return {string | undefined}
   */
  getMessage() {
    return this.message
  }
}

McpOrigin.KIND = 'mcp'

module.exports = McpOrigin
