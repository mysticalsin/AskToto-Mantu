import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { decodePng, downscale, encodePng, makeTrayIcons, TRAY_SIZE } from './make-tray-icons.mjs'

const REPO = join(__dirname, '..')

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** An RGB PNG whose row y is written with PNG filter type y % 5, so the decoder must undo every filter. */
function rgbPngWithEveryFilter(width: number, rows: number[][]): Buffer {
  const bpp = 3
  const stride = width * bpp
  const lines: Buffer[] = []
  let prev = Buffer.alloc(stride)
  rows.forEach((row, y) => {
    const cur = Buffer.from(row)
    const filter = y % 5
    const out = Buffer.alloc(stride + 1)
    out[0] = filter
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0
      const up = prev[i]
      const upLeft = i >= bpp ? prev[i - bpp] : 0
      const p = left + up - upLeft
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft)
          ? left
          : Math.abs(p - up) <= Math.abs(p - upLeft)
            ? up
            : upLeft
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter]
      out[i + 1] = (cur[i] - predictor) & 0xff
    }
    lines.push(out)
    prev = cur
  })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(rows.length, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(lines))), chunk('IEND', Buffer.alloc(0))])
}

describe('make-tray-icons (M2-0031)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('decodes every PNG filter type of an RGB image to opaque RGBA', () => {
    const width = 3
    const rows = Array.from({ length: 5 }, (_, y) => Array.from({ length: width * 3 }, (_, i) => (y * 53 + i * 29 + 7) & 0xff))
    const decoded = decodePng(rgbPngWithEveryFilter(width, rows))
    expect(decoded.width).toBe(width)
    expect(decoded.height).toBe(5)
    rows.forEach((row, y) => {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4
        expect([...decoded.pixels.subarray(o, o + 4)]).toEqual([row[x * 3], row[x * 3 + 1], row[x * 3 + 2], 255])
      }
    })
  })

  it('round-trips RGBA pixels through encode and decode', () => {
    const pixels = Buffer.from(Array.from({ length: 4 * 4 * 4 }, (_, i) => (i * 37) & 0xff))
    const decoded = decodePng(encodePng({ width: 4, height: 4, pixels }))
    expect(decoded).toEqual({ width: 4, height: 4, pixels })
  })

  it('downscales a uniform image to the same colour and ignores the colour of transparent pixels', () => {
    const size = 10
    const pixels = Buffer.alloc(size * size * 4)
    for (let i = 0; i < size * size; i++) pixels.set(i % 2 ? [200, 100, 50, 255] : [0, 0, 255, 0], i * 4)
    const small = downscale({ width: size, height: size, pixels }, 1)
    expect([...small.pixels]).toEqual([200, 100, 50, 128])
  })

  it('writes an 18 px tray.png and a 36 px tray@2x.png from the app icon', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'tray-icons-'))
    dirs.push(outDir)
    const files = makeTrayIcons(join(REPO, 'build', 'icon.png'), outDir)
    expect(files).toEqual([join(outDir, 'tray.png'), join(outDir, 'tray@2x.png')])
    const [one, two] = files.map((file) => decodePng(readFileSync(file)))
    expect([one.width, one.height]).toEqual([TRAY_SIZE, TRAY_SIZE])
    expect([two.width, two.height]).toEqual([TRAY_SIZE * 2, TRAY_SIZE * 2])
    expect(one.pixels.some((v, i) => i % 4 === 3 && v > 0)).toBe(true)
  })

  it('runs before every build, and both platform packages ship its output', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.prebuild).toContain('node scripts/make-tray-icons.mjs')
    // electron-builder.win.yml and the QA identity config extend this file, so its top-level extraResources
    // reach both the mac and the Windows package.
    const builder = readFileSync(join(REPO, 'electron-builder.yml'), 'utf8')
    expect(builder).toContain('  - from: build/tray\n    to: tray\n')
    expect(readFileSync(join(REPO, 'electron-builder.win.yml'), 'utf8')).toContain('extends: ./electron-builder.yml')
  })
})
