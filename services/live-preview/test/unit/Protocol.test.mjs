import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { utf8Offset, convertComponent } from '../../app/src/Offsets.mjs'
import {
  createTicket,
  verifyTicket,
  createAccessToken,
  verifyAccessToken,
} from '@overleaf/live-preview-protocol/Tickets.mjs'
import {
  encodeFrame,
  decodeFrame,
  frameTypes,
} from '@overleaf/live-preview-protocol/Frames.mjs'
import { Attribution } from '../../app/src/Attribution.mjs'

const project = 'a'.repeat(24)

describe('UTF-16 operations', () => {
  it('converts CJK and emoji byte offsets', () => {
    expect(utf8Offset('a中文😀z', 5)).toBe(11)
    expect(convertComponent('a中文😀z', { p: 3, d: '😀' })).toEqual({
      start: 7,
      end: 11,
      text: '',
      content: 'a中文z',
    })
    expect(convertComponent('中😀', { p: 1, i: '文' }).content).toBe('中文😀')
  })
  it('rejects split surrogate pairs, bad offsets and mismatched deletes', () => {
    expect(() => utf8Offset('😀', 1)).toThrow('surrogate')
    expect(() => utf8Offset('a', 2)).toThrow('outside')
    expect(() => convertComponent('abc', { p: 1, d: 'x' })).toThrow('match')
    expect(() => convertComponent('a', { p: 0 })).toThrow('insert or delete')
  })
})

describe('tickets', () => {
  it('binds project, user and a sixty-second expiry', () => {
    const ticket = createTicket(project, 'user', 'secret', 1000)
    expect(verifyTicket(ticket, 'secret', project, 2000)).toEqual({
      project,
      user: 'user',
      kind: 'open',
      expiry: 61000,
    })
    expect(() => verifyTicket(ticket, 'secret', project, 61000)).toThrow(
      'expired'
    )
    expect(() => verifyTicket(ticket, 'secret', project, 0)).toThrow('expired')
    expect(() => verifyTicket(ticket, 'wrong', project, 2000)).toThrow(
      'invalid'
    )
    expect(() => verifyTicket(ticket, 'secret', 'b'.repeat(24), 2000)).toThrow(
      'invalid'
    )
  })
  function signedClaims(claims) {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const signature = createHmac('sha256', 'secret')
      .update(payload)
      .digest('base64url')
    return `${payload}.${signature}`
  }
  it('accepts legacy opening tickets and rejects kind confusion both ways', () => {
    const legacy = signedClaims({ project, user: 'user', expiry: 61000 })
    expect(verifyTicket(legacy, 'secret', project, 1000).user).toBe('user')
    const access = createAccessToken(project, 'user', 'secret', 1000, 60000)
    expect(() => verifyTicket(access, 'secret', project, 1000)).toThrow()
    for (const token of [
      legacy,
      createTicket(project, 'user', 'secret', 1000),
    ]) {
      expect(() => verifyAccessToken(token, 'secret', project, 1000)).toThrow()
    }
    const unknown = signedClaims({
      project,
      user: 'user',
      expiry: 61000,
      kind: 'other',
    })
    expect(() => verifyTicket(unknown, 'secret', project, 1000)).toThrow()
    expect(() => verifyAccessToken(unknown, 'secret', project, 1000)).toThrow()
  })
  it('binds access tokens to project/user with a fifteen-minute expiry and claim checks', () => {
    const token = createAccessToken(project, 'user', 'secret', 1000)
    expect(verifyAccessToken(token, 'secret', project, 1000)).toEqual({
      project,
      user: 'user',
      kind: 'access',
      expiry: 901000,
    })
    expect(verifyAccessToken(token, 'secret', project, 900999).user).toBe(
      'user'
    )
    expect(() => verifyAccessToken(token, 'secret', project, 901000)).toThrow()
    expect(() => verifyAccessToken(token, 'secret', project, 0)).toThrow()
    expect(() => verifyAccessToken(token, 'wrong', project, 1000)).toThrow()
    expect(() =>
      verifyAccessToken(token, 'secret', 'b'.repeat(24), 1000)
    ).toThrow()
    expect(() =>
      verifyAccessToken(createAccessToken(project, '', 'secret'), 'secret')
    ).toThrow()
    const custom = createAccessToken(project, 'user', 'secret', 1000, 120000)
    expect(
      verifyAccessToken(custom, 'secret', project, 1000, 120000).expiry
    ).toBe(121000)
    expect(() =>
      verifyAccessToken(custom, 'secret', project, 1000, 60000)
    ).toThrow()
  })
  it('rejects malformed signatures and missing user', () => {
    expect(() => verifyTicket('garbage', 'secret')).toThrow()
    expect(() =>
      verifyTicket(createTicket(project, '', 'secret'), 'secret')
    ).toThrow()
    expect(() => createTicket('../project', 'user', 'secret')).toThrow()
  })
})

describe('frames', () => {
  it.each(Object.keys(frameTypes))(
    'round trips %s with binary payload',
    type => {
      const body =
        type === 'paragraph' ? new Uint8Array([0, 255, 12]) : new Uint8Array()
      const frame = encodeFrame(type, { text: '中文😀' }, body)
      expect(frame[0]).toBe(frameTypes[type])
      expect(decodeFrame(frame)).toEqual({
        type,
        header: { text: '中文😀' },
        body,
      })
    }
  )
  it('rejects unknown and truncated frames', () => {
    expect(() => encodeFrame('bad', {})).toThrow()
    expect(() => decodeFrame(Buffer.from([1, 100, 0, 0, 0]))).toThrow()
  })
})

describe('attribution', () => {
  it('maps touched, added and removed units and discards old results', () => {
    const attribution = new Attribution()
    attribution.record(
      {
        edit_id: 1,
        source_revision: 1,
        outcome: { touched: [1], added: [2], removed: [3] },
      },
      'alice'
    )
    attribution.record(
      { edit_id: 2, source_revision: 2, outcome: { touched: [1] } },
      'bob'
    )
    expect(attribution.forEvent({ par_id: 1, edit_id: 1 })).toEqual({
      stale: true,
    })
    expect(attribution.forEvent({ par_id: 1, edit_id: 2 }).user_id).toBe('bob')
    expect(attribution.forEvent({ par_id: 2, edit_id: 1 }).user_id).toBe(
      'alice'
    )
    expect(attribution.forEvent({ par_id: 3, edit_id: 1 }).user_id).toBe(
      'alice'
    )
    expect(attribution.forEvent({ par_id: 4 }).user_id).toBeNull()
  })
})
