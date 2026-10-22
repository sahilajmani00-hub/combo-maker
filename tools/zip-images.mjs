/** Read image entries from an ordinary ZIP without extracting arbitrary paths. */
import { createReadStream, openSync, closeSync, readSync, statSync, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createInflateRaw } from 'node:zlib'

function readAt(fd, length, position) {
  const bytes = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const amount = readSync(fd, bytes, read, length - read, position + read)
    if (!amount) throw new Error('The ZIP is incomplete.')
    read += amount
  }
  return bytes
}

export function listImages(path) {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const tailStart = Math.max(0, size - 65557)
    const tail = readAt(fd, size - tailStart, tailStart)
    let end = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        end = i
        break
      }
    }
    if (end < 0) throw new Error('The ZIP has no readable directory.')
    const count = tail.readUInt16LE(end + 10)
    const directorySize = tail.readUInt32LE(end + 12)
    const directoryOffset = tail.readUInt32LE(end + 16)
    if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported; split this ZIP into smaller lots.')
    }
    if (count > 10000 || directoryOffset + directorySize > size) throw new Error('The ZIP directory is invalid or too large.')
    const directory = readAt(fd, directorySize, directoryOffset)
    const entries = []
    let at = 0
    for (let n = 0; n < count; n++) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw new Error('The ZIP directory is damaged.')
      const flags = directory.readUInt16LE(at + 8)
      const method = directory.readUInt16LE(at + 10)
      const compressedSize = directory.readUInt32LE(at + 20)
      const uncompressedSize = directory.readUInt32LE(at + 24)
      const nameLength = directory.readUInt16LE(at + 28)
      const extraLength = directory.readUInt16LE(at + 30)
      const commentLength = directory.readUInt16LE(at + 32)
      const localOffset = directory.readUInt32LE(at + 42)
      const next = at + 46 + nameLength + extraLength + commentLength
      if (next > directory.length) throw new Error('The ZIP directory is damaged.')
      const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8').replaceAll('\\', '/')
      if (/\.(jpe?g|png|webp)$/i.test(name) && !name.split('/').some((part) => part === '..' || part === '__MACOSX')) {
        if (flags & 1) throw new Error('Password-protected ZIPs are not supported.')
        if (![0, 8].includes(method)) throw new Error(`Unsupported ZIP compression method ${method}.`)
        if (uncompressedSize > 50 * 1024 * 1024) throw new Error(`Image ${name} is larger than 50 MB.`)
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
          throw new Error('ZIP64 entries are not supported; split this ZIP into smaller lots.')
        }
        entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
      }
      at = next
    }
    if (!entries.length) throw new Error('No JPG, PNG or WebP images were found in the ZIP.')
    return entries
  } finally {
    closeSync(fd)
  }
}

export async function extractImage(zipPath, entry, outputPath) {
  const fd = openSync(zipPath, 'r')
  let start
  try {
    const local = readAt(fd, 30, entry.localOffset)
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`The ZIP entry ${entry.name} is damaged.`)
    start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  } finally {
    closeSync(fd)
  }
  if (entry.compressedSize === 0) throw new Error(`Image ${entry.name} is empty.`)
  const input = createReadStream(zipPath, { start, end: start + entry.compressedSize - 1 })
  let bytes = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      callback(bytes > entry.uncompressedSize ? new Error(`Image ${entry.name} exceeds its ZIP size.`) : null, chunk)
    },
  })
  if (entry.method === 8) await pipeline(input, createInflateRaw(), limiter, createWriteStream(outputPath))
  else await pipeline(input, limiter, createWriteStream(outputPath))
  if (statSync(outputPath).size !== entry.uncompressedSize) throw new Error(`Image ${entry.name} did not extract completely.`)
}
