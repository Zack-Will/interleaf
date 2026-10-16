import { expect } from 'chai'
import sinon from 'sinon'
import {
  createLayoutScheduler,
  needsBasePdf,
} from '../../../frontend/js/layout-scheduler.mjs'

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

  it('forces base refresh for stale pagination, missing/approximate placements, removals and degraded content', function () {
    const frame = {
      header: { status: 'ok', fragments: [{ approximate: false }] },
      body: new Uint8Array(),
    }
    expect(needsBasePdf(frame)).to.equal(false)
    for (const header of [
      { pagination_stale: true },
      { status: 'removed' },
      { status: 'ok_degraded' },
      { status: 'ok', fragments: [] },
      { fragments: [{ approximate: true }] },
    ])
      expect(needsBasePdf({ header })).to.equal(true)
    expect(needsBasePdf({ header: {}, body: new Uint8Array([1]) })).to.equal(
      true
    )
  })
})
