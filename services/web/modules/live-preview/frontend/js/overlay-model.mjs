import { placedRows, reanchorFragments, rowRect } from './geometry.mjs'
import { newerThanLayout } from '@overleaf/live-preview-protocol/Layout.mjs'

export function anchorParagraph(frame, layout) {
  const placement = layout.placements?.find(
    unit => unit.par_id === frame.header.par_id
  )
  if (!placement?.fragments) return frame
  return {
    ...frame,
    header: {
      ...frame.header,
      fragments: reanchorFragments(frame.header.fragments, placement.fragments),
    },
  }
}

export function retainParagraphs(paragraphs, layout) {
  return new Map(
    [...paragraphs]
      .filter(([, frame]) => newerThanLayout(frame.header, layout))
      .map(([id, frame]) => [id, anchorParagraph(frame, layout)])
  )
}

export class OverlayModel {
  constructor() {
    this.units = new Map()
    this.baseRects = new Map()
  }

  layout(header) {
    this.baseRects = new Map(
      (header.placements || []).map(unit => [unit.par_id, unit.row_rects || []])
    )
    const previous = this.units
    this.units = new Map()
    for (const [id, unit] of previous) {
      if (!newerThanLayout(unit.header, header)) continue
      const placement = header.placements?.find(unit => unit.par_id === id)
      if (!placement) {
        this.units.set(id, unit)
        continue
      }
      const next = anchorParagraph({ header: unit.header }, header).header
      if (this.paragraph(next, unit.list, unit.changedAt)) {
        Object.assign(this.units.get(id), { fonts: unit.fonts })
      }
    }
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
      header,
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
