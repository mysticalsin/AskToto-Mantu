// Pure helpers of the design-capture job (scripts/design/capture-states.mjs): the capture matrix, the file
// name of each shot and the manifest that ties every image to its state id, sha256 and source commit.
import { createHash } from 'node:crypto'
import { summarizeAudits } from './capture-audit.mjs'

export const THEMES = ['light', 'dark']
export const SCALES = [1, 2]
export const MOTIONS = ['no-preference', 'reduce']

/** Every theme x scale x motion combination, in a stable order. */
export function captureMatrix() {
  const rows = []
  for (const theme of THEMES) {
    for (const scale of SCALES) {
      for (const motion of MOTIONS) rows.push({ theme, scale, motion })
    }
  }
  return rows
}

/**
 * The page's `{ id, viewport }` list, checked: a non-empty array of unique ids, each with a positive integer
 * width and height. Throws on anything else so a malformed page never yields a silently mis-sized shot.
 */
export function captureStates(listed) {
  if (!Array.isArray(listed) || listed.length === 0) throw new Error('The page listed no design states')
  const ids = new Set()
  return listed.map((entry) => {
    const id = entry?.id
    const { width, height } = entry?.viewport ?? {}
    if (typeof id !== 'string' || id === '') throw new Error(`Design state without an id: ${JSON.stringify(entry)}`)
    if (ids.has(id)) throw new Error(`Duplicate design state id: ${id}`)
    if (![width, height].every((n) => Number.isInteger(n) && n > 0)) {
      throw new Error(`Design state ${id} has no valid viewport: ${JSON.stringify(entry.viewport)}`)
    }
    ids.add(id)
    return { id, viewport: { width, height } }
  })
}

/** Windows-safe name, unique per (state, theme, scale, motion). */
export function captureFileName(stateId, { theme, scale, motion }) {
  return `${stateId}__${theme}__${scale}x__${motion === 'reduce' ? 'reduced-motion' : 'motion'}.png`
}

/** Pixel size of a PNG, read from its IHDR chunk (width and height are big-endian uint32 at bytes 16 and 20). */
export function pngSize(bytes) {
  const buf = Buffer.from(bytes)
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** Fails when a shot is not `scale x viewport` pixels, so a silent 1x capture cannot pass as 2x. */
export function assertPngSize(bytes, viewport, scale, label) {
  const want = { width: viewport.width * scale, height: viewport.height * scale }
  const got = pngSize(bytes)
  if (got.width !== want.width || got.height !== want.height) {
    throw new Error(`${label}: expected ${want.width}x${want.height}, got ${got.width}x${got.height}`)
  }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * @param {{ commit: string, platform: string, shots: Array<{ state: string, viewport: { width: number, height: number }, theme: string, scale: number, motion: string, file: string, bytes: Uint8Array, audit: object }>, negativeControl?: { detected: boolean, kinds: string[] } }} input
 */
export function buildManifest({ commit, platform, shots, negativeControl }) {
  const entries = shots.map(({ state, viewport, theme, scale, motion, file, bytes, audit }) => ({
    state,
    viewport: { width: viewport.width, height: viewport.height },
    theme,
    scale,
    motion,
    file,
    sha256: sha256Hex(bytes),
    audit
  }))
  return {
    commit,
    platform,
    // Pulse and caret animations are caught mid-cycle: only reduced-motion shots are byte-reproducible.
    reproducibleMotions: ['reduce'],
    entries,
    audit: summarizeAudits(entries, negativeControl)
  }
}
