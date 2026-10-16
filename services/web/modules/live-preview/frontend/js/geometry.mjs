export const SP_TO_BP = 72 / 72.27 / 65536

export function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

export function pageTransform(viewport, dpr) {
  const [left, , , top] = viewport.viewBox
  const pdf = [SP_TO_BP, 0, 0, -SP_TO_BP, left, top]
  return multiply([dpr, 0, 0, dpr, 0, 0], multiply(viewport.transform, pdf))
}

export function glyphTransform(font, glyph, unitsPerEm, dx, dy) {
  const size = font.size / unitsPerEm
  const expansion = 1 + glyph[7] / 1000000
  const extend = font.extend ? font.extend / 1000 : 1
  return [
    size * expansion * extend,
    0,
    (size * (font.slant || 0)) / 1000,
    -size,
    glyph[4] + dx,
    glyph[5] + dy,
  ]
}

export function placedRows(list, fragments) {
  const rows = []
  for (const fragment of fragments || []) {
    for (
      let index = fragment.first_line;
      index <= fragment.last_line;
      index++
    ) {
      const line = list.lines[index - 1]
      const offset = index - fragment.first_line
      if (!line || !Number.isFinite(fragment.baselines[offset])) continue
      rows.push({
        page: fragment.page,
        line,
        dx: (fragment.xs[offset] ?? fragment.x) - line.x,
        dy: fragment.baselines[offset] - line.y,
      })
    }
  }
  return rows
}

function fragmentPositions(fragments) {
  const positions = new Map()
  for (const fragment of fragments || []) {
    for (let line = fragment.first_line; line <= fragment.last_line; line++) {
      const offset = line - fragment.first_line
      positions.set(line, {
        page: fragment.page,
        x: fragment.xs[offset] ?? fragment.x,
        baseline: fragment.baselines[offset],
      })
    }
  }
  return positions
}

export function reanchorFragments(live, placements) {
  const old = fragmentPositions(live)
  const next = fragmentPositions(placements)
  const anchors = [...next.keys()].filter(line => old.has(line))
  if (!anchors.length) return live?.length ? live : placements
  const extra = []
  for (const [line, position] of old) {
    if (next.has(line)) continue
    const anchor = anchors.reduce((nearest, candidate) =>
      Math.abs(candidate - line) < Math.abs(nearest - line)
        ? candidate
        : nearest
    )
    const before = old.get(anchor)
    const after = next.get(anchor)
    extra.push({
      page: position.page + after.page - before.page,
      first_line: line,
      last_line: line,
      xs: [position.x + after.x - before.x],
      baselines: [position.baseline + after.baseline - before.baseline],
      approximate: true,
    })
  }
  return extra.length ? [...placements, ...extra] : placements
}

export function rowRect({ page, line, dx, dy }) {
  return {
    page,
    x: line.x + dx,
    y: line.y + dy - line.h,
    w: line.w,
    h: line.h + line.d,
  }
}

export function paddedRect(rect) {
  const padding = 65536
  return {
    ...rect,
    x: rect.x - padding,
    y: rect.y - padding,
    w: rect.w + 2 * padding,
    h: rect.h + 2 * padding,
  }
}
