import { expect } from 'chai'
import sinon from 'sinon'
import {
  createLayoutScheduler,
  needsBasePdf,
} from '../../../frontend/js/layout-scheduler.mjs'
import {
  binaryList,
  binaryRow,
  integers,
  record,
} from '../helpers/display-list.mjs'

describe('base PDF scheduling', function () {
  let clock
  let scheduler
  let apply
  let release
  beforeEach(function () {
    clock = sinon.useFakeTimers()
    clock.tickAsync = async milliseconds => {
      for (let index = 0; index < 5; index++) await Promise.resolve()
      clock.tick(milliseconds)
      for (let index = 0; index < 5; index++) await Promise.resolve()
    }
    apply = sinon.spy()
    release = sinon.spy()
    scheduler = createLayoutScheduler({
      apply,
      release,
      prepare: async header => `blob:${header.version}`,
    })
  })
  afterEach(function () {
    scheduler.dispose()
    clock.restore()
  })

  it('keeps the latest prefetched layout through sustained edits and applies after a second of quiet', async function () {
    scheduler.layout({ version: 1 }, 1)
    await clock.tickAsync(0)
    scheduler.activity()
    scheduler.layout({ version: 2 }, 2)
    await clock.tickAsync(700)
    scheduler.activity()
    scheduler.layout({ version: 3 }, 3)
    await clock.tickAsync(999)
    expect(apply.callCount).to.equal(1)
    await clock.tickAsync(1)
    expect(apply.lastCall.args).to.deep.equal([{ version: 3 }, 'blob:3'])
    expect(release).to.have.been.calledWith('blob:2')
    expect(release).to.have.been.calledWith('blob:1')
  })

  it('immediately applies only a pending layout that contains an unrepresentable edit', async function () {
    scheduler.layout({ version: 1 }, 1)
    await clock.tickAsync(0)
    scheduler.activity()
    scheduler.requireBase(3)
    scheduler.layout({ version: 2 }, 2)
    await clock.tickAsync(0)
    expect(apply.callCount).to.equal(1)
    scheduler.layout({ version: 3 }, 3)
    await clock.tickAsync(0)
    expect(apply.callCount).to.equal(2)
  })

  it('ignores and releases superseded or disposed downloads', async function () {
    scheduler.dispose()
    const pending = new Map()
    scheduler = createLayoutScheduler({
      apply,
      release,
      prepare: header =>
        new Promise(resolve => pending.set(header.version, resolve)),
    })
    scheduler.layout({ version: 1 }, 1)
    await clock.tickAsync(0)
    scheduler.layout({ version: 2 }, 2)
    await clock.tickAsync(0)
    pending.get(1)('blob:1')
    await clock.tickAsync(0)
    expect(apply.called).to.equal(false)
    scheduler.dispose()
    pending.get(2)('blob:2')
    await clock.tickAsync(0)
    expect(apply.called).to.equal(false)
    expect(release.callCount).to.equal(2)
  })

  it('defers an extra approximate line and stale pagination when the overlay can draw every row', function () {
    const layout = {
      pages_total: 1,
      placements: [{ par_id: 7, row_rects: [{ page: 1 }] }],
    }
    const frame = {
      header: {
        par_id: 7,
        status: 'ok',
        pagination_stale: true,
        fragments: [
          {
            approximate: true,
            page: 1,
            first_line: 1,
            last_line: 2,
            xs: [100, 100],
            baselines: [200, 270],
          },
        ],
      },
      body: binaryList([
        record(1, integers([600, 800, 0, 1, 600, 800, 0, 0, 0, 0])),
        ...binaryRow(),
        ...binaryRow({ row: 2 }),
      ]),
    }
    expect(needsBasePdf(frame, layout)).to.equal(false)
    const omittedDimensions = {
      ...frame,
      body: binaryList([
        record(1, integers([600, 800, 0, 1, 0, 0, 0, 0, 0, 0])),
        ...binaryRow(),
        ...binaryRow({ row: 2 }),
      ]),
    }
    const basePages = new Map([[1, { width: 600, height: 800 }]])
    expect(needsBasePdf(omittedDimensions, layout, basePages)).to.equal(false)
    expect(needsBasePdf(omittedDimensions, layout)).to.equal(true)
    expect(
      needsBasePdf(
        omittedDimensions,
        layout,
        new Map([[1, { width: 600, height: 250 }]])
      )
    ).to.equal(true)
    // Losing the last line is representable too: the model erases base rows.
    const shorter = {
      ...frame,
      header: {
        ...frame.header,
        fragments: [{ ...frame.header.fragments[0], last_line: 1 }],
      },
      body: binaryList([
        record(1, integers([600, 800, 0, 1, 600, 800, 0, 0, 0, 0])),
        ...binaryRow(),
      ]),
    }
    expect(needsBasePdf(shorter, layout)).to.equal(false)
    expect(
      needsBasePdf({ header: { par_id: 7, status: 'removed' } }, layout)
    ).to.equal(false)
  })

  it('requires a base for missing geometry, incomplete placements, overflow, unavailable pages and degraded content', function () {
    const layout = {
      pages_total: 1,
      placements: [{ par_id: 7, row_rects: [{ page: 1 }] }],
    }
    const fragment = {
      page: 1,
      first_line: 1,
      last_line: 1,
      xs: [100],
      baselines: [200],
    }
    const frame = {
      header: { par_id: 7, status: 'ok', fragments: [fragment] },
      body: binaryList([
        record(1, integers([600, 800, 0, 1, 600, 800, 0, 0, 0, 0])),
        ...binaryRow(),
      ]),
    }
    expect(needsBasePdf(frame, layout)).to.equal(false)
    expect(needsBasePdf(frame)).to.equal(true)
    expect(needsBasePdf(frame, { ...layout, placements: [] })).to.equal(true)
    for (const header of [
      { status: 'ok_degraded' },
      { status: 'ok', fragments: [] },
      { fragments: [{ ...fragment, page: 2 }] },
      { fragments: [{ ...fragment, baselines: [] }] },
      { fragments: [{ ...fragment, baselines: [800] }] },
      { fragments: [{ ...fragment, xs: [NaN] }] },
      { fragments: [{ ...fragment, xs: [400] }] },
      { fragments: [fragment, fragment] },
    ])
      expect(
        needsBasePdf(
          { ...frame, header: { ...frame.header, ...header } },
          layout
        )
      ).to.equal(true)
    expect(
      needsBasePdf({ ...frame, body: new Uint8Array([1]) }, layout)
    ).to.equal(true)
  })
})
