'use strict'

const { expect } = require('chai')
const { Change, McpOrigin, Origin } = require('../..')

describe('McpOrigin', function () {
  it('converts to and from raw with an agent and a message', function () {
    const origin = new McpOrigin('Claude Code', 'Rewrite the abstract')
    const raw = origin.toRaw()

    expect(raw).to.eql({
      kind: 'mcp',
      agent: 'Claude Code',
      message: 'Rewrite the abstract',
    })
    expect(Origin.fromRaw(raw)).to.eql(origin)
  })

  it('omits fields that were not given', function () {
    const origin = new McpOrigin()

    expect(origin.toRaw()).to.eql({ kind: 'mcp' })
    expect(Origin.fromRaw({ kind: 'mcp' })).to.eql(origin)
  })

  it('omits the message when only the agent is known', function () {
    const origin = new McpOrigin('Codex')

    expect(origin.toRaw()).to.eql({ kind: 'mcp', agent: 'Codex' })
    expect(Origin.fromRaw(origin.toRaw())).to.eql(origin)
  })

  it('tolerates unknown extra fields on the raw form', function () {
    const origin = Origin.fromRaw({
      kind: 'mcp',
      agent: 'Codex',
      revert: { from: 3, to: 5 },
    })

    expect(origin).to.be.an.instanceof(McpOrigin)
    expect(origin.getAgent()).to.equal('Codex')
    expect(origin.getMessage()).to.be.undefined
    expect(origin.toRaw()).to.eql({ kind: 'mcp', agent: 'Codex' })
  })

  it('keeps the suggestion flag of a tracked-change write', function () {
    const origin = new McpOrigin('Claude Code', 'Tighten section 2', true)

    expect(origin.toRaw()).to.eql({
      kind: 'mcp',
      agent: 'Claude Code',
      message: 'Tighten section 2',
      suggestion: true,
    })
    expect(origin.isSuggestion()).to.be.true
    expect(Origin.fromRaw(origin.toRaw())).to.eql(origin)
  })

  it('omits the suggestion flag for an ordinary write', function () {
    const plain = new McpOrigin('Claude Code', 'Tighten section 2')
    const explicit = new McpOrigin('Claude Code', 'Tighten section 2', false)

    expect(plain.toRaw()).to.not.have.property('suggestion')
    expect(explicit.toRaw()).to.not.have.property('suggestion')
    expect(plain.isSuggestion()).to.be.false
    expect(explicit.isSuggestion()).to.be.false
  })

  it('rejects a non-string agent', function () {
    expect(() => new McpOrigin(42)).to.throw('McpOrigin: bad agent')
  })

  it('rejects a non-boolean suggestion flag', function () {
    expect(() => new McpOrigin('Codex', 'hello', 'yes')).to.throw(
      'McpOrigin: bad suggestion'
    )
  })

  it('is the origin class used by a change', function () {
    const change = Change.fromRaw({
      operations: [],
      timestamp: '2015-03-05T12:03:53.035Z',
      authors: [null],
      origin: {
        kind: 'mcp',
        agent: 'Claude Code',
        message: 'hello',
        suggestion: true,
      },
    })

    const origin = change.getOrigin()
    expect(origin).to.be.an.instanceof(McpOrigin)
    expect(origin.getKind()).to.equal('mcp')
    expect(origin.getAgent()).to.equal('Claude Code')
    expect(origin.getMessage()).to.equal('hello')
    expect(origin.isSuggestion()).to.be.true
  })
})
