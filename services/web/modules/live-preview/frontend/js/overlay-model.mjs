import { placedRows, rowRect } from './geometry.mjs'

export class OverlayModel {
  constructor() {
    this.units = new Map()
    this.baseRects = new Map()
  }

  layout(header) {
    this.units.clear()
    this.baseRects = new Map(
      (header.placements || []).map(unit => [unit.par_id, unit.row_rects || []])
    )
  }

  paragraph(header, list, now = Date.now()) {
    const id = header.par_id
    if (header.status === 'error') return false
    if (list?.degraded || header.status === 'ok_degraded') {
      this.units.delete(id)
      return true
    }
    if (header.status !== 'removed' && (header.status !== 'ok' || !list))
      return false
    const previous = this.units.get(id)
    const rows =
      header.status === 'removed' ? [] : placedRows(list, header.fragments)
    const rectangles = [
      ...(this.baseRects.get(id) || []),
      ...(previous?.erase || []),
      ...rows.map(rowRect),
    ]
    const erase = [
      ...new Map(rectangles.map(rect => [JSON.stringify(rect), rect])).values(),
    ]
    // No layout geometry: wait for the next pass instead of drawing duplicate text.
    if (
      !this.baseRects.has(id) ||
      (!this.baseRects.get(id).length && rows.length)
    )
      return false
    this.units.set(id, {
      list,
      rows,
      erase,
      userId: header.user_id,
      changedAt: now,
    })
    return true
  }

  pages() {
    const pages = new Set()
    for (const unit of this.units.values()) {
      for (const rect of unit.erase) pages.add(rect.page)
      for (const row of unit.rows) pages.add(row.page)
    }
    return pages
  }
}
