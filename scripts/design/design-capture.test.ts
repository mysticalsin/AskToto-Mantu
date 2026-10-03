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
  captureStates,
  assertPngSize,
  pngSize,
  sha256Hex
} from './capture-manifest.mjs'
import { AUDIT_STANDARD } from './capture-audit.mjs'
import {
  AUDIT_NEGATIVE_CONTROL_STATE,
  DESIGN_CAPTURE_STATES,
  DESIGN_STATES,
  DESIGN_STATE_IDS,
  designStateViewport,
  resolveDesignState,
  resolveDesignStateIncludingQa
} from '../../src/renderer/src/design-capture/states'
import { hiddenSearchMatches, searchSettings } from '../../src/renderer/src/design-capture/settings/data'
import { SETTINGS_WINDOW_MIN } from '@shared/settings-bounds'

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

  it('keeps the QA audit negative control out of evidence state ids', () => {
    expect(DESIGN_STATE_IDS).not.toContain(AUDIT_NEGATIVE_CONTROL_STATE.id)
    expect(resolveDesignState(`?state=${AUDIT_NEGATIVE_CONTROL_STATE.id}`)).toBeUndefined()
    expect(resolveDesignStateIncludingQa(`?state=${AUDIT_NEGATIVE_CONTROL_STATE.id}`)).toBe(
      AUDIT_NEGATIVE_CONTROL_STATE
    )
  })

  it('keeps the six placeholder states and adds exactly the seventeen Settings states', () => {
    expect(DESIGN_STATES.map((s) => [s.id, s.title])).toEqual([
      ['bar-idle', 'Bar, idle'],
      ['bar-listening', 'Bar, listening'],
      ['answer-streaming', 'Answer, streaming'],
      ['answer-complete', 'Answer, complete'],
      ['review-summary', 'Review, summary'],
      ['error-recoverable', 'Error, recoverable'],
      ['S01-general', 'General, fresh install'],
      ['S02-voice-ready', 'Voice & meetings, cloud speech ready'],
      ['S03-voice-unavailable', 'Cloud speech unavailable, no silent switch'],
      ['S04-local-speech-review', 'Optional local speech, review before download'],
      ['S05-local-speech-downloading', 'Optional local speech, downloading'],
      ['S06-local-speech-installed', 'Optional local speech, installed but not selected'],
      ['S07-knowledge', 'Knowledge & skills'],
      ['S08-privacy-managed', 'Privacy & account with organization locks'],
      ['S09-policy-sheet', 'Effective policy'],
      ['S10-advanced', 'Advanced drawer'],
      ['S11-search', 'Search with synonyms'],
      ['S12-search-empty', 'Search for a control hidden by policy'],
      ['S13-save-failed', 'Save failed, value reverted'],
      ['S14-policy-changed', 'Policy changed during a meeting'],
      ['S15-narrow', 'Narrow window'],
      ['S16-migrated', 'First open after upgrading'],
      ['S17-connected-apps', 'Privacy & account, connected apps']
    ])
  })

  it('numbers the Settings states S01 to S17 in order, one each', () => {
    const numbers = DESIGN_STATES.filter((s) => s.kind === 'settings').map((s) => s.id.slice(0, 3))
    expect(numbers).toEqual(Array.from({ length: 17 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`))
  })
})

describe('per-state viewport', () => {
  const state = (id: string) => {
    const found = resolveDesignState(`?state=${id}`)
    if (!found) throw new Error(`missing state ${id}`)
    return found
  }

  const placeholders = DESIGN_STATES.filter((s) => s.kind !== 'settings')
  const settings = DESIGN_STATES.filter((s) => s.kind === 'settings')

  it('opens a Settings state at SETTINGS_WINDOW_MIN, the shared constant itself rather than a copy', () => {
    expect(SETTINGS_WINDOW_MIN).toEqual({ width: 880, height: 800 })
    expect(settings).toHaveLength(17)
    for (const s of settings.filter((s) => s.id !== 'S15-narrow')) {
      expect(designStateViewport(s), s.id).toBe(SETTINGS_WINDOW_MIN)
    }
  })

  it('captures the narrow window at 360x720 and the placeholder states at 960x640', () => {
    expect(designStateViewport(state('S15-narrow'))).toEqual({ width: 360, height: 720 })
    expect(placeholders).toHaveLength(6)
    for (const s of placeholders) expect(designStateViewport(s), s.id).toEqual({ width: 960, height: 640 })
  })

  it('exposes {id, viewport} for every listed state to the driver, which accepts the list', () => {
    expect(DESIGN_CAPTURE_STATES.map((s) => s.id)).toEqual(DESIGN_STATE_IDS)
    for (const s of DESIGN_CAPTURE_STATES) expect(s.viewport, s.id).toEqual(designStateViewport(state(s.id)))
    expect(captureStates(JSON.parse(JSON.stringify(DESIGN_CAPTURE_STATES)))).toEqual(DESIGN_CAPTURE_STATES)
  })

  it('rejects a page list without states, with a duplicate id or without a usable viewport', () => {
    const ok = { id: 'a', viewport: { width: 10, height: 20 } }
    expect(() => captureStates([])).toThrow(/no design states/)
    expect(() => captureStates(undefined)).toThrow(/no design states/)
    expect(() => captureStates(['a'])).toThrow(/without an id/)
    expect(() => captureStates([ok, ok])).toThrow(/Duplicate design state id: a/)
    expect(() => captureStates([{ id: 'b' }])).toThrow(/b has no valid viewport/)
    expect(() => captureStates([{ id: 'b', viewport: { width: 0, height: 20 } }])).toThrow(/b has no valid viewport/)
    expect(() => captureStates([{ id: 'b', viewport: { width: 10.5, height: 20 } }])).toThrow(/b has no valid viewport/)
  })
})

describe('Settings search', () => {
  it("widens 'mic' to the microphone, input-device and speech rows and nothing else", () => {
    const groups = searchSettings('mic', 'cloud-ready')
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.label)])).toEqual([
      ['Voice & meetings', ['Microphone access', 'Input device', 'Speech processing']]
    ])
  })

  it('matches nothing for an empty or unrelated query', () => {
    expect(searchSettings('  ', 'cloud-ready')).toEqual([])
    expect(searchSettings('zzz', 'cloud-ready')).toEqual([])
  })

  it('finds the diagnostics controls without a policy and nothing but their hidden count under the managed policy', () => {
    expect(searchSettings('diagnostic', 'cloud-ready').flatMap((g) => g.rows.map((r) => r.id))).toEqual([
      'diagnostic-logging',
      'export-diagnostics'
    ])
    expect(hiddenSearchMatches('diagnostic', 'cloud-ready')).toEqual([])
    const managed = { policy: 'managed' } as const
    expect(searchSettings('diagnostic', 'cloud-ready', managed)).toEqual([])
    expect(hiddenSearchMatches('diagnostic', 'cloud-ready', managed).map((r) => r.id)).toEqual([
      'diagnostic-logging',
      'export-diagnostics'
    ])
  })
})

describe('capture matrix and manifest', () => {
  const cleanAudit = {
    pass: true,
    text: { checked: 1, failures: [] },
    nonText: { checked: 1, failures: [] },
    clipping: { checked: 1, failures: [] },
    unverifiable: []
  }

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

  it('records state, viewport, sha256 and commit for each image', () => {
    const bytes = new TextEncoder().encode('png-bytes')
    const manifest = buildManifest({
      commit: 'abc123',
      platform: 'darwin',
      shots: [
        {
          state: 'bar-idle',
          viewport: { width: 960, height: 640 },
          theme: 'light',
          scale: 1,
          motion: 'no-preference',
          file: 'a.png',
          bytes,
          audit: cleanAudit
        }
      ],
      negativeControl: { detected: true, kinds: ['clipping', 'nonText', 'text'] }
    })
    expect(manifest.commit).toBe('abc123')
    expect(manifest.entries).toEqual([
      {
        state: 'bar-idle',
        viewport: { width: 960, height: 640 },
        theme: 'light',
        scale: 1,
        motion: 'no-preference',
        file: 'a.png',
        sha256: sha256Hex(bytes),
        audit: cleanAudit
      }
    ])
    expect(manifest.entries[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.audit).toMatchObject({
      standard: AUDIT_STANDARD,
      failures: 0,
      text: { checked: 1, failures: 0 },
      nonText: { checked: 1, failures: 0 },
      clipping: { checked: 1, failures: 0 },
      unverifiable: 0,
      negativeControl: { detected: true, kinds: ['clipping', 'nonText', 'text'] }
    })
  })

  it('marks only reduced-motion shots as reproducible', () => {
    expect(
      buildManifest({
        commit: 'abc123',
        platform: 'darwin',
        shots: [],
        negativeControl: { detected: true, kinds: ['clipping', 'nonText', 'text'] }
      }).reproducibleMotions
    ).toEqual(['reduce'])
  })
})

describe('design-capture workflow', () => {
  const workflow = read('.github/workflows/design-capture.yml')

  it('runs on pull requests to integration when design-capture paths change and keeps dispatch support', () => {
    expect(workflow).toContain('  pull_request:\n    branches: [m2/integration]\n    paths:')
    expect(workflow).toContain('      - src/renderer/src/design-capture/**')
    expect(workflow).toContain('      - scripts/design/**')
    expect(workflow).toContain('      - .github/workflows/design-capture.yml')
    expect(workflow).toContain('  workflow_dispatch:')
    expect(workflow).not.toMatch(/\n  push:/)
  })

  it('captures on pull_request and always uploads the manifest artifact', () => {
    expect(workflow).not.toContain("if: github.event_name == 'workflow_dispatch'")
    expect(workflow).toContain('if: always()')
    expect(workflow).toContain('node scripts/design/capture-states.mjs out-design-capture')
  })
})

describe('png size check', () => {
  const png = (width: number, height: number): Buffer => {
    const b = Buffer.alloc(24)
    b.writeUInt32BE(0x89504e47, 0)
    b.writeUInt32BE(width, 16)
    b.writeUInt32BE(height, 20)
    return b
  }
  const viewport = { width: 960, height: 640 }

  it('reads the pixel size from the header', () => {
    expect(pngSize(png(1920, 1280))).toEqual({ width: 1920, height: 1280 })
  })

  it('accepts a shot at scale x viewport and rejects a silent 1x capture as 2x', () => {
    expect(() => assertPngSize(png(1920, 1280), viewport, 2, 'a.png')).not.toThrow()
    expect(() => assertPngSize(png(960, 640), viewport, 2, 'a.png')).toThrow(/expected 1920x1280, got 960x640/)
  })

  it("checks each state's own viewport x scale", () => {
    const narrow = DESIGN_CAPTURE_STATES.find((s) => s.id === 'S15-narrow')?.viewport
    const settings = DESIGN_CAPTURE_STATES.find((s) => s.id === 'S01-general')?.viewport
    if (!narrow || !settings) throw new Error('missing Settings states')
    expect(() => assertPngSize(png(720, 1440), narrow, 2, 'n.png')).not.toThrow()
    expect(() => assertPngSize(png(1760, 1600), settings, 2, 's.png')).not.toThrow()
    expect(() => assertPngSize(png(1760, 1600), narrow, 2, 'n.png')).toThrow(/expected 720x1440, got 1760x1600/)
    expect(() => assertPngSize(png(1920, 1280), settings, 2, 's.png')).toThrow(/expected 1760x1600, got 1920x1280/)
  })

  it('rejects bytes that are not a PNG', () => {
    expect(() => pngSize(Buffer.alloc(30))).toThrow(/Not a PNG/)
  })
})
