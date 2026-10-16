import { decodeDisplayList } from './protocol.mjs'
import { OverlayModel } from './overlay-model.mjs'
import { GlyphCache, glyphRequests } from './glyph-cache.mjs'
import { pageTransform, paddedRect, SP_TO_BP } from './geometry.mjs'
import { Painter } from './painter.mjs'
import { PagePixels } from './page-pixels.mjs'

export class OverlayRenderer {
  /**
   * @param {{ wrapper: any, getAccess: () => string, fetchJSON: (url: string) => Promise<any>, currentUser: string | undefined, userColor: (id: string) => string, onError?: (error: unknown) => void, onPageSizes?: (sizes: Map<number, {width: number, height: number}>) => void }} options
   */
  constructor({
    wrapper,
    getAccess,
    fetchJSON,
    currentUser,
    userColor,
    onError = () => {},
    onPageSizes = () => {},
  }) {
    Object.assign(this, { wrapper, currentUser, userColor, onError })
    this.onPageSizes = onPageSizes
    this.model = new OverlayModel()
    this.pixels = new PagePixels(wrapper, () => this.repaint())
    this.cache = new GlyphCache({ getAccess, fetchJSON })
    this.canvases = new Map()
    this.requests = new Map()
    this.generation = 0
    this.onDestroy = () => {
      // pagesdestroy is synchronous, immediately before pdf.js clears the old
      // document. React's layout effect runs earlier and can race old renders.
      this.pixels.capture()
      this.document = undefined
      this.ready = false
      this.clearCanvases()
    }
    this.onPages = () => {
      this.document = wrapper.viewer.pdfDocument
      this.ready = true
      this.reportPageSizes()
      this.pixels.reposition()
      this.repaint()
    }
    this.onRender = event => {
      if (!this.document || this.document !== wrapper.viewer.pdfDocument) return
      if (event) {
        const page = wrapper.viewer.getPageView(event.pageNumber - 1)
        if (
          event.source !== page ||
          event.cssTransform ||
          event.isDetailView ||
          event.error
        )
          return
        this.pixels.rendered(event.pageNumber)
      }
      this.reportPageSizes()
      this.repaint()
    }
    this.onScale = () => this.pixels.reposition()
    wrapper.eventBus.on('pagesdestroy', this.onDestroy)
    wrapper.eventBus.on('pagesinit', this.onPages)
    wrapper.eventBus.on('pagerendered', this.onRender)
    wrapper.eventBus.on('scalechanging', this.onScale)
  }

  reportPageSizes() {
    const { viewer } = this.wrapper
    const sizes = new Map()
    for (let index = 0; index < viewer.pagesCount; index++) {
      const page = viewer.getPageView(index)
      if (!page?.pdfPage || !page.viewport) continue
      const [left, bottom, right, top] = page.viewport.viewBox
      sizes.set(index + 1, {
        width: (right - left) / SP_TO_BP,
        height: (top - bottom) / SP_TO_BP,
      })
    }
    this.onPageSizes(sizes)
  }

  layout(header) {
    this.generation++
    this.ready = false
    this.requests.clear()
    this.model.layout(header)
  }

  async paragraph(frame) {
    const { header, body } = frame
    if (this.requests.get(header.par_id) === frame) return
    this.requests.set(header.par_id, frame)
    const generation = this.generation
    try {
      const list = body.length ? decodeDisplayList(body) : undefined
      if (list && !list.degraded && header.status === 'ok') {
        const requests = glyphRequests(list, header.fonts)
        await Promise.all(
          [...requests].map(([key, ids]) => this.cache.load(key, [...ids]))
        )
      }
      if (
        generation !== this.generation ||
        this.requests.get(header.par_id) !== frame
      )
        return
      if (this.model.paragraph(header, list)) {
        const unit = this.model.units.get(header.par_id)
        if (unit) unit.fonts = header.fonts
        this.repaint()
        clearTimeout(this.flashTimer)
        this.flashTimer = setTimeout(() => this.repaint(), 1100)
      }
    } catch (error) {
      if (this.requests.get(header.par_id) === frame)
        this.requests.delete(header.par_id)
      this.onError(error)
    }
  }

  clearCanvases() {
    for (const canvas of this.canvases.values()) canvas.remove()
    this.canvases.clear()
  }

  repaint() {
    if (!this.ready) return
    // Composite all masks first, then all units. One unit's erase cannot wipe
    // a neighbouring live drawing. Rebuild transparently to restore base pixels
    // when a unit becomes degraded, and after pdf.js resets or zooms a page.
    const pages = new Set([...this.canvases.keys(), ...this.model.pages()])
    for (const page of pages) {
      if (this.pixels.pages.has(page)) continue
      const pageView = this.wrapper.viewer.getPageView(page - 1)
      if (!pageView?.viewport || !pageView.div) continue
      const { div, viewport } = pageView
      let canvas = this.canvases.get(page)
      if (!canvas) {
        canvas = document.createElement('canvas')
        canvas.dataset.livePreviewOverlay = String(page)
        canvas.setAttribute('aria-hidden', 'true')
        Object.assign(canvas.style, {
          position: 'absolute',
          left: '0',
          top: '0',
          pointerEvents: 'none',
          zIndex: '2',
        })
        this.canvases.set(page, canvas)
      }
      // viewport dimensions already include pdf.js's --scale-factor and rotation.
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.ceil(viewport.width * dpr)
      canvas.height = Math.ceil(viewport.height * dpr)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      div.append(canvas)
      const context = canvas.getContext('2d')
      if (!context) continue
      const base = pageTransform(viewport, dpr)
      const background = window.getComputedStyle(div).backgroundColor
      context.setTransform(...base)
      context.fillStyle =
        background && background !== 'rgba(0, 0, 0, 0)' ? background : '#fff'
      for (const unit of this.model.units.values()) {
        for (const rect of unit.erase) {
          if (rect.page !== page) continue
          const padded = paddedRect(rect)
          context.fillRect(padded.x, padded.y, padded.w, padded.h)
        }
      }
      for (const unit of this.model.units.values()) {
        if (!unit.list || !unit.rows.length) continue
        const anchor = unit.rows.find(row => row.page === page)
        if (!anchor) continue
        const painter = new Painter(context, base, this.cache, unit.fonts)
        painter.draw(unit.list, unit.list.other, anchor.dx, anchor.dy)
        // Replay colour operations from all rows, including rows on other pages.
        for (const row of unit.rows) {
          if (row.page === page)
            painter.draw(unit.list, row.line.items, row.dx, row.dy)
          else
            painter.draw(
              unit.list,
              row.line.items.filter(item => item[0] === 'c')
            )
        }
        if (
          unit.userId &&
          unit.userId !== this.currentUser &&
          Date.now() - unit.changedAt < 1000
        ) {
          context.setTransform(...base)
          context.strokeStyle = this.userColor(unit.userId)
          context.lineWidth = 1.5 / Math.hypot(base[0], base[1])
          for (const row of unit.rows) {
            if (row.page !== page) continue
            const { line, dx, dy } = row
            context.strokeRect(
              line.x + dx,
              line.y + dy - line.h,
              line.w,
              line.h + line.d
            )
          }
        }
      }
    }
  }

  dispose() {
    this.generation++
    clearTimeout(this.flashTimer)
    this.wrapper.eventBus.off('pagesdestroy', this.onDestroy)
    this.wrapper.eventBus.off('pagesinit', this.onPages)
    this.wrapper.eventBus.off('pagerendered', this.onRender)
    this.wrapper.eventBus.off('scalechanging', this.onScale)
    this.clearCanvases()
    this.pixels.clear()
  }
}
