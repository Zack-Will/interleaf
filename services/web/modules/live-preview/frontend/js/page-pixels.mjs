// The viewer exposure lets the module preserve visible pixels without changing
// pdf.js's loadDocument or its native scale/scroll restoration.
export class PagePixels {
  constructor(wrapper, onExpire = () => {}) {
    this.wrapper = wrapper
    this.pages = new Map()
    this.onExpire = onExpire
  }

  capture() {
    const { viewer } = this.wrapper
    const container = this.wrapper.container || viewer.container
    if (!container) return
    const bounds = container.getBoundingClientRect()
    for (let index = 0; index < viewer.pagesCount; index++) {
      const page = viewer.getPageView(index)
      if (!page?.div) continue
      const rect = page.div.getBoundingClientRect()
      if (
        rect.bottom < bounds.top ||
        rect.top > bounds.bottom ||
        rect.right < bounds.left ||
        rect.left > bounds.right
      )
        continue
      if (this.pages.has(index + 1)) continue
      const base = page.div.querySelector('.canvasWrapper canvas')
      if (!base?.width || !base.height) continue
      const canvas = document.createElement('canvas')
      canvas.width = base.width
      canvas.height = base.height
      const context = canvas.getContext('2d')
      if (!context) continue
      context.drawImage(base, 0, 0, canvas.width, canvas.height)
      const overlay = page.div.querySelector('[data-live-preview-overlay]')
      if (overlay) context.drawImage(overlay, 0, 0, canvas.width, canvas.height)
      canvas.dataset.livePreviewPixels = String(index + 1)
      canvas.setAttribute('aria-hidden', 'true')
      const canvasRect = base.getBoundingClientRect()
      Object.assign(canvas.style, {
        position: 'absolute',
        pointerEvents: 'none',
        zIndex: '3',
        filter: window.getComputedStyle(page.div).filter,
        left: `${canvasRect.left - bounds.left - container.clientLeft + container.scrollLeft}px`,
        top: `${canvasRect.top - bounds.top - container.clientTop + container.scrollTop}px`,
        width: `${canvasRect.width}px`,
        height: `${canvasRect.height}px`,
      })
      container.append(canvas)
      this.pages.set(index + 1, canvas)
    }
    clearTimeout(this.timer)
    if (this.pages.size) {
      this.timer = setTimeout(() => {
        this.clear()
        this.onExpire()
      }, 10000)
    }
  }

  reposition() {
    const container = this.wrapper.container || this.wrapper.viewer.container
    if (!container) return
    const bounds = container.getBoundingClientRect()
    for (const [number, canvas] of this.pages) {
      const page = this.wrapper.viewer.getPageView(number - 1)
      if (!page) {
        this.rendered(number)
        continue
      }
      const rect = page.div.getBoundingClientRect()
      Object.assign(canvas.style, {
        left: `${rect.left + page.div.clientLeft - bounds.left - container.clientLeft + container.scrollLeft}px`,
        top: `${rect.top + page.div.clientTop - bounds.top - container.clientTop + container.scrollTop}px`,
        width: `${page.viewport.width}px`,
        height: `${page.viewport.height}px`,
      })
      // Keep the copy outside .pdfViewer: both document and scale resets remove
      // page children, including copies attached during pagesinit.
    }
  }

  rendered(number) {
    this.pages.get(number)?.remove()
    this.pages.delete(number)
    if (!this.pages.size) clearTimeout(this.timer)
  }

  clear() {
    clearTimeout(this.timer)
    for (const number of this.pages.keys()) this.rendered(number)
  }
}
