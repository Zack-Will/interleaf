import { accessUrl } from './protocol.mjs'

export class GlyphCache {
  constructor({
    getAccess,
    fetchJSON,
    makePath = data => new window.Path2D(data),
  }) {
    Object.assign(this, { getAccess, fetchJSON, makePath })
    this.glyphs = new Map()
    this.pending = new Map()
  }

  get(key, id) {
    return this.glyphs.get(`${key}:${id}`)
  }

  async load(key, ids) {
    const missing = [...new Set(ids)].filter(id => !this.get(key, id))
    if (!missing.length) return
    // Join requests for the same font; retry failed fetches with fresh credentials.
    const pending = this.pending.get(key)
    if (pending) {
      await pending
      return this.load(key, ids)
    }
    const request = this.fetchMissing(key, missing)
    this.pending.set(key, request)
    try {
      await request
    } finally {
      this.pending.delete(key)
    }
  }

  async fetchMissing(key, ids) {
    for (let start = 0; start < ids.length; start += 256) {
      const batch = ids.slice(start, start + 256)
      const url = accessUrl(
        `/live-preview/glyphs/${encodeURIComponent(key)}?ids=${batch.join(',')}`,
        this.getAccess()
      )
      const data = await this.fetchJSON(url)
      if (!(data.unitsPerEm > 0)) throw new Error('Invalid glyph metrics')
      for (const id of batch) {
        const glyph = data.glyphs[id]
        if (!glyph || typeof glyph.path !== 'string')
          throw new Error('Missing glyph outline')
        this.glyphs.set(`${key}:${id}`, {
          path: this.makePath(glyph.path),
          unitsPerEm: data.unitsPerEm,
        })
      }
    }
  }
}

export function glyphRequests(list, fonts) {
  const requests = new Map()
  for (const item of [
    ...list.other,
    ...list.lines.flatMap(line => line.items),
  ]) {
    if (item[0] !== 'g') continue
    const font = fonts[item[1]]
    if (!font || !list.fonts[item[1]]) throw new Error('Missing font mapping')
    const id = font.ids === 'char_code' ? item[2] : item[3]
    if (id == null) throw new Error('Missing glyph index')
    if (!requests.has(font.font_key)) requests.set(font.font_key, new Set())
    requests.get(font.font_key).add(id)
  }
  return requests
}
