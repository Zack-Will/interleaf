import { describe, it, expect } from 'vitest'
import { utf8Offset, utf16Offset } from '../../app/src/Offsets.mjs'

describe('UTF-8 byte to UTF-16 offsets', () => {
  it('round trips every character boundary across ASCII, CJK and emoji', () => {
    const text = 'a中😀e\u0301\n文'
    for (const position of [0, 1, 2, 4, 5, 6, 7, 8]) {
      expect(utf16Offset(text, utf8Offset(text, position))).toBe(position)
    }
    expect(utf16Offset('', 0)).toBe(0)
  })

  it('rejects partial characters and invalid offsets', () => {
    for (const position of [-1, 2, 3, 5, 6, 7, 9, 1.5, NaN]) {
      expect(() => utf16Offset('a中😀', position)).toThrow()
    }
    expect(() => utf16Offset('a', 2)).toThrow('outside')
  })
})
