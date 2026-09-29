// Builds the pre-sized tray images (18 px and its 36 px @2x sibling) from build/icon.png, so the packaged app loads
// its tray icon as-is and never decodes or resizes the 1024² app icon on the main thread (M2-0031).
// Runs in `prebuild`, before every packaging chain; electron-builder ships the output as extraResources `tray/`.
// Usage: node scripts/make-tray-icons.mjs [outDir]   (default build/tray, git-ignored)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Logical tray size; the files are tray.png at 1x and tray@2x.png at 2x. */
export const TRAY_SIZE = 18

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG into RGBA pixels. Any other format is rejected. */
export function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file')
  let width = 0
  let height = 0
  let channels = 0
  const idat = []
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    const data = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const [depth, colorType, , , interlace] = data.subarray(8, 13)
      channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0
      if (depth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(`unsupported PNG: depth ${depth}, color type ${colorType}, interlace ${interlace}`)
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    at += 12 + length
  }
  if (!width || !height) throw new Error('PNG has no IHDR')
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0
      const up = prev[i]
      const upLeft = i >= channels ? prev[i - channels] : 0
      line[i] = (line[i] + unfilter(filter, left, up, upLeft)) & 0xff
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      pixels[o] = line[x * channels]
      pixels[o + 1] = line[x * channels + 1]
      pixels[o + 2] = line[x * channels + 2]
      pixels[o + 3] = channels === 4 ? line[x * channels + 3] : 255
    }
    prev = line
  }
  return { width, height, pixels }
}

function unfilter(filter, left, up, upLeft) {
  switch (filter) {
    case 0:
      return 0
    case 1:
      return left
    case 2:
      return up
    case 3:
      return (left + up) >> 1
    case 4: {
      const p = left + up - upLeft
      const pa = Math.abs(p - left)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - upLeft)
      return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
    }
    default:
      throw new Error(`unknown PNG filter ${filter}`)
  }
}

/** Box-filters RGBA pixels down to size×size, averaging colour weighted by alpha so transparent edges stay clean. */
export function downscale({ width, height, pixels }, size) {
  const out = Buffer.alloc(size * size * 4)
  for (let ty = 0; ty < size; ty++) {
    const y0 = Math.floor((ty * height) / size)
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / size))
    for (let tx = 0; tx < size; tx++) {
      const x0 = Math.floor((tx * width) / size)
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / size))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4
          const alpha = pixels[i + 3]
          r += pixels[i] * alpha
          g += pixels[i + 1] * alpha
          b += pixels[i + 2] * alpha
          a += alpha
        }
      }
      const o = (ty * size + tx) * 4
      const count = (y1 - y0) * (x1 - x0)
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(a / count)
    }
  }
  return { width: size, height: size, pixels: out }
}

/** Encodes RGBA pixels as an 8-bit, non-interlaced RGBA PNG. */
export function encodePng({ width, height, pixels }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** Writes tray.png and tray@2x.png into outDir and returns their paths. */
export function makeTrayIcons(sourcePath, outDir) {
  const source = decodePng(readFileSync(sourcePath))
  mkdirSync(outDir, { recursive: true })
  const files = [
    [join(outDir, 'tray.png'), TRAY_SIZE],
    [join(outDir, 'tray@2x.png'), TRAY_SIZE * 2]
  ]
  for (const [file, size] of files) writeFileSync(file, encodePng(downscale(source, size)))
  return files.map(([file]) => file)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const outDir = resolve(process.argv[2] ?? join(REPO_ROOT, 'build', 'tray'))
  for (const file of makeTrayIcons(join(REPO_ROOT, 'build', 'icon.png'), outDir)) console.log(`[make-tray-icons] wrote ${file}`)
}
