// @ts-check

'use strict'

const assert = require('check-types').assert

const Origin = require('.')

/**
 * @import { RawMcpOrigin } from '../types'
 */

/**
 * An Origin for a Change written by an agent through the MCP endpoint.
 *
 * The plain {@link Origin} only keeps the kind, which would drop the name of
 * the client that made the write, the message it sent along with it, and
 * whether the change was offered as a suggestion rather than written straight
 * into the document. All three are shown in the history panel, so they need to
 * survive the round trip through storage.
 */
class McpOrigin extends Origin {
  /**
   * @param {string} [agent] name of the MCP client that made the write
   * @param {string} [message] message the client sent with the write
   * @param {boolean} [suggestion] the change was written as tracked changes
   *   for a human to accept or reject
   * @param {string} [historyClientId] see {@link Origin}
   */
  constructor(agent, message, suggestion, historyClientId) {
    assert.maybe.string(agent, 'McpOrigin: bad agent')
    assert.maybe.string(message, 'McpOrigin: bad message')
    assert.maybe.boolean(suggestion, 'McpOrigin: bad suggestion')

    super(McpOrigin.KIND, historyClientId)
    /** @type {string | undefined} */
    this.agent = undefined
    /** @type {string | undefined} */
    this.message = undefined
    /** @type {true | undefined} */
    this.suggestion = undefined
    if (agent != null) this.agent = agent
    if (message != null) this.message = message
    if (suggestion) this.suggestion = true
  }

  /**
   * @param {RawMcpOrigin} raw
   * @return {McpOrigin}
   */
  static fromRaw(raw) {
    return new McpOrigin(
      raw.agent,
      raw.message,
      raw.suggestion,
      raw.historyClientId
    )
  }

  /** @inheritdoc */
  toRaw() {
    /** @type {RawMcpOrigin} */
    const raw = { ...super.toRaw(), kind: McpOrigin.KIND }
    if (this.agent != null) raw.agent = this.agent
    if (this.message != null) raw.message = this.message
    // A change that is not a suggestion is the common case; storing `false`
    // for every one of them would be noise in history.
    if (this.suggestion) raw.suggestion = true
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

  /**
   * @return {boolean}
   */
  isSuggestion() {
    return this.suggestion === true
  }
}

/** @type {'mcp'} */
McpOrigin.KIND = 'mcp'

module.exports = McpOrigin
