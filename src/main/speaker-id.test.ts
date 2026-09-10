import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mutable so the parakeet suite below can flip to the packaged layout (resourcesPath) without a second
// mock registration — vi.mock is hoisted per file, one electron stub has to serve both suites.
const electron = vi.hoisted(() => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('electron', () => electron)
vi.mock('./logger', () => ({
  mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auditLog: vi.fn()
}))

import { createSpeakerId, isEchoBleed } from './speaker-id'

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

describe('isEchoBleed — pure cosine-threshold check', () => {
  it('is true for an identical voice, false for an orthogonal one', () => {
    const a = Float32Array.from([1, 0, 0])
    const b = Float32Array.from([1, 0, 0])
    const c = Float32Array.from([0, 1, 0])
    expect(isEchoBleed(a, b)).toBe(true)
    expect(isEchoBleed(a, c)).toBe(false)
  })

  it('never fires when no operator centroid exists yet (degrade-to-off, not a throw)', () => {
    expect(isEchoBleed(Float32Array.from([1, 0]), null)).toBe(false)
  })

  it('a near-miss below ECHO_THRESHOLD (~0.7) does not count as echo', () => {
    // Same magnitude on the shared axis, enough off-axis energy to land the cosine below 0.7.
    const a = Float32Array.from([1, 0, 0])
    const b = Float32Array.from([0.6, 0.8, 0])
    expect(isEchoBleed(a, b)).toBe(false)
  })
})

describe('echo defense — operator buffer + THEM-window echo detection', () => {
  it('flags a THEM window that matches the live (this-session) operator buffer', () => {
    const id = makeId(dir)
    id.observeOperatorWindow(windowFor(3)) // a 'you' (mic) window seeds the operator's own voiceprint
    expect(id.labelWindow(windowFor(3))).toMatchObject({ echo: true })
  })

  it('does not over-trigger on a genuinely different voice', () => {
    const id = makeId(dir)
    id.observeOperatorWindow(windowFor(3))
    const label = id.labelWindow(windowFor(5))
    expect(label?.echo).toBeFalsy()
    expect(label).toMatchObject({ source: 'cluster', name: 'Speaker 1' })
  })

  it('an echo-flagged window is never clustered (would poison Speaker N with the operator)', () => {
    const id = makeId(dir)
    id.observeOperatorWindow(windowFor(3))
    id.labelWindow(windowFor(3)) // echo — must be a no-op for clustering
    // The next genuinely-new voice still opens "Speaker 1", proving no cluster was created above.
    expect(id.labelWindow(windowFor(5))).toMatchObject({ name: 'Speaker 1', source: 'cluster' })
  })

  it('degrades to no echo defense when the operator has no samples yet', () => {
    const id = makeId(dir)
    expect(id.labelWindow(windowFor(3))).toMatchObject({ source: 'cluster' })
  })

  it('resetSession clears the in-memory operator buffer (meeting boundary)', () => {
    const id = makeId(dir)
    id.observeOperatorWindow(windowFor(3))
    expect(id.labelWindow(windowFor(3))).toMatchObject({ echo: true })
    id.resetSession()
    expect(id.labelWindow(windowFor(3))?.echo).toBeFalsy()
  })

  it('resetSession flushes a well-populated operator buffer into a persisted profile (meeting boundary)', () => {
    const id = makeId(dir)
    id.observeOperatorWindow(windowFor(3))
    id.observeOperatorWindow(windowFor(3))
    id.observeOperatorWindow(windowFor(3))
    id.resetSession()
    // Internal-only: the operator's own voiceprint never shows up as a "person" a user could see/delete.
    const fresh = makeId(dir)
    expect(fresh.listProfiles()).toEqual([])
    expect(fresh.labelWindow(windowFor(3))).toMatchObject({ echo: true })
  })

  it('does not persist an operator profile from a too-short session (quality gate)', () => {
    const id = makeId(dir)
    id.observeOperatorWindow(windowFor(3))
    id.resetSession()
    const fresh = makeId(dir)
    expect(fresh.labelWindow(windowFor(3))?.echo).toBeFalsy()
  })

  it('the reserved operator profile name can never be deleted through the public API', () => {
    const id = makeId(dir)
    id.observeOperatorWindow(windowFor(3))
    id.observeOperatorWindow(windowFor(3))
    id.observeOperatorWindow(windowFor(3))
    id.resetSession()
    expect(id.deleteProfile('__operator__')).toBe(false)
  })
})

describe('autoEnrollFromLabeledWindows — Teams-VTT auto-enrollment flywheel (P2 §3.4)', () => {
  it('folds a well-populated live cluster into a permanent voiceprint under the resolved name', () => {
    const id = makeId(dir)
    for (let i = 0; i < 4; i++) id.labelWindow(windowFor(2)) // populates the "Speaker 1" embedding buffer
    const enrolled = id.autoEnrollFromLabeledWindows([{ clusterLabel: 'Speaker 1', name: 'Jane Doe' }])
    expect(enrolled).toBe(1)
    expect(id.listProfiles()).toEqual([{ name: 'Jane Doe', samples: 4 }])
    // The very next window from the same voice is now recognized by profile, not by cluster.
    expect(id.labelWindow(windowFor(2))).toMatchObject({ name: 'Jane Doe', source: 'profile' })
  })

  it('skips a cluster below the quality gate (fewer than 3 buffered windows)', () => {
    const id = makeId(dir)
    id.labelWindow(windowFor(2))
    id.labelWindow(windowFor(2))
    expect(id.autoEnrollFromLabeledWindows([{ clusterLabel: 'Speaker 1', name: 'Jane Doe' }])).toBe(0)
    expect(id.listProfiles()).toEqual([])
  })

  it('skips a cluster label with no buffered embeddings at all (stale/unknown label)', () => {
    const id = makeId(dir)
    expect(id.autoEnrollFromLabeledWindows([{ clusterLabel: 'Speaker 9', name: 'Nobody' }])).toBe(0)
  })

  it('ignores a blank resolved name', () => {
    const id = makeId(dir)
    for (let i = 0; i < 4; i++) id.labelWindow(windowFor(2))
    expect(id.autoEnrollFromLabeledWindows([{ clusterLabel: 'Speaker 1', name: '   ' }])).toBe(0)
  })

  it('returns the count of names actually enrolled across several pairs', () => {
    const id = makeId(dir)
    for (let i = 0; i < 4; i++) id.labelWindow(windowFor(2)) // "Speaker 1"
    for (let i = 0; i < 4; i++) id.labelWindow(windowFor(5)) // "Speaker 2"
    const enrolled = id.autoEnrollFromLabeledWindows([
      { clusterLabel: 'Speaker 1', name: 'Jane Doe' },
      { clusterLabel: 'Speaker 2', name: 'Bob Smith' }
    ])
    expect(enrolled).toBe(2)
    expect(new Set(id.listProfiles().map((p) => p.name))).toEqual(new Set(['Jane Doe', 'Bob Smith']))
  })
})

describe('speaker:embed — the Whisper-engine speaker-embedding tap (contract)', () => {
  // index.ts has no unit harness (see MQA-043's test above), so this pins the wiring against the source.
  const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const preloadSrc = readFileSync(join(__dirname, '..', 'preload', 'index.ts'), 'utf8')

  it('the IPC channel name exists and follows the parakeetFeed/appleSpeechFeed naming convention', () => {
    const ipcSrc = readFileSync(join(__dirname, '..', 'shared', 'ipc.ts'), 'utf8')
    expect(ipcSrc).toMatch(/speakerEmbed: 'speaker:embed'/)
  })

  it('the handler returns a best-effort { name?, echo? } shape, gated on Float32Array + size, and flags echo', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.speakerEmbed')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 2500)
    expect(body).toMatch(/if \(!\(p\?\.samples instanceof Float32Array\)\) return \{\}/)
    expect(body).toMatch(/if \(p\.samples\.length > 16_000 \* 30\) return \{\}/)
    // 70 wires getSpeakerId().labelWindow; 58 wraps the same call as labelThemAudio. Accept either
    // until index.ts is unioned — both reach speaker-id.labelWindow.
    expect(body).toMatch(/getSpeakerId\(\)\.labelWindow\(p\.samples\)|labelThemAudio\(p\.samples\)/)
    // Echo must surface as echo:true so the renderer can drop the already-committed Whisper THEM line
    // (silent skip used to leave operator loopback bleed labeled as THEM).
    expect(body).toMatch(/if \(label\?\.echo\) return \{ echo: true/)
    expect(body).toMatch(/if \(label\) return \{ name: label\.name \}/)
    expect(body).toMatch(/observeOperatorWindow\(p\.samples\)|observeOperatorAudio\(p\.samples\)/)
    expect(body).toMatch(/return \{\}\s*\n\s*\}\)/)
  })

  it('the preload bridges it with the same {samples, speaker} payload shape as parakeetFeed', () => {
    expect(preloadSrc).toMatch(
      /speakerEmbed: \(samples: Float32Array, speaker: string\): Promise<\{ name\?: string; echo\?: boolean \}> =>\s*\n\s*ipcRenderer\.invoke\(IPC\.speakerEmbed, \{ samples, speaker \}\)/
    )
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

/** MQA-042 now terminates an isolated native helper instead of forcing V8 GC in main. Detailed
 * lifecycle behavior is covered by parakeet-client.test.ts; this pins the real meeting boundary. */
describe('parakeetRelease at a meeting boundary (MQA-042)', () => {
  const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

  it('awaits helper exit when listening stops', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.listeningState')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 3_000)
    expect(body).toMatch(/else\s*\{\s*await parakeetRelease\(\)/)
  })
})

// MQA-043 (docs/qa/BUG-LEDGER.md): resetSession() was unit-tested but had NO production caller, so the
// >30min silence gap was the only thing that ever reset session labels. Two meetings closer together
// than that shared cluster identities — a new participant in meeting two could be labelled "Speaker 3"
// because two different people had spoken in meeting one. The meeting-start boundary (IPC.listeningState
// with on=true, the same place the Dust conversation resets) must clear it. index.ts has no unit
// harness, so this pins the wiring against the source, next to the reset it belongs beside.
describe('the meeting-start boundary resets speaker session labels (MQA-043)', () => {
  const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

  it('calls resetSession() at the listeningState meeting-start boundary', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.listeningState')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 2000)
    expect(body).toMatch(/if \(on\) \{[\s\S]{0,800}?speakerIdInstance\?\.resetSession\(\)/)
  })

  it('resets it alongside the Dust conversation — one boundary, not two competing ones', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.listeningState')
    const body = indexSrc.slice(start, start + 2000)
    expect(body.indexOf('resetDustConversation()')).toBeLessThan(body.indexOf('speakerIdInstance?.resetSession()'))
  })
})

describe('MQA-237 — embeddings must never use N-API external buffers (dead-in-Electron class)', () => {
  it('compute is called with enableExternalBuffer=false', () => {
    // Electron's main process forbids external ArrayBuffers; sherpa's default wraps its output in one,
    // which threw on every window and killed Speaker Intelligence silently since it shipped — these
    // plain-node tests passed the whole time, which is exactly why the pin is structural.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const src = readFileSync(join(__dirname, 'speaker-id.ts'), 'utf8')
    expect(src).toMatch(/extractor\.compute\(stream, false\)/)
    expect(src).not.toMatch(/extractor\.compute\(stream\)/)
  })
})
