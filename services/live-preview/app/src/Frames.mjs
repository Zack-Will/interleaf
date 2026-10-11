import { PreviewError } from './Errors.mjs'

export const frameTypes = Object.freeze({
  hello: 1,
  paragraph: 2,
  layout: 3,
  background: 4,
  diagnostics: 5,
  engine: 6,
  busy: 7,
})

export function encodeFrame(type, header, body = Buffer.alloc(0)) {
  if (!frameTypes[type]) {
    throw new PreviewError('invalid_frame', 'Unknown frame type')
  }
  const json = Buffer.from(JSON.stringify(header))
  const prefix = Buffer.alloc(5)
  prefix[0] = frameTypes[type]
  prefix.writeUInt32LE(json.length, 1)
  return Buffer.concat([prefix, json, body])
}

export function decodeFrame(bytes) {
  const type = Object.keys(frameTypes).find(key => frameTypes[key] === bytes[0])
  if (!type || bytes.length < 5 || bytes.readUInt32LE(1) > bytes.length - 5) {
    throw new PreviewError('invalid_frame', 'Malformed frame')
  }
  const end = 5 + bytes.readUInt32LE(1)
  return {
    type,
    header: JSON.parse(bytes.subarray(5, end).toString()),
    body: bytes.subarray(end),
  }
}
