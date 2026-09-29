import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESIGN_CAPTURE_ENTRY, rendererInputs } from './renderer-inputs'
import {
  MOTIONS,
  SCALES,
  THEMES,
  buildManifest,
  captureFileName,
  captureMatrix,
  sha256Hex
} from './capture-manifest.mjs'
import { DESIGN_STATES, DESIGN_STATE_IDS, resolveDesignState } from '../../src/renderer/src/design-capture/states'

const root = resolve(__dirname, '..', '..')
const read = (...parts: string[]): string =>
  readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n')

/** The `- 'pattern'` entries of every `files:` list in a packaging config, whatever its indent. */
function fileLists(config: string): string[][] {
  const lines = config.split('\n')
  const lists: string[][] = []
  for (let i = 0; i < lines.length; i++) {
    const header = /^( *)files:\s*$/.exec(lines[i])
    if (!header) continue
    const list: string[] = []
    for (const line of lines.slice(i + 1)) {
      const item = /^ *- '?([^'#]+?)'?\s*$/.exec(line)
      if (item) list.push(item[1])
      else if (!/^ *#/.test(line)) break
    }
    lists.push(list)
  }
  return lists
}

/** True when a `!`-negated `files` entry (only `*` wildcards used here) excludes the path. */
function excludes(list: string[], path: string): boolean {
  return list
    .filter((entry) => entry.startsWith('!'))
    .some((entry) => {
      const pattern = entry.slice(1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
      return new RegExp(`^${pattern}$`).test(path)
    })
}

describe('design-capture renderer entry', () => {
  const rendererRoot = join(root, 'src', 'renderer')

  it('is not built without METIS_DESIGN_CAPTURE=1', () => {
    for (const env of [{}, { METIS_DESIGN_CAPTURE: '' }, { METIS_DESIGN_CAPTURE: '0' }]) {
      expect(Object.keys(rendererInputs(rendererRoot, env))).toEqual(['index', 'decoder'])
    }
  })

  it('is built when METIS_DESIGN_CAPTURE=1', () => {
    const inputs = rendererInputs(rendererRoot, { METIS_DESIGN_CAPTURE: '1' })
    expect(inputs[DESIGN_CAPTURE_ENTRY]).toBe(join(rendererRoot, 'design-capture.html'))
    expect(inputs.index).toBe(join(rendererRoot, 'index.html'))
  })

  it('is excluded from the packaged file list of every installer config, wherever it is emitted', () => {
    const emitted = [
      'out/renderer/design-capture.html',
      'out/renderer/assets/design-capture-Bx3k9Q.js',
      'out/renderer/assets/design-capture-Bx3k9Q.css'
    ]
    const configs = ['electron-builder.yml', 'electron-builder.win.yml']
    let checked = 0
    for (const config of configs) {
      const lists = fileLists(read(config))
      expect(lists.length, config).toBeGreaterThan(0)
      for (const list of lists) {
        expect(list, config).toContain('out/**/*')
        for (const path of emitted) expect(excludes(list, path), `${config}: ${path}`).toBe(true)
        // The app's own renderer stays in.
        expect(excludes(list, 'out/renderer/index.html'), config).toBe(false)
        checked++
      }
    }
    // Base list, the mac override and the Windows list: a new packaging list must be added here on purpose.
    expect(checked).toBe(3)
  })
})

describe('design states', () => {
  it('has unique ids and resolves each from a query string', () => {
    expect(new Set(DESIGN_STATE_IDS).size).toBe(DESIGN_STATES.length)
    for (const s of DESIGN_STATES) expect(resolveDesignState(`?state=${s.id}`)).toBe(s)
  })

  it('resolves nothing for a missing or unknown state', () => {
    expect(resolveDesignState('')).toBeUndefined()
    expect(resolveDesignState('?state=nope')).toBeUndefined()
  })
})

describe('capture matrix and manifest', () => {
  it('covers light/dark x 1x/2x x reduced motion exactly once each', () => {
    const rows = captureMatrix()
    expect(rows).toHaveLength(THEMES.length * SCALES.length * MOTIONS.length)
    expect(new Set(rows.map((r) => JSON.stringify(r))).size).toBe(rows.length)
    expect(THEMES).toEqual(['light', 'dark'])
    expect(SCALES).toEqual([1, 2])
    expect(MOTIONS).toEqual(['no-preference', 'reduce'])
  })

  it('names every shot uniquely across states and matrix rows', () => {
    const names = DESIGN_STATE_IDS.flatMap((id) => captureMatrix().map((row) => captureFileName(id, row)))
    expect(new Set(names).size).toBe(names.length)
    expect(captureFileName('bar-idle', { theme: 'dark', scale: 2, motion: 'reduce' })).toBe(
      'bar-idle__dark__2x__reduced-motion.png'
    )
  })

  it('records state, sha256 and commit for each image', () => {
    const bytes = new TextEncoder().encode('png-bytes')
    const manifest = buildManifest({
      commit: 'abc123',
      platform: 'darwin',
      shots: [{ state: 'bar-idle', theme: 'light', scale: 1, motion: 'no-preference', file: 'a.png', bytes }]
    })
    expect(manifest.commit).toBe('abc123')
    expect(manifest.entries).toEqual([
      {
        state: 'bar-idle',
        theme: 'light',
        scale: 1,
        motion: 'no-preference',
        file: 'a.png',
        sha256: sha256Hex(bytes)
      }
    ])
    expect(manifest.entries[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
