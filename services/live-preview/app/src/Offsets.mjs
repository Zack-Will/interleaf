import { PreviewError } from './Errors.mjs'

export function utf8Offset(text, position) {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position > text.length
  ) {
    throw new PreviewError('invalid_op', 'Offset is outside the document')
  }
  const before = text.charCodeAt(position - 1)
  const after = text.charCodeAt(position)
  if (
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  ) {
    throw new PreviewError('invalid_op', 'Offset splits a surrogate pair')
  }
  return Buffer.byteLength(text.slice(0, position), 'utf8')
}

export function convertComponent(text, component) {
  const { p, i, d } = component
  if ((typeof i !== 'string') === (typeof d !== 'string')) {
    throw new PreviewError('invalid_op', 'Expected an insert or delete')
  }
  const endPosition = p + (d?.length || 0)
  const start = utf8Offset(text, p)
  const end = utf8Offset(text, endPosition)
  if (d !== undefined && text.slice(p, endPosition) !== d) {
    throw new PreviewError('invalid_op', 'Deleted text does not match')
  }
  const inserted = i || ''
  return {
    start,
    end,
    text: inserted,
    content: text.slice(0, p) + inserted + text.slice(endPosition),
  }
}
