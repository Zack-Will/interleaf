export function missingGlyphDiagnostics(log, docs) {
  const fonts = new Map()
  const pattern =
    /Missing character: There is no .*?\(U\+([0-9A-Fa-f]+)\) in font ([\s\S]*?)!/g
  for (const match of log.matchAll(pattern)) {
    const code = Number.parseInt(match[1], 16)
    if (code > 0x10ffff) continue
    const font = match[2].replace(/\r?\n\s*/g, '').trim()
    if (!fonts.has(font)) fonts.set(font, new Set())
    fonts.get(font).add(String.fromCodePoint(code))
  }
  return [...fonts].map(([font, characters]) => {
    const locations = []
    for (const doc of docs.values()) {
      let offset = 0
      for (const [index, text] of doc.content.split('\n').entries()) {
        if ([...characters].some(character => text.includes(character))) {
          locations.push({
            doc_id: doc.id,
            file: doc.path,
            line: index + 1,
            range: { start: offset, end: offset + text.length },
          })
        }
        offset += text.length + 1
      }
    }
    const text = [...characters].slice(0, 32).join('')
    const suffix = characters.size > 32 ? '…' : ''
    return {
      severity: 'warning',
      code: 'missing_font_glyphs',
      message: `Font ${font} has no glyphs for: ${text}${suffix}; the preamble may need a package such as ctex or fontspec with a font that covers them`,
      file: locations[0]?.file,
      line: locations[0]?.line,
      locations,
    }
  })
}
