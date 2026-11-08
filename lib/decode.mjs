import zlib from 'node:zlib'
import { promisify } from 'node:util'

/** Keep decompression on libuv's shared pool; callers own deadlines and text decoding. */
export async function decodeBuffer(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase()
  const decoder = enc.includes('br') ? zlib.brotliDecompress
    : enc.includes('gzip') ? zlib.gunzip : enc.includes('deflate') ? zlib.inflate : null
  return decoder ? promisify(decoder)(buffer, { chunkSize: 256 * 1024 }) : buffer
}
