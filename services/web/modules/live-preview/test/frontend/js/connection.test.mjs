import { expect } from 'chai'
import sinon from 'sinon'
import { connectPreview } from '../../../frontend/js/connection.mjs'
import { encodeFrame } from '../../../../../../live-preview/app/src/Frames.mjs'

describe('live-preview connection', function () {
  let clock
  let sockets
  let getTicket
  let onFrame
  let onState
  let stop
  async function tick(ms) {
    clock.tick(ms)
    await Promise.resolve()
    await Promise.resolve()
  }
  beforeEach(function () {
    clock = sinon.useFakeTimers()
    sockets = []
    getTicket = sinon.stub().resolves({ ticket: 'open-token' })
    onFrame = sinon.spy()
    onState = sinon.spy()
    class FakeSocket {
      constructor(url) {
        this.url = url
        this.readyState = 1
        this.send = sinon.spy()
        this.close = () => {
          this.readyState = 3
          this.onclose?.()
        }
        sockets.push(this)
      }
    }
    stop = connectPreview({
      project: 'project',
      getTicket,
      onFrame,
      onState,
      WebSocketClass: FakeSocket,
      location: { origin: 'https://host', protocol: 'https:' },
    })
  })
  afterEach(function () {
    stop()
    clock.restore()
  })

  it('resyncs, decodes access frames, pings at 30 seconds and stops all timers', async function () {
    await tick(0)
    const socket = sockets[0]
    expect(socket.url).to.include('ticket=open-token')
    expect(socket.binaryType).to.equal('arraybuffer')
    socket.onopen()
    socket.onmessage({ data: encodeFrame('hello', { access: 'access-token' }) })
    socket.onmessage({ data: encodeFrame('access', { access: 'renewed' }) })
    expect(onFrame.lastCall.args[0].header.access).to.equal('renewed')
    await tick(30000)
    expect(
      socket.send.args.map(([json]) => JSON.parse(json).cmd)
    ).to.deep.equal(['resync', 'ping'])
    stop()
    await tick(60000)
    expect(getTicket.callCount).to.equal(1)
    expect(socket.readyState).to.equal(3)
  })

  it('gets fresh opening tickets after disconnect, backs off, and cancels during ticket fetch', async function () {
    await tick(0)
    sockets[0].close()
    await tick(499)
    expect(sockets).to.have.length(1)
    await tick(1)
    expect(sockets).to.have.length(2)
    sockets[1].close()
    await tick(999)
    expect(sockets).to.have.length(2)
    getTicket.callsFake(() => new Promise(() => {}))
    await tick(1)
    const signal = getTicket.lastCall.args[0]
    stop()
    expect(signal.aborted).to.equal(true)
  })

  it('closes malformed frames and bounds the handshake wait', async function () {
    await tick(0)
    sockets[0].onmessage({ data: new ArrayBuffer(0) })
    expect(sockets[0].readyState).to.equal(3)
    await tick(500)
    await tick(20000)
    expect(sockets[1].readyState).to.equal(3)
  })
})
