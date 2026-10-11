export function record(tag, payload = Buffer.alloc(0)) {
  const prefix = Buffer.alloc(5)
  prefix[0] = tag
  prefix.writeUInt32LE(payload.length, 1)
  return Buffer.concat([prefix, payload])
}

export function binaryList(records) {
  const header = Buffer.alloc(16)
  header.write('RTDL')
  header.writeUInt16LE(1, 4)
  const bytes = Buffer.concat([header, ...records, record(0xff)])
  bytes.writeUInt32LE(bytes.length, 8)
  return bytes
}

export function integers(values) {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeInt32LE(value, index * 4))
  return bytes
}

export function binaryRow({
  x = 100,
  y = 200,
  w = 300,
  h = 50,
  d = 10,
  unit = 7,
  row = 1,
} = {}) {
  return [
    record(
      0x10,
      Buffer.concat([integers([1, row, x, y, w, h, d]), Buffer.alloc(10)])
    ),
    record(0x12, integers([unit, row])),
    record(0x11),
  ]
}

export function binaryFont() {
  const prefix = Buffer.alloc(28)
  prefix.writeUInt32LE(5)
  prefix.writeInt32LE(655360, 4)
  prefix[8] = 1
  prefix.writeInt32LE(200, 12)
  prefix.writeInt32LE(1200, 16)
  return record(2, Buffer.concat([prefix, Buffer.alloc(10)]))
}
