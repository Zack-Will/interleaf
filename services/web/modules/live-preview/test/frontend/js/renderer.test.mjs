import { expect } from 'chai'
import sinon from 'sinon'
import { OverlayRenderer } from '../../../frontend/js/overlay-renderer.mjs'
import { binaryList, binaryRow } from '../helpers/display-list.mjs'

describe('live-preview overlay lifecycle', function () {
  let renderer
  let handlers
  let wrapper
  let page
  let context
  let canvasStub
  beforeEach(function () {
    handlers = new Map()
    context = {
      setTransform: sinon.spy(),
      fillRect: sinon.spy(),
      strokeRect: sinon.spy(),
      drawImage: sinon.spy(),
    }
    canvasStub = sinon
      .stub(window.HTMLCanvasElement.prototype, 'getContext')
      .returns(context)
    page = document.createElement('div')
    page.className = 'page'
    page.style.backgroundColor = 'white'
    document.body.append(page)
    wrapper = {
      eventBus: {
        on: (name, fn) => handlers.set(name, fn),
        off: (name, fn) => {
          if (handlers.get(name) === fn) handlers.delete(name)
        },
      },
      viewer: {
        pdfDocument: {},
        getPageView: () => ({
          div: page,
          viewport: {
            width: 600,
            height: 800,
            viewBox: [0, 0, 600, 800],
            transform: [1, 0, 0, -1, 0, 800],
          },
        }),
      },
    }
    renderer = new OverlayRenderer({
      wrapper,
      getAccess: () => 'access',
      fetchJSON: sinon.stub(),
      currentUser: 'me',
      userColor: () => 'red',
    })
  })
  afterEach(function () {
    renderer.dispose()
    page.remove()
    canvasStub.restore()
  })

  it('waits for base pages, reattaches after reset, sizes by DPR, outlines remote edits and clears layouts', async function () {
    renderer.layout({
      placements: [
        { par_id: 1, row_rects: [{ page: 1, x: 100, y: 150, w: 300, h: 60 }] },
      ],
    })
    const frame = {
      header: {
        par_id: 1,
        user_id: 'remote',
        status: 'ok',
        fonts: {},
        fragments: [
          { page: 1, first_line: 1, last_line: 1, xs: [100], baselines: [200] },
        ],
      },
      body: binaryList(binaryRow()),
    }
    await renderer.paragraph(frame)
    expect(page.querySelector('canvas')).to.equal(null)
    handlers.get('pagesinit')()
    const canvas = page.querySelector('canvas')
    expect(canvas.width).to.equal(Math.ceil(600 * window.devicePixelRatio))
    expect(context.strokeStyle).to.equal('red')
    expect(context.strokeRect.callCount).to.be.greaterThan(0)
    canvas.remove()
    handlers.get('pagerendered')()
    expect(page.querySelectorAll('canvas')).to.have.length(1)
    expect(page.querySelector('canvas')).to.equal(canvas)
    renderer.layout({ placements: [] })
    handlers.get('pagesdestroy')()
    expect(page.querySelector('canvas')).to.equal(null)
    renderer.dispose()
    expect(handlers.size).to.equal(0)
  })

  it('rejects asynchronous glyph work from an older layout', async function () {
    renderer.layout({ placements: [{ par_id: 1, row_rects: [] }] })
    const frame = {
      header: { par_id: 1, status: 'ok', fonts: {}, fragments: [] },
      body: binaryList(binaryRow()),
    }
    // paragraph awaits resource preparation even for a glyph-free list.
    const pending = renderer.paragraph(frame)
    renderer.layout({ placements: [] })
    await pending
    expect(renderer.model.units.size).to.equal(0)
  })

  it('reports loaded PDF page bounds in sp regardless of zoom and excludes unknown page sizes', function () {
    const pageView = wrapper.viewer.getPageView(0)
    pageView.pdfPage = {}
    pageView.viewport.viewBox = [20, 10, 620, 810]
    pageView.viewport.width = 1200
    pageView.viewport.height = 1600
    wrapper.viewer.pagesCount = 2
    wrapper.viewer.getPageView = index =>
      index === 0 ? pageView : { viewport: pageView.viewport }
    const report = sinon.spy()
    renderer.onPageSizes = report
    handlers.get('pagesinit')()
    const sizes = report.lastCall.args[0]
    expect(sizes.size).to.equal(1)
    expect(sizes.get(1).width).to.be.closeTo((600 * 72.27 * 65536) / 72, 0.001)
    expect(sizes.get(1).height).to.be.closeTo((800 * 72.27 * 65536) / 72, 0.001)
  })

  it('keeps visible page pixels and overlays until that page renders in the new document', function () {
    const container = document.createElement('div')
    const base = document.createElement('canvas')
    base.width = 600
    base.height = 800
    const canvasWrapper = document.createElement('div')
    canvasWrapper.className = 'canvasWrapper'
    canvasWrapper.append(base)
    page.append(canvasWrapper)
    const overlay = document.createElement('canvas')
    overlay.dataset.livePreviewOverlay = '1'
    page.append(overlay)
    page.style.filter = 'invert(95%)'
    container.append(page)
    document.body.append(container)
    container.scrollTop = 100
    container.scrollLeft = 40
    sinon.stub(container, 'getBoundingClientRect').returns({
      left: 20,
      top: 30,
      right: 700,
      bottom: 1000,
    })
    sinon.stub(base, 'getBoundingClientRect').returns({
      left: 100,
      top: -20,
      width: 600,
      height: 800,
    })
    const pageRect = sinon.stub(page, 'getBoundingClientRect').returns({
      left: 100,
      top: -20,
      right: 700,
      bottom: 780,
    })
    const pageView = wrapper.viewer.getPageView(0)
    wrapper.viewer.getPageView = () => pageView
    wrapper.viewer.pagesCount = 1
    wrapper.container = container
    handlers.get('pagesinit')()
    renderer.layout({ placements: [] })
    // No copy until the actual synchronous document swap begins.
    expect(container.querySelector('[data-live-preview-pixels]')).to.equal(null)
    handlers.get('pagesdestroy')()
    const held = container.querySelector('[data-live-preview-pixels]')
    expect(held).not.to.equal(null)
    expect(context.drawImage).to.have.been.calledWith(base, 0, 0, 600, 800)
    expect(context.drawImage).to.have.been.calledWith(overlay, 0, 0, 600, 800)
    expect(held.style.left).to.equal('120px')
    expect(held.style.top).to.equal('50px')
    expect(held.style.filter).to.equal('invert(95%)')
    // An old render in between destroy and new pagesinit cannot release it.
    handlers.get('pagerendered')({ source: pageView, pageNumber: 1 })
    expect(container.contains(held)).to.equal(true)
    page.remove()
    container.append(page)
    page.replaceChildren()
    wrapper.viewer.pdfDocument = {}
    handlers.get('pagesinit')()
    expect(container.contains(held)).to.equal(true)
    expect(page.contains(held)).to.equal(false)
    // Restoring zoom resets page children again after pagesinit.
    page.replaceChildren()
    container.scrollTop = 110
    container.scrollLeft = 20
    pageView.viewport.width = 300
    pageView.viewport.height = 400
    pageRect.returns({ left: 70, top: -10, right: 370, bottom: 390 })
    handlers.get('scalechanging')()
    expect(held.style.left).to.equal('70px')
    expect(held.style.top).to.equal('70px')
    expect(held.style.width).to.equal('300px')
    expect(held.style.height).to.equal('400px')
    expect(held.width).to.equal(600)
    handlers.get('pagerendered')({ source: {}, pageNumber: 1 })
    expect(container.contains(held)).to.equal(true)
    handlers.get('pagerendered')({
      source: pageView,
      pageNumber: 1,
      cssTransform: true,
    })
    expect(container.contains(held)).to.equal(true)
    handlers.get('pagerendered')({
      source: pageView,
      pageNumber: 1,
      error: new Error('render'),
    })
    expect(container.contains(held)).to.equal(true)
    handlers.get('pagerendered')({ source: pageView, pageNumber: 1 })
    expect(container.contains(held)).to.equal(false)
    container.remove()
  })

  it('expires held pixels if the replacement never renders and cancels the fallback on disposal', function () {
    const clock = sinon.useFakeTimers()
    const container = document.createElement('div')
    const canvasWrapper = document.createElement('div')
    canvasWrapper.className = 'canvasWrapper'
    canvasWrapper.append(document.createElement('canvas'))
    page.append(canvasWrapper)
    container.append(page)
    wrapper.viewer.pagesCount = 1
    wrapper.container = container
    try {
      handlers.get('pagesdestroy')()
      expect(renderer.pixels.pages.size).to.equal(1)
      clock.tick(9999)
      expect(renderer.pixels.pages.size).to.equal(1)
      clock.tick(1)
      expect(renderer.pixels.pages.size).to.equal(0)
      handlers.get('pagesdestroy')()
      renderer.dispose()
      expect(clock.countTimers()).to.equal(0)
    } finally {
      clock.restore()
      container.remove()
    }
  })
})
