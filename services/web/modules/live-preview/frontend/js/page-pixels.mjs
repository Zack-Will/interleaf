// The viewer exposure lets the module preserve visible pixels without changing
// pdf.js's loadDocument or its native scale/scroll restoration.
export class PagePixels {
  constructor(wrapper) {
    this.wrapper = wrapper
    this.pages = new Map()
  }

  capture() {
    const { viewer } = this.wrapper
    const container = this.wrapper.container || viewer.container
    if (!container) return
    const bounds = container.getBoundingClientRect()
    for (let index = 0; index < viewer.pagesCount; index++) {
      const page = viewer.getPageView(index)
      const rect = page.div.getBoundingClientRect()
      if (rect.bottom < bounds.top || rect.top > bounds.bottom) continue
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
      Object.assign(canvas.style, {
        position: 'absolute',
        pointerEvents: 'none',
        zIndex: '3',
        left: `${page.div.offsetLeft}px`,
        top: `${page.div.offsetTop}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      })
      container.append(canvas)
      this.pages.set(index + 1, canvas)
    }
  }

  attach() {
    for (const [number, canvas] of this.pages) {
      const page = this.wrapper.viewer.getPageView(number - 1)
      if (!page) {
        this.rendered(number)
        continue
      }
      Object.assign(canvas.style, {
        left: '0',
        top: '0',
        width: '100%',
        height: '100%',
      })
      page.div.append(canvas)
    }
  }

  rendered(number) {
    this.pages.get(number)?.remove()
    this.pages.delete(number)
  }

  clear() {
    for (const number of this.pages.keys()) this.rendered(number)
  }
}
