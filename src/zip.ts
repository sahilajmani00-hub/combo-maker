/**
 * Minimal store-only (uncompressed) ZIP writer.
 *
 * PNG/JPEG bytes are already compressed, so deflating them would cost CPU for
 * roughly nothing — which is exactly the case where "store" is the right call
 * and lets this stay dependency-free.
 */

export type ZipEntry = { name: string; data: Uint8Array<ArrayBuffer> }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array<ArrayBufferLike>): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** ZIP stores timestamps in the 1980-based MS-DOS format. */
function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

export function createZip(entries: ZipEntry[], now = new Date()): Blob {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(now)
  const parts: Uint8Array<ArrayBuffer>[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const header = new Uint8Array(30 + name.length)
    const headerView = new DataView(header.buffer)
    headerView.setUint32(0, 0x04034b50, true)
    headerView.setUint16(4, 20, true) // version needed
    headerView.setUint16(6, 0x0800, true) // UTF-8 filename flag
    headerView.setUint16(8, 0, true) // method: store
    headerView.setUint16(10, time, true)
    headerView.setUint16(12, date, true)
    headerView.setUint32(14, crc, true)
    headerView.setUint32(18, size, true)
    headerView.setUint32(22, size, true)
    headerView.setUint16(26, name.length, true)
    headerView.setUint16(28, 0, true) // extra length
    header.set(name, 30)

    const record = new Uint8Array(46 + name.length)
    const recordView = new DataView(record.buffer)
    recordView.setUint32(0, 0x02014b50, true)
    recordView.setUint16(4, 20, true) // version made by
    recordView.setUint16(6, 20, true) // version needed
    recordView.setUint16(8, 0x0800, true)
    recordView.setUint16(10, 0, true)
    recordView.setUint16(12, time, true)
    recordView.setUint16(14, date, true)
    recordView.setUint32(16, crc, true)
    recordView.setUint32(20, size, true)
    recordView.setUint32(24, size, true)
    recordView.setUint16(28, name.length, true)
    recordView.setUint32(42, offset, true) // local header offset
    record.set(name, 46)

    parts.push(header, entry.data)
    central.push(record)
    offset += header.length + size
  }

  const centralSize = central.reduce((total, record) => total + record.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)

  return new Blob([...parts, ...central, end], { type: 'application/zip' })
}
