// RTDL revision 1. Pure browser-compatible codec shared with the web overlay.
const decoder = new TextDecoder('utf-8', { fatal: true })

export function decodeDisplayList(input, { geometryOnly = false } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    bytes.length < 16 ||
    decoder.decode(bytes.subarray(0, 4)) !== 'RTDL' ||
    view.getUint16(4, true) !== 1 ||
    view.getUint32(8, true) !== bytes.length
  ) {
    throw new Error('Unsupported RTDL header')
  }
  const list = { fonts: {}, lines: [], other: [], degraded: false }
  let items = list.other
  let line
  let ended = false
  for (let offset = 16; offset < bytes.length; ) {
    if (offset + 5 > bytes.length) throw new Error('Truncated RTDL record')
    const tag = bytes[offset]
    const end = offset + 5 + view.getUint32(offset + 1, true)
    if (end > bytes.length) throw new Error('Truncated RTDL payload')
    if (geometryOnly && ![0x10, 0x12, 0x11, 0xff].includes(tag)) {
      offset = end
      continue
    }
    let cursor = offset + 5
    function number(method, size) {
      if (cursor + size > end) throw new Error('Truncated RTDL field')
      const value = view[method](cursor, true)
      cursor += size
      return value
    }
    const i32 = () => number('getInt32', 4)
    const u32 = () => number('getUint32', 4)
    const u16 = () => number('getUint16', 2)
    const u8 = () => number('getUint8', 1)
    function string() {
      const length = u16()
      if (cursor + length > end) throw new Error('Truncated RTDL string')
      const value = decoder.decode(bytes.subarray(cursor, cursor + length))
      cursor += length
      return value
    }
    switch (tag) {
      case 1:
        for (const key of [
          'width',
          'height',
          'depth',
          'page',
          'page_width',
          'page_height',
          'origin_x',
          'origin_y',
        ]) {
          list[key] = i32()
        }
        list.glyph_count = u32()
        list.image_count = u32()
        break
      case 2: {
        const id = u32()
        const font = { size: i32(), kind: u8() }
        u8()
        font.subfont = u16()
        for (const key of ['slant', 'extend', 'squeeze', 'designsize'])
          font[key] = i32()
        for (const key of ['filename', 'psname', 'name', 'fullname', 'format'])
          font[key] = string()
        list.fonts[id] = font
        break
      }
      case 4: {
        const id = u32()
        const metadata = JSON.parse(string())
        Object.assign(list.fonts[id] || {}, metadata)
        break
      }
      case 0x10:
        line = {
          par: i32(),
          i: i32(),
          x: i32(),
          y: i32(),
          w: i32(),
          h: i32(),
          d: i32(),
          items: [],
        }
        number('getFloat64', 8)
        u8()
        u8()
        list.lines.push(line)
        items = line.items
        break
      case 0x12:
        if (!line) throw new Error('RTDL unit without a row')
        line.unit = i32()
        line.row = i32()
        break
      case 0x11:
        line = undefined
        items = list.other
        break
      case 0x20: {
        const font = u32()
        const y = i32()
        const expansion = i32()
        const count = u32()
        if (count > (end - cursor) / 16) throw new Error('Truncated glyph run')
        for (let index = 0; index < count; index++) {
          const char = u32()
          const glyph = u32()
          items.push([
            'g',
            font,
            char,
            glyph === 0xffffffff ? null : glyph,
            i32(),
            y,
            i32(),
            expansion,
          ])
        }
        break
      }
      case 0x21:
        items.push(['r', i32(), i32(), i32(), i32()])
        break
      case 0x22: {
        const command = u8()
        u8()
        items.push(['c', u16(), command, string()])
        break
      }
      case 0x25:
        items.push(['m', u8(), i32()])
        break
      case 0x28:
        items.push(['M', u8(), i32(), i32(), string()])
        // Transformed content needs a pass PDF until the overlay supports it.
        list.degraded = true
        break
      case 3:
      case 0x23:
      case 0x24:
      case 0x26:
        list.degraded = true
        break
      case 0xff:
        ended = true
        if (end !== bytes.length) throw new Error('Data after RTDL END')
        break
      default:
        // Skip extensions by length; unknown drawing records require the PDF.
        if (tag !== 0x27) list.degraded = true
    }
    offset = end
  }
  if (!ended) throw new Error('Missing RTDL END')
  return list
}

// Placements carry baselines, but no widths/heights. Match capture units by
// their placed rows, then include every row of those units (including displays).
export function layoutRowRects(placements, pages) {
  return placements.map(placement => {
    const rows = []
    for (const fragment of placement.fragments) {
      const lines = pages.get(fragment.page)?.lines || []
      const matched = new Set()
      const units = new Set()
      for (let index = 0; index < fragment.baselines.length; index++) {
        const x = fragment.xs[index] ?? fragment.x
        const y = fragment.baselines[index]
        for (const row of lines) {
          if (Math.abs(row.x - x) <= 64 && Math.abs(row.y - y) <= 64) {
            matched.add(row)
            if (row.unit) units.add(row.unit)
          }
        }
      }
      for (const row of lines) {
        if (matched.has(row) || (row.unit && units.has(row.unit))) {
          rows.push({
            page: fragment.page,
            x: row.x,
            y: row.y - row.h,
            w: row.w,
            h: row.h + row.d,
          })
        }
      }
    }
    return { ...placement, row_rects: rows }
  })
}
