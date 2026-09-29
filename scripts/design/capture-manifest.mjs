// Pure helpers of the design-capture job (scripts/design/capture-states.mjs): the capture matrix, the file
// name of each shot and the manifest that ties every image to its state id, sha256 and source commit.
import { createHash } from 'node:crypto'

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

/** Windows-safe name, unique per (state, theme, scale, motion). */
export function captureFileName(stateId, { theme, scale, motion }) {
  return `${stateId}__${theme}__${scale}x__${motion === 'reduce' ? 'reduced-motion' : 'motion'}.png`
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * @param {{ commit: string, platform: string, shots: Array<{ state: string, theme: string, scale: number, motion: string, file: string, bytes: Uint8Array }> }} input
 */
export function buildManifest({ commit, platform, shots }) {
  return {
    commit,
    platform,
    entries: shots.map(({ state, theme, scale, motion, file, bytes }) => ({
      state,
      theme,
      scale,
      motion,
      file,
      sha256: sha256Hex(bytes)
    }))
  }
}
