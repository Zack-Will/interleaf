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

  it('keeps visible page pixels and overlays until that page renders in the new document', function () {
    const container = document.createElement('div')
    const base = document.createElement('canvas')
    base.width = 600
    base.height = 800
    const canvasWrapper = document.createElement('div')
    canvasWrapper.className = 'canvasWrapper'
    canvasWrapper.append(base)
    page.append(canvasWrapper)
    container.append(page)
    document.body.append(container)
    const pageView = wrapper.viewer.getPageView(0)
    wrapper.viewer.getPageView = () => pageView
    wrapper.viewer.pagesCount = 1
    wrapper.container = container
    handlers.get('pagesinit')()
    renderer.layout({ placements: [] })
    const held = container.querySelector('[data-live-preview-pixels]')
    expect(held).not.to.equal(null)
    expect(context.drawImage).to.have.been.calledWith(base, 0, 0, 600, 800)
    page.replaceChildren()
    wrapper.viewer.pdfDocument = {}
    handlers.get('pagesinit')()
    expect(page.contains(held)).to.equal(true)
    handlers.get('pagerendered')({ source: {}, pageNumber: 1 })
    expect(page.contains(held)).to.equal(true)
    handlers.get('pagerendered')({
      source: pageView,
      pageNumber: 1,
      cssTransform: true,
    })
    expect(page.contains(held)).to.equal(true)
    handlers.get('pagerendered')({ source: pageView, pageNumber: 1 })
    expect(page.contains(held)).to.equal(false)
    container.remove()
  })
})
