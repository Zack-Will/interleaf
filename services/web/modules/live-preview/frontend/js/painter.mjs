import { glyphTransform, multiply } from './geometry.mjs'

export function pdfColor(data) {
  const tokens = data.trim().split(/\s+/)
  let color
  let stroke
  for (let index = 0; index < tokens.length; index++) {
    const op = tokens[index]
    let rgb
    if ((op === 'g' || op === 'G') && index >= 1) {
      rgb = Array(3).fill(Number(tokens[index - 1]))
    } else if ((op === 'rg' || op === 'RG') && index >= 3) {
      rgb = tokens.slice(index - 3, index).map(Number)
    } else if ((op === 'k' || op === 'K') && index >= 4) {
      const [c, m, y, k] = tokens.slice(index - 4, index).map(Number)
      rgb = [c, m, y].map(value => (1 - value) * (1 - k))
    }
    if (!rgb || !rgb.every(Number.isFinite)) continue
    const css = `rgb(${rgb.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255)).join(',')})`
    if (op === op.toLowerCase()) color = css
    else stroke = css
  }
  return color ?? stroke
}

export class Painter {
  constructor(context, base, cache, fonts) {
    Object.assign(this, { context, base, cache, fonts })
    this.stacks = new Map()
    this.color = 'rgb(0,0,0)'
  }

  colorOp(stack, command, data) {
    const colors = this.stacks.get(stack) || ['rgb(0,0,0)']
    const color = pdfColor(data)
    if (command === 0 && color) colors[colors.length - 1] = color
    if (command === 1) colors.push(color || colors[colors.length - 1])
    if (command === 2 && colors.length > 1) colors.pop()
    this.stacks.set(stack, colors)
    this.color = colors[colors.length - 1]
  }

  draw(list, items, dx = 0, dy = 0) {
    const context = this.context
    for (const item of items) {
      if (item[0] === 'c') {
        this.colorOp(item[1], item[2], item[3])
      } else if (item[0] === 'g') {
        const mapping = this.fonts[item[1]]
        const id = mapping.ids === 'char_code' ? item[2] : item[3]
        const glyph = this.cache.get(mapping.font_key, id)
        if (!glyph) throw new Error('Glyph was not prepared')
        const transform = multiply(
          this.base,
          glyphTransform(list.fonts[item[1]], item, glyph.unitsPerEm, dx, dy)
        )
        context.setTransform(...transform)
        context.fillStyle = this.color
        context.fill(glyph.path)
      } else if (item[0] === 'r') {
        context.setTransform(...this.base)
        context.fillStyle = this.color
        context.fillRect(item[1] + dx, item[2] + dy, item[3], item[4])
      }
    }
  }
}
