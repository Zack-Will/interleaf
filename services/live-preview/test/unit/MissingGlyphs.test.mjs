import fs from 'node:fs/promises'
import { describe, it, expect } from 'vitest'
import { missingGlyphDiagnostics } from '../../app/src/MissingGlyphs.mjs'

describe('missing font glyphs', () => {
  it('deduplicates wrapped LuaTeX warnings per font and annotates current UTF-16 source lines', async () => {
    const log = await fs.readFile(
      new URL('../fixtures/missing-glyphs.log', import.meta.url),
      'utf8'
    )
    const items = missingGlyphDiagnostics(
      log,
      new Map([
        ['doc', { id: 'doc', path: 'main.tex', content: 'A😀中\n文中\nplain' }],
        ['other', { id: 'other', path: 'chapter.tex', content: '文' }],
      ])
    )
    expect(items).toHaveLength(1)
    expect(items[0].message).toContain(
      'Font [lmroman10-regular]:+tlig; has no glyphs for: 中文'
    )
    expect(items[0].message).toContain('ctex or fontspec')
    expect(items[0].locations).toEqual([
      { doc_id: 'doc', file: 'main.tex', line: 1, range: { start: 0, end: 4 } },
      { doc_id: 'doc', file: 'main.tex', line: 2, range: { start: 5, end: 7 } },
      {
        doc_id: 'other',
        file: 'chapter.tex',
        line: 1,
        range: { start: 0, end: 1 },
      },
    ])
    expect(missingGlyphDiagnostics('clean log', new Map())).toEqual([])
  })
})
