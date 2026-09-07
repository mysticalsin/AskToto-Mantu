/**
 * Natural Earth 110m country paths include date-line leftovers that paint as
 * gray horizontal bands (Russia sliver across Canada, Fiji sliver across the
 * southern ocean). Drop those subpaths and break near-horizontal full-width jumps.
 */

const BAND_MIN_WIDTH = 700
const BAND_MAX_HEIGHT = 10

export type BBox = { minX: number; maxX: number; minY: number; maxY: number }

function bboxOfPairs(pairs: number[]): BBox | null {
  if (pairs.length < 4) return null
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const x = pairs[i]
    const y = pairs[i + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return null
  return { minX, maxX, minY, maxY }
}

export function isBandBox(box: BBox): boolean {
  return box.maxX - box.minX >= BAND_MIN_WIDTH && box.maxY - box.minY <= BAND_MAX_HEIGHT
}

function numbersIn(d: string): number[] {
  return [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))
}

/** Split an SVG path into M...Z (or open) subpaths. */
export function splitSubpaths(d: string): string[] {
  const out: string[] = []
  const re = /[Mm][^Mm]*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d))) {
    const part = m[0].trim()
    if (part) out.push(part)
  }
  return out
}

export function subpathIsBand(d: string): boolean {
  const box = bboxOfPairs(numbersIn(d))
  return Boolean(box && isBandBox(box))
}

function breakWideJumps(subpath: string): string {
  const tokens = [...subpath.matchAll(/[A-Za-z]|-?\d+(?:\.\d+)?/g)].map((m) => m[0])
  if (tokens.length < 5) return subpath
  const out: string[] = []
  let cmd = ''
  let x = NaN
  let y = NaN
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t
      out.push(t)
      i++
      continue
    }
    const n = Number(t)
    if (cmd === 'H' || cmd === 'h') {
      if (Number.isFinite(x) && Math.abs(n - x) >= BAND_MIN_WIDTH) {
        out.push('M', String(n), String(y))
      } else {
        out.push(t)
      }
      x = n
      i++
      continue
    }
    if (cmd === 'V' || cmd === 'v') {
      out.push(t)
      y = n
      i++
      continue
    }
    if (i + 1 >= tokens.length) {
      out.push(t)
      i++
      continue
    }
    const nx = n
    const ny = Number(tokens[i + 1])
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Math.abs(nx - x) >= BAND_MIN_WIDTH &&
      Math.abs(ny - y) <= BAND_MAX_HEIGHT
    ) {
      out.push('M', String(nx), String(ny))
    } else {
      out.push(t, tokens[i + 1])
    }
    x = nx
    y = ny
    i += 2
  }
  return out.join(' ')
}

export function stripMapBands(d: string): string {
  return splitSubpaths(d)
    .filter((part) => !subpathIsBand(part))
    .map(breakWideJumps)
    .join('')
}

export function findBandSubpaths(svgOrPath: string): string[] {
  const paths = [...svgOrPath.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1])
  const source = paths.length ? paths : [svgOrPath]
  const bands: string[] = []
  for (const d of source) {
    for (const part of splitSubpaths(d)) {
      if (subpathIsBand(part)) bands.push(part)
    }
  }
  return bands
}
