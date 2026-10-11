import { ProtocolError } from './Errors.mjs'

export const frameTypes = Object.freeze({
  hello: 1,
  paragraph: 2,
  layout: 3,
  background: 4,
  diagnostics: 5,
  engine: 6,
  busy: 7,
  access: 8,
})

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function encodeFrame(type, header, body = new Uint8Array()) {
  if (!frameTypes[type]) {
    throw new ProtocolError('invalid_frame', 'Unknown frame type')
  }
  const json = encoder.encode(JSON.stringify(header))
  const bytes = new Uint8Array(5 + json.length + body.length)
  bytes[0] = frameTypes[type]
  new DataView(bytes.buffer).setUint32(1, json.length, true)
  bytes.set(json, 5)
  bytes.set(body, 5 + json.length)
  return bytes
}

export function decodeFrame(input) {
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    if (bytes.length < 5) throw new Error('Truncated preview frame')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const type = Object.keys(frameTypes).find(
      key => frameTypes[key] === bytes[0]
    )
    const end = 5 + view.getUint32(1, true)
    if (!type || end > bytes.length) throw new Error('Invalid preview frame')
    const header = JSON.parse(decoder.decode(bytes.subarray(5, end)))
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      throw new Error('Invalid preview header')
    }
    if (type !== 'paragraph' && end !== bytes.length) {
      throw new Error('Unexpected preview body')
    }
    return { type, header, body: bytes.subarray(end) }
  } catch (error) {
    throw new ProtocolError('invalid_frame', error.message)
  }
}
