import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  createTicket,
  verifyTicket,
  createAccessToken,
  verifyAccessToken,
} from '../../Tickets.mjs'
import { encodeFrame, decodeFrame, frameTypes } from '../../Frames.mjs'
import { decodeDisplayList } from '../../DisplayList.mjs'

const project = 'a'.repeat(24)

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

describe('browser codecs', () => {
  it('decodes a sliced ArrayBuffer view and preserves paragraph bytes', () => {
    const frame = encodeFrame('paragraph', { par_id: 1 }, new Uint8Array([255]))
    const padded = new Uint8Array(frame.length + 8)
    padded.set(frame, 4)
    const view = padded.subarray(4, 4 + frame.length)
    expect(decodeFrame(view).body).toEqual(new Uint8Array([255]))
    expect(decodeFrame(frame.buffer).header).toEqual({ par_id: 1 })
  })
  it('rejects invalid UTF-8, non-object headers and unexpected bodies', () => {
    for (const header of [null, [], 42]) {
      expect(() => decodeFrame(encodeFrame('hello', header))).toThrow()
    }
    expect(() => decodeFrame(new Uint8Array([1, 1, 0, 0, 0, 255]))).toThrow()
    expect(() =>
      decodeFrame(encodeFrame('hello', {}, new Uint8Array([1])))
    ).toThrow()
  })
  it('decodes RTDL in the browser and rejects truncated lists', () => {
    const bytes = new Uint8Array(21)
    bytes.set(new TextEncoder().encode('RTDL'))
    const view = new DataView(bytes.buffer)
    view.setUint16(4, 1, true)
    view.setUint32(8, bytes.length, true)
    bytes[16] = 255
    expect(decodeDisplayList(bytes.buffer)).toEqual({
      fonts: {},
      lines: [],
      other: [],
      degraded: false,
    })
    expect(() => decodeDisplayList(bytes.subarray(0, 20))).toThrow()
  })
})
