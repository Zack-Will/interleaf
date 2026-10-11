import { EventEmitter } from 'node:events'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import sinon from 'sinon'
import { createSocketAccess } from '../../app/src/SocketAccess.mjs'
import { verifyAccessToken } from '@overleaf/live-preview-protocol/Tickets.mjs'
import { decodeFrame } from '@overleaf/live-preview-protocol/Frames.mjs'
import { settingsFromEnv } from '../../config/settings.defaults.mjs'

describe('socket access renewal', () => {
  const project = 'a'.repeat(24)
  let socket
  let send
  let getAccess
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    socket = Object.assign(new EventEmitter(), { readyState: 1 })
    send = sinon.spy()
    getAccess = createSocketAccess({
      socket,
      claims: { project, user: 'alice' },
      settings: settingsFromEnv({ LIVE_PREVIEW_TICKET_SECRET: 'secret' }),
      send,
    })
  })
  afterEach(() => {
    socket.emit('close')
    vi.useRealTimers()
  })
  it('issues hello credentials and repeatedly renews before expiry without web tickets', async () => {
    const hello = getAccess()
    expect(hello.access_expiry).toBe(901000)
    await vi.advanceTimersByTimeAsync(719999)
    expect(send.called).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const first = decodeFrame(send.firstCall.args[1])
    expect(first.type).toBe('access')
    expect(first.header.access).not.toBe(hello.access)
    expect(first.header.access_expiry).toBe(1621000)
    expect(verifyAccessToken(first.header.access, 'secret', project).user).toBe(
      'alice'
    )
    expect(verifyAccessToken(hello.access, 'secret', project).user).toBe(
      'alice'
    )
    await vi.advanceTimersByTimeAsync(180000)
    expect(() => verifyAccessToken(hello.access, 'secret', project)).toThrow()
    expect(verifyAccessToken(first.header.access, 'secret', project).user).toBe(
      'alice'
    )
    await vi.advanceTimersByTimeAsync(540000)
    expect(send.callCount).toBe(2)
  })
  it('resync renews hello credentials and replaces the previous renewal timer', async () => {
    getAccess()
    await vi.advanceTimersByTimeAsync(600000)
    const hello = getAccess()
    expect(hello.access_expiry).toBe(1501000)
    await vi.advanceTimersByTimeAsync(120000)
    expect(send.called).toBe(false)
    await vi.advanceTimersByTimeAsync(600000)
    expect(send.calledOnce).toBe(true)
  })
  it('cancels renewal on close and does not send while closing', async () => {
    getAccess()
    socket.readyState = 2
    await vi.advanceTimersByTimeAsync(720000)
    expect(send.called).toBe(false)
    socket.readyState = 1
    getAccess()
    socket.emit('close')
    await vi.advanceTimersByTimeAsync(1800000)
    expect(send.called).toBe(false)
  })
})
