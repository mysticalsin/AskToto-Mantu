import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('./logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

import { createSpeakerId } from './speaker-id'

/** Fake extractor: derives the "embedding" from the first sample value — window [v, ...] becomes a
 *  one-hot-ish vector along axis v, so tests choose voices by constructing windows. */
function fakeExtractor() {
  return {
    compute: (samples: Float32Array): Float32Array | null => {
      if (samples.length === 0) return null
      const v = new Float32Array(8)
      v[Math.round(samples[0])] = 1
      v[7] = 0.1 // small shared component so similarities are non-trivial
      return v
    }
  }
}

function windowFor(axis: number): Float32Array {
  return Float32Array.from([axis, 0.5, 0.5])
}

function makeId(dir: string, opts: { extractor?: ReturnType<typeof fakeExtractor> | null; now?: () => number } = {}) {
  return createSpeakerId({
    createExtractor: () => (opts.extractor === undefined ? fakeExtractor() : opts.extractor),
    storePath: () => join(dir, 'voiceprints.json'),
    now: opts.now
  })
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'speaker-id-'))
})

describe('labelWindow', () => {
  it('labels un-enrolled voices with stable session cluster names', () => {
    const id = makeId(dir)
    expect(id.labelWindow(windowFor(0))).toMatchObject({ name: 'Speaker 1', source: 'cluster' })
    expect(id.labelWindow(windowFor(3))).toMatchObject({ name: 'Speaker 2', source: 'cluster' })
    expect(id.labelWindow(windowFor(0))).toMatchObject({ name: 'Speaker 1' })
  })

  it('prefers an enrolled profile over a cluster label once the voice is known', () => {
    const id = makeId(dir)
    expect(id.enroll('Jane Doe', [windowFor(2), windowFor(2)])).toBe(true)
    const label = id.labelWindow(windowFor(2))
    expect(label).toMatchObject({ name: 'Jane Doe', source: 'profile' })
    expect(label!.similarity).toBeGreaterThanOrEqual(0.55)
    // A different voice still clusters.
    expect(id.labelWindow(windowFor(5))).toMatchObject({ source: 'cluster' })
  })

  it('profiles persist across instances (the voice memory survives restarts)', () => {
    makeId(dir).enroll('Jane Doe', [windowFor(2)])
    const fresh = makeId(dir)
    expect(fresh.listProfiles()).toEqual([{ name: 'Jane Doe', samples: 1 }])
    expect(fresh.labelWindow(windowFor(2))).toMatchObject({ name: 'Jane Doe', source: 'profile' })
  })

  it('re-enrolling reinforces the profile (sample counts accumulate)', () => {
    const id = makeId(dir)
    id.enroll('Jane Doe', [windowFor(2)])
    id.enroll('Jane Doe', [windowFor(2), windowFor(2)])
    expect(id.listProfiles()).toEqual([{ name: 'Jane Doe', samples: 3 }])
  })

  it('deleteProfile removes the voiceprint (privacy contract)', () => {
    const id = makeId(dir)
    id.enroll('Jane Doe', [windowFor(2)])
    expect(id.deleteProfile('Jane Doe')).toBe(true)
    expect(id.listProfiles()).toEqual([])
    expect(id.labelWindow(windowFor(2))).toMatchObject({ source: 'cluster' })
    expect(id.deleteProfile('nobody')).toBe(false)
  })

  it('a >30min silence gap resets session labels (new meeting), enrolled names survive', () => {
    let t = 1_000_000
    const id = makeId(dir, { now: () => t })
    id.enroll('Jane Doe', [windowFor(2)])
    expect(id.labelWindow(windowFor(0))!.name).toBe('Speaker 1')
    t += 31 * 60_000
    expect(id.labelWindow(windowFor(5))!.name).toBe('Speaker 1') // numbering restarted
    expect(id.labelWindow(windowFor(2))!.name).toBe('Jane Doe') // profiles unaffected
  })

  it('degrades to null when no extractor is available — transcription must never notice', () => {
    const id = makeId(dir, { extractor: null })
    expect(id.available()).toBe(false)
    expect(id.labelWindow(windowFor(0))).toBeNull()
    expect(id.enroll('X', [windowFor(0)])).toBe(false)
  })

  it('degenerate windows (empty audio) yield null, never a poisoned cluster', () => {
    const id = makeId(dir)
    expect(id.labelWindow(new Float32Array(0))).toBeNull()
    expect(id.labelWindow(windowFor(0))!.name).toBe('Speaker 1')
  })
})

describe('real sherpa integration (soft-skip when model/addon absent)', () => {
  it('extracts a 512-dim embedding through the real extractor and labels a window', async () => {
    const { existsSync } = await import('node:fs')
    const modelPresent = existsSync(join(process.cwd(), 'resources', 'models', 'speaker', 'embedding.onnx'))
    if (!modelPresent) {
      console.warn('[speaker-id it] skipped — embedding.onnx not provisioned (run scripts/fetch-speaker-model.mjs)')
      return
    }
    // No injected extractor: createSpeakerId builds the real sherpa one (repo-root model resolution).
    const id = createSpeakerId({ storePath: () => join(dir, 'voiceprints.json') })
    if (!id.available()) {
      console.warn('[speaker-id it] skipped — sherpa addon unavailable on this machine')
      return
    }
    const n = 16000 * 2
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 140 * i) / 16000)
    const label = id.labelWindow(samples)
    expect(label).not.toBeNull()
    expect(label!.name).toBe('Speaker 1')
    // Same audio again lands in the same cluster — the stability contract.
    expect(id.labelWindow(samples)!.name).toBe('Speaker 1')
  }, 60_000)
})
