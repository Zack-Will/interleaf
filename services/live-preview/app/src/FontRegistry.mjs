import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  parseMapFile,
  parseEncFile,
  parseType1,
  charStringToGlyph,
} from './Type1.mjs'
import { PreviewError } from './Errors.mjs'

function readString(bytes, offset) {
  const length = bytes.readUInt16LE(offset)
  return {
    value: bytes.subarray(offset + 2, offset + 2 + length).toString(),
    end: offset + 2 + length,
  }
}

export function displayListFonts(bytes) {
  if (!bytes.length) {
    return []
  }
  if (
    bytes.length < 16 ||
    bytes.toString('ascii', 0, 4) !== 'RTDL' ||
    bytes.readUInt16LE(4) !== 1 ||
    bytes.readUInt32LE(8) !== bytes.length
  ) {
    throw new PreviewError('invalid_display_list', 'Unsupported display list')
  }
  const fonts = []
  for (let offset = 16; offset < bytes.length; ) {
    const tag = bytes[offset]
    const length = bytes.readUInt32LE(offset + 1)
    const end = offset + 5 + length
    if (end > bytes.length) {
      throw new PreviewError('invalid_display_list', 'Truncated display list')
    }
    if (tag === 2) {
      const data = bytes.subarray(offset + 5, end)
      const font = {
        id: data.readUInt32LE(0),
        kind: data[8],
        subfont: data.readUInt16LE(10),
      }
      let position = 28
      for (const key of ['filename', 'psname', 'name', 'fullname', 'format']) {
        const result = readString(data, position)
        font[key] = result.value
        position = result.end
      }
      fonts.push(font)
    }
    offset = end
  }
  return fonts
}

export class FontRegistry {
  constructor({ settings, parseFont, locateFont, filesystem = fs }) {
    Object.assign(this, { settings, parseFont, locateFont })
    this.fs = filesystem
    this.entries = new Map()
  }

  registerDisplayList(projectId, bytes) {
    const mapping = {}
    for (const font of displayListFonts(bytes)) {
      const identity = JSON.stringify([
        font.filename || font.name,
        font.subfont,
        font.kind,
      ])
      const fontKey = createHash('sha256').update(identity).digest('hex')
      let entry = this.entries.get(fontKey)
      if (!entry) {
        entry = { font, projects: new Set(), glyphs: new Map() }
        this.entries.set(fontKey, entry)
      }
      entry.projects.add(projectId)
      mapping[font.id] = {
        font_key: fontKey,
        ids: font.kind === 3 || !font.filename ? 'char_code' : 'glyph_index',
      }
    }
    return mapping
  }

  releaseProject(projectId) {
    for (const [key, entry] of this.entries) {
      entry.projects.delete(projectId)
      if (!entry.projects.size) {
        this.entries.delete(key)
      }
    }
  }

  async trustedFile(filename) {
    const resolved = await this.fs.realpath(filename)
    const roots = [...this.settings.fontRoots, this.settings.baseDir]
    if (
      !roots.some(root =>
        resolved.startsWith(`${path.resolve(root)}${path.sep}`)
      ) ||
      !/\.(otf|ttf|ttc|pfb|pfa|enc|map)$/i.test(resolved)
    ) {
      throw new PreviewError(
        'font_unavailable',
        'Font is outside configured font roots',
        404
      )
    }
    return resolved
  }

  async locate(filename) {
    const file = path.isAbsolute(filename)
      ? filename
      : await this.locateFont(filename)
    return this.trustedFile(file)
  }

  async load(font) {
    let filename = font.filename
    let encoding
    if (!filename || /\.tfm$/i.test(filename)) {
      const mapFile = await this.locate('pdftex.map')
      const entries = parseMapFile(await this.fs.readFile(mapFile, 'utf8'))
      const entry = entries.get(font.name || path.basename(filename, '.tfm'))
      if (!entry?.fontFile) {
        throw new PreviewError('font_unavailable', 'No Type 1 map entry', 404)
      }
      filename = entry.fontFile
      if (entry.encFile) {
        encoding = parseEncFile(
          await this.fs.readFile(await this.locate(entry.encFile), 'utf8')
        )
      }
    }
    const file = await this.locate(filename)
    const bytes = await this.fs.readFile(file)
    if (/\.(pfb|pfa)$/i.test(file)) {
      const type1 = parseType1(bytes)
      return {
        type1,
        encoding: encoding || type1.encoding,
        unitsPerEm: Math.round(1 / type1.fontMatrix[0]),
      }
    }
    let parsed = await this.parseFont(bytes)
    if (parsed.fonts) {
      parsed = parsed.fonts[font.subfont || 0]
    }
    return { parsed, unitsPerEm: parsed.unitsPerEm }
  }

  async glyphs(projectId, key, ids) {
    const entry = this.entries.get(key)
    if (!entry?.projects.has(projectId)) {
      throw new PreviewError(
        'font_not_found',
        'Font not registered for this project',
        404
      )
    }
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 1024 ||
      ids.some(id => !Number.isSafeInteger(id) || id < 0 || id > 65535)
    ) {
      throw new PreviewError(
        'invalid_glyph_ids',
        'Expected up to 1024 glyph ids',
        400
      )
    }
    if (!entry.loading) {
      entry.loading = this.load(entry.font).catch(error => {
        entry.loading = null
        throw error
      })
    }
    const loaded = await entry.loading
    const glyphs = {}
    for (const id of ids) {
      let glyph = entry.glyphs.get(id)
      if (!glyph) {
        if (loaded.type1) {
          glyph = charStringToGlyph(loaded.type1, loaded.encoding[id])
        } else if (id < loaded.parsed.numGlyphs) {
          const value = loaded.parsed.getGlyph(id)
          glyph = { path: value.path.toSVG(), advance: value.advanceWidth }
        }
        if (!glyph) {
          throw new PreviewError('glyph_not_found', `Unknown glyph ${id}`, 404)
        }
        // Bound the outline cache even for a large CJK font.
        if (entry.glyphs.size >= 4096) {
          entry.glyphs.delete(entry.glyphs.keys().next().value)
        }
        entry.glyphs.set(id, glyph)
      }
      glyphs[id] = glyph
    }
    return { font_key: key, unitsPerEm: loaded.unitsPerEm, glyphs }
  }
}
