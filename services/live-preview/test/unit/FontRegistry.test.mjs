import { describe, it, expect } from 'vitest'
import sinon from 'sinon'
import { FontRegistry, displayListFonts } from '../../app/src/FontRegistry.mjs'
import {
  charStringToGlyph,
  parseEncFile,
  parseMapFile,
} from '../../app/src/Type1.mjs'

export function fontList(filename = '/fonts/test.otf', size = 655360) {
  const fixed = Buffer.alloc(28)
  fixed.writeUInt32LE(1)
  fixed.writeInt32LE(size, 4)
  fixed[8] = 1
  const fields = [filename, 'Test', 'test', 'Test Font', 'opentype'].map(
    text => {
      const bytes = Buffer.from(text)
      const prefix = Buffer.alloc(2)
      prefix.writeUInt16LE(bytes.length)
      return Buffer.concat([prefix, bytes])
    }
  )
  const record = Buffer.concat([fixed, ...fields])
  const prefix = Buffer.alloc(5)
  prefix[0] = 2
  prefix.writeUInt32LE(record.length, 1)
  const header = Buffer.alloc(16)
  header.write('RTDL')
  header.writeUInt16LE(1, 4)
  header.writeUInt32LE(16 + 5 + record.length, 8)
  return Buffer.concat([header, prefix, record])
}

describe('fonts', () => {
  it('extracts descriptions and derives size-independent keys bound to projects', async () => {
    const parsed = {
      unitsPerEm: 1000,
      numGlyphs: 100,
      getGlyph: sinon
        .stub()
        .returns({ path: { toSVG: () => 'M0 0L10 10Z' }, advanceWidth: 600 }),
    }
    const fonts = new FontRegistry({
      settings: { fontRoots: ['/fonts'], baseDir: '/data' },
      filesystem: {
        realpath: async file => file,
        readFile: async () => Buffer.alloc(0),
      },
      parseFont: async () => parsed,
      locateFont: async file => `/fonts/${file}`,
    })
    const first = fonts.registerDisplayList('project', fontList())
    const second = fonts.registerDisplayList(
      'project',
      fontList(undefined, 900000)
    )
    expect(first[1].font_key).toBe(second[1].font_key)
    expect(displayListFonts(fontList())[0].filename).toBe('/fonts/test.otf')
    const glyphs = await fonts.glyphs('project', first[1].font_key, [1, 2])
    expect(glyphs.unitsPerEm).toBe(1000)
    expect(glyphs.glyphs[1]).toEqual({ path: 'M0 0L10 10Z', advance: 600 })
    await fonts.glyphs('project', first[1].font_key, [1])
    expect(parsed.getGlyph.callCount).toBe(2)
    await expect(
      fonts.glyphs('other', first[1].font_key, [1])
    ).rejects.toMatchObject({ code: 'font_not_found' })
    await expect(
      fonts.glyphs('project', first[1].font_key, [NaN])
    ).rejects.toThrow('glyph ids')
    fonts.releaseProject('project')
    expect(fonts.entries.size).toBe(0)
  })
  it('rejects unregistered files and invalid display lists', async () => {
    const fonts = new FontRegistry({
      settings: { fontRoots: ['/fonts'], baseDir: '/data' },
      filesystem: { realpath: async file => file },
    })
    await expect(fonts.trustedFile('/etc/passwd')).rejects.toThrow('outside')
    expect(() => displayListFonts(Buffer.from('bad'))).toThrow('display list')
    const bytes = fontList()
    bytes.writeUInt16LE(2, 4)
    expect(() => displayListFonts(bytes)).toThrow('display list')
  })
  it('decodes Type 1 charstrings, advances, map and encoding files', () => {
    // hsbw(0,500), rmoveto(0,0), rlineto(100,0), endchar.
    const font = {
      charStrings: new Map([
        [
          'A',
          Uint8Array.from([139, 248, 136, 13, 139, 139, 21, 239, 139, 5, 14]),
        ],
      ]),
      subrs: [],
    }
    expect(charStringToGlyph(font, 'A')).toEqual({
      path: 'M0 0 L100 0 Z',
      advance: 500,
    })
    expect(parseEncFile('/Encoding [ /A /B ] def')).toEqual(['A', 'B'])
    expect(parseMapFile('cmr10 CMR10 <cmr10.pfb').get('cmr10').fontFile).toBe(
      'cmr10.pfb'
    )
  })
})
