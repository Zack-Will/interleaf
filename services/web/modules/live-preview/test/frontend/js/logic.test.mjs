import { expect } from 'chai'
import sinon from 'sinon'
import { encodeFrame } from '../../../../../../live-preview/app/src/Frames.mjs'
import { layoutRowRects } from '../../../../../../live-preview/app/src/DisplayList.mjs'
import {
  decodeFrame,
  decodeDisplayList,
  accessUrl,
  socketUrl,
  reconnectDelay,
} from '../../../frontend/js/protocol.mjs'
import {
  SP_TO_BP,
  pageTransform,
  glyphTransform,
  placedRows,
} from '../../../frontend/js/geometry.mjs'
import { OverlayModel } from '../../../frontend/js/overlay-model.mjs'
import { GlyphCache, glyphRequests } from '../../../frontend/js/glyph-cache.mjs'
import {
  createLease,
  getFlushDelay,
  setLiveFlushDelay,
  subscribeFlushDelay,
} from '../../../frontend/js/flush-delay.mjs'
import { Painter, pdfColor } from '../../../frontend/js/painter.mjs'
import {
  binaryList,
  binaryRow,
  binaryFont,
  record,
  integers,
} from '../helpers/display-list.mjs'

const line = { x: 10, y: 50, w: 100, h: 8, d: 2, items: [] }
const fragments = [
  { page: 2, first_line: 1, last_line: 1, x: 200, xs: [210], baselines: [400] },
]
const list = { lines: [line], other: [], fonts: {}, degraded: false }

describe('live-preview protocol and display lists', function () {
  it('retains only row geometry for the service page cache', function () {
    const bytes = binaryList([
      binaryFont(),
      ...binaryRow().slice(0, 2),
      record(0x21, integers([1, 2, 3, 4])),
      record(0x11),
    ])
    const decoded = decodeDisplayList(bytes, { geometryOnly: true })
    expect(decoded.fonts).to.deep.equal({})
    expect(decoded.lines[0].items).to.deep.equal([])
    expect(decoded.lines[0]).to.include({
      x: 100,
      y: 200,
      w: 300,
      h: 50,
      d: 10,
      unit: 7,
    })
  })
  it('decodes all frame types, UTF-8 headers and a sliced binary body', function () {
    for (const type of [
      'hello',
      'layout',
      'background',
      'diagnostics',
      'engine',
      'busy',
      'access',
    ]) {
      const frame = encodeFrame(type, { text: '中文😀' })
      expect(decodeFrame(frame).header.text).to.equal('中文😀')
      expect(decodeFrame(frame).type).to.equal(type)
    }
    const bytes = binaryList(binaryRow())
    const frame = encodeFrame('paragraph', {}, bytes)
    const wrapped = Buffer.concat([Buffer.alloc(8), frame]).subarray(8)
    expect([...decodeFrame(wrapped).body]).to.deep.equal([...bytes])
    expect(decodeDisplayList(decodeFrame(wrapped).body).lines[0].unit).to.equal(
      7
    )
  })

  it('rejects truncated, invalid-type, invalid-JSON and unexpected-body frames', function () {
    for (const bytes of [
      Buffer.alloc(3),
      Buffer.from([9, 0, 0, 0, 0]),
      Buffer.from([1, 255, 0, 0, 0]),
      Buffer.from([1, 1, 0, 0, 0, 33]),
      encodeFrame('hello', {}, Buffer.from([1])),
    ]) {
      expect(() => decodeFrame(bytes)).to.throw()
    }
  })

  it('decodes fonts, runs, rules, colour and font metadata overrides', function () {
    const run = Buffer.alloc(32)
    run.writeUInt32LE(5)
    run.writeInt32LE(50, 4)
    run.writeInt32LE(10000, 8)
    run.writeUInt32LE(1, 12)
    run.writeUInt32LE(0x4e2d, 16)
    run.writeUInt32LE(0xffffffff, 20)
    run.writeInt32LE(10, 24)
    run.writeInt32LE(20, 28)
    const metadata = Buffer.from('{"size":655360.5}')
    const prefix = Buffer.alloc(6)
    prefix.writeUInt32LE(5)
    prefix.writeUInt16LE(metadata.length, 4)
    const color = Buffer.from('1 0 0 rg')
    const cp = Buffer.alloc(6)
    cp.writeUInt16LE(2, 2)
    cp.writeUInt16LE(color.length, 4)
    const decoded = decodeDisplayList(
      binaryList([
        binaryFont(),
        record(4, Buffer.concat([prefix, metadata])),
        ...binaryRow().slice(0, 2),
        record(0x20, run),
        record(0x21, integers([1, 2, 3, 4])),
        record(0x22, Buffer.concat([cp, color])),
        record(0x11),
      ])
    )
    expect(decoded.fonts[5]).to.include({
      size: 655360.5,
      slant: 200,
      extend: 1200,
    })
    expect(decoded.lines[0].items).to.deep.equal([
      ['g', 5, 0x4e2d, null, 10, 50, 20, 10000],
      ['r', 1, 2, 3, 4],
      ['c', 2, 0, '1 0 0 rg'],
    ])
  })

  it('skips extensions safely and marks images, literals, flags and unsupported content degraded', function () {
    for (const tag of [3, 0x23, 0x24, 0x26, 0x99])
      expect(decodeDisplayList(binaryList([record(tag)])).degraded).to.equal(
        true
      )
    const bytes = binaryList(binaryRow())
    for (const mutation of [
      data => data.writeUInt16LE(2, 4),
      data => data.writeUInt32LE(99999, 17),
      data => data.writeUInt32LE(1, 8),
    ]) {
      const copy = Buffer.from(bytes)
      mutation(copy)
      expect(() => decodeDisplayList(copy)).to.throw()
    }
    const missingEnd = bytes.subarray(0, bytes.length - 5)
    missingEnd.writeUInt32LE(missingEnd.length, 8)
    expect(() => decodeDisplayList(missingEnd)).to.throw('END')
  })

  it('uses access tickets for HTTP and opening tickets for secure/insecure sockets', function () {
    expect(accessUrl('/live-preview/pdf/p/2', 'a+b')).to.equal(
      '/live-preview/pdf/p/2?ticket=a%2Bb'
    )
    expect(() =>
      accessUrl('https://foreign/live-preview/pdf/p/2', 'a')
    ).to.throw()
    expect(
      socketUrl('p', 't', { origin: 'https://host', protocol: 'https:' })
    ).to.equal('wss://host/live-preview/ws?project=p&ticket=t')
    expect(
      socketUrl('p', 't', { origin: 'http://host', protocol: 'http:' })
    ).to.match(/^ws:/)
    expect([0, 1, 10].map(reconnectDelay)).to.deep.equal([500, 1000, 30000])
  })
})

describe('live-preview geometry and erase planning', function () {
  it('maps top-left sp to viewport coordinates, including rotation, crop and DPR', function () {
    const scale = pageTransform(
      { viewBox: [10, 20, 610, 820], transform: [2, 0, 0, -2, -20, 1640] },
      2
    )
    expect(scale).to.deep.equal([4 * SP_TO_BP, 0, 0, 4 * SP_TO_BP, 0, 0])
    const rotated = pageTransform(
      { viewBox: [0, 0, 600, 800], transform: [0, 1, 1, 0, 0, 0] },
      1
    )
    expect(rotated).to.deep.equal([0, SP_TO_BP, -SP_TO_BP, 0, 800, 0])
  })

  it('places rows by their fragment, and applies expansion, extend, slant and y-up glyphs', function () {
    expect(placedRows(list, fragments)[0]).to.include({
      page: 2,
      dx: 200,
      dy: 350,
    })
    const transform = glyphTransform(
      { size: 1000, slant: 200, extend: 1200 },
      ['g', 5, 65, 2, 10, 50, 20, 10000],
      1000,
      200,
      350
    )
    expect(transform).to.deep.equal([1.212, 0, 0.2, -1, 210, 400])
  })

  it('derives base rectangles by placement and includes other rows of the capture unit', function () {
    const pages = new Map([
      [
        2,
        decodeDisplayList(
          binaryList([
            ...binaryRow({ x: 210, y: 400 }),
            ...binaryRow({ x: 215, y: 500, row: 2 }),
            ...binaryRow({ x: 10, y: 900, unit: 8 }),
          ])
        ),
      ],
    ])
    const result = layoutRowRects([{ par_id: 99, fragments }], pages)[0]
    expect(result.row_rects).to.deep.equal([
      { page: 2, x: 210, y: 350, w: 300, h: 60 },
      { page: 2, x: 215, y: 450, w: 300, h: 60 },
    ])
  })

  it('keeps error drawings, erases removed units, restores degraded base and resets at layout', function () {
    const model = new OverlayModel()
    const base = { page: 1, x: 20, y: 30, w: 100, h: 10 }
    model.layout({ placements: [{ par_id: 1, row_rects: [base] }] })
    model.paragraph({ par_id: 1, status: 'ok', fragments }, list)
    const previous = model.units.get(1)
    expect(previous.erase).to.have.length(2)
    model.paragraph({ par_id: 1, status: 'error' })
    expect(model.units.get(1)).to.equal(previous)
    model.paragraph({ par_id: 1, status: 'removed' })
    expect(model.units.get(1).rows).to.have.length(0)
    expect(model.units.get(1).erase).to.have.length(2)
    model.paragraph({ par_id: 1, status: 'ok' }, { ...list, degraded: true })
    expect(model.units.size).to.equal(0)
    model.layout({ placements: [] })
    expect(model.baseRects.size).to.equal(0)
    expect(
      model.paragraph({ par_id: 5, status: 'ok', fragments }, list)
    ).to.equal(false)
    model.layout({ placements: [{ par_id: 5, row_rects: [] }] })
    expect(
      model.paragraph({ par_id: 5, status: 'ok', fragments }, list)
    ).to.equal(false)
  })
})

describe('live-preview glyph cache and colours', function () {
  it('draws cached outlines and rules with absolute glyph transforms and the active colour', function () {
    const context = {
      setTransform: sinon.spy(),
      fill: sinon.spy(),
      fillRect: sinon.spy(),
    }
    const glyph = { path: {}, unitsPerEm: 1000 }
    const cache = { get: sinon.stub().returns(glyph) }
    const painter = new Painter(context, [1, 0, 0, 1, 0, 0], cache, {
      5: { font_key: 'font', ids: 'glyph_index' },
    })
    painter.draw(
      { fonts: { 5: { size: 1000, extend: 1200, slant: 200 } } },
      [
        ['c', 0, 0, '1 0 0 rg'],
        ['g', 5, 65, 2, 10, 50, 20, 10000],
        ['r', 1, 2, 3, 4],
      ],
      200,
      350
    )
    expect(context.setTransform.firstCall.args).to.deep.equal([
      1.212, 0, 0.2, -1, 210, 400,
    ])
    expect(context.fill).to.have.been.calledWith(glyph.path)
    expect(context.fillRect).to.have.been.calledWith(201, 352, 3, 4)
    expect(context.fillStyle).to.equal('rgb(255,0,0)')
  })
  it('deduplicates concurrent glyph loads and reads renewed access on retries', async function () {
    let access = 'first'
    const fetchJSON = sinon.stub().callsFake(async () => ({
      unitsPerEm: 1000,
      glyphs: { 1: { path: 'M0 0' }, 2: { path: '' } },
    }))
    const makePath = sinon.spy(data => ({ data }))
    const cache = new GlyphCache({
      getAccess: () => access,
      fetchJSON,
      makePath,
    })
    await Promise.all([cache.load('font', [1, 1]), cache.load('font', [1, 2])])
    expect(fetchJSON.callCount).to.equal(2)
    expect(makePath.callCount).to.equal(2)
    await cache.load('font', [1, 2])
    expect(fetchJSON.callCount).to.equal(2)
    access = 'renewed'
    fetchJSON.rejects(new Error('expired'))
    try {
      await cache.load('other', [1])
    } catch {
      /* retry below */
    }
    fetchJSON.resolves({ unitsPerEm: 1000, glyphs: { 1: { path: '' } } })
    await cache.load('other', [1])
    expect(fetchJSON.lastCall.args[0]).to.include('ticket=renewed')
  })

  it('requests character codes for Type 1 and glyph indexes for OpenType', function () {
    const data = {
      ...list,
      fonts: { 1: {}, 2: {} },
      other: [
        ['g', 1, 65, null],
        ['g', 2, 66, 123],
      ],
    }
    const requests = glyphRequests(data, {
      1: { ids: 'char_code', font_key: 't1' },
      2: { ids: 'glyph_index', font_key: 'otf' },
    })
    expect([...requests.get('t1')]).to.deep.equal([65])
    expect([...requests.get('otf')]).to.deep.equal([123])
  })

  it('handles PDF grayscale/RGB/CMYK and nested colour stacks', function () {
    expect(pdfColor('0.5 g')).to.equal('rgb(128,128,128)')
    expect(pdfColor('1 0 0 rg 0 0 1 RG')).to.equal('rgb(255,0,0)')
    expect(pdfColor('0 1 1 0 k')).to.equal('rgb(255,0,0)')
    expect(pdfColor('invalid')).to.equal(undefined)
    const painter = new Painter({}, [], {}, {})
    painter.colorOp(0, 0, '1 0 0 rg')
    painter.colorOp(0, 1, '0 0 1 rg')
    expect(painter.color).to.equal('rgb(0,0,255)')
    painter.colorOp(0, 2, '')
    expect(painter.color).to.equal('rgb(255,0,0)')
  })
})

describe('live-preview project lease', function () {
  it('refreshes the 150 ms delay in every editor and restores each original fallback', function () {
    const clock = sinon.useFakeTimers()
    const delays = []
    const unsubscribe = subscribeFlushDelay(() =>
      delays.push([getFlushDelay(2000), getFlushDelay(500)])
    )
    const lease = createLease(active => setLiveFlushDelay(active ? 150 : null))
    try {
      lease.refresh({ leaseMs: 75000 })
      clock.tick(30000)
      lease.refresh({ leaseMs: 75000 })
      clock.tick(74999)
      expect(delays.at(-1)).to.deep.equal([150, 150])
      clock.tick(1)
      expect(delays.at(-1)).to.deep.equal([2000, 500])
      lease.refresh({ leaseMs: 75000 })
      lease.clear()
      expect(delays.at(-1)).to.deep.equal([2000, 500])
      lease.refresh({ leaseMs: -1 })
      expect(delays.at(-1)).to.deep.equal([2000, 500])
    } finally {
      unsubscribe()
      lease.clear()
      clock.restore()
    }
  })
})
