import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * MQA-234: whisper-asr-host.ts is the utilityProcess CHILD that owns the @huggingface/transformers stack
 * — process-isolated from sherpa-onnx (Parakeet, speaker-id), which stays in the main process. It reads
 * `process.parentPort` directly rather than importing 'electron' (that global only exists inside a real
 * Electron utilityProcess), so this suite needs no electron mock: just a fake port shaped like Electron's
 * MessagePortMain, installed on `process` BEFORE the module is imported (its top-level code wires
 * `port.on('message', ...)` and calls `port.start()` at import time).
 *
 * transformers is left un-mocked deliberately (see the 'reinstall guidance' test below): `require()`ing
 * the real package and letting it fail fast against an empty local-models directory (allowRemoteModels:
 * false) is the same no-network guarantee the pre-MQA-234 in-process test proved, now exercised at the
 * seam that actually owns the model load.
 */
class FakePort extends EventEmitter {
  readonly sent: Array<Record<string, unknown>> = []
  postMessage(msg: Record<string, unknown>): void {
    this.sent.push(msg)
  }
  start(): void {
    /* no-op — real MessagePortMain must be started before it delivers queued messages; the fake
     * delivers synchronously via EventEmitter.emit, so there is nothing to buffer. */
  }
}

let port: FakePort
let tempDir: string

beforeEach(() => {
  port = new FakePort()
  ;(process as unknown as { parentPort?: FakePort }).parentPort = port
  tempDir = mkdtempSync(join(tmpdir(), 'metis-asr-host-test-'))
})

afterEach(() => {
  delete (process as unknown as { parentPort?: FakePort }).parentPort
  rmSync(tempDir, { recursive: true, force: true })
})

/** vitest's module registry is per-file, not per-test — re-importing the SAME path without resetting it
 *  would hand back the already-evaluated module (with its 'message' listener bound to a PREVIOUS test's
 *  port, and its `asr`/`modelsPath` singletons already populated from a previous test). vi.resetModules()
 *  clears the registry so the static import below re-evaluates the module's top level fresh, against
 *  whichever fake port this test's beforeEach installed. */
async function loadHost(): Promise<void> {
  vi.resetModules()
  await import('./whisper-asr-host')
}

function lastMessage(): Record<string, unknown> {
  return port.sent[port.sent.length - 1]
}

async function waitForMessageCount(min: number): Promise<void> {
  for (let i = 0; i < 200 && port.sent.length < min; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('whisper-asr-host — the isolated transformers child (MQA-234)', () => {
  it('replies ready to an init message, naming the transcription tier it resolved (MQA-246)', async () => {
    await loadHost()
    port.emit('message', { data: { type: 'init', modelsPath: tempDir } })
    // tempDir holds no model directories, so the probe falls to the bundled floor — which is exactly the
    // shipped condition (the high tier is not in the package) and must be reported as a degradation
    // rather than passed off as the best available.
    expect(lastMessage()).toEqual({ type: 'ready', tier: 'Xenova/whisper-base', degraded: true })
  })

  it('is inert (never throws) when process.parentPort is absent — a stray node invocation or a plain import', async () => {
    delete (process as unknown as { parentPort?: FakePort }).parentPort
    await expect(loadHost()).resolves.toBeUndefined()
  })

  // MQA-235's vad-v1 pipeline calls `deps.transcribe` per VAD window and expects a rejection it can
  // retry-once and eventually surface as a job failure, not an unhandled crash of the whisper child. This
  // proves the seam that guarantee ultimately rests on: a transcribe request against a models directory
  // with nothing in it fails FAST (no network attempt — allowRemoteModels stays false) with a message an
  // end user can act on, mirroring parakeet.ts's/the pre-MQA-234 whisper-import.ts reinstall-guidance
  // pattern rather than leaking transformers.js's internal `local_files_only` wording.
  it('a transcribe against an empty models dir fails fast with reinstall guidance, no network use (MQA-234, MQA-235)', async () => {
    await loadHost()
    port.emit('message', { data: { type: 'init', modelsPath: tempDir } })
    port.emit('message', { data: { type: 'transcribe', id: 1, pcm: new Float32Array(16_000).buffer } })

    await waitForMessageCount(2)

    const msg = lastMessage()
    expect(msg).toMatchObject({ type: 'error', id: 1 })
    expect(String(msg.message)).toMatch(/Reinstall Métis/)
  }, 20_000)

  it('never imports sherpa — the whole point of process isolation is that this child never touches it (MQA-234)', () => {
    const src = readFileSync(join(__dirname, 'whisper-asr-host.ts'), 'utf8')
    // The file's own comments discuss sherpa at length (why the isolation exists) — what must never
    // appear is an actual import/require of it, so match only real module-load statements.
    expect(src).not.toMatch(/(?:from\s+['"]|require\(\s*['"])[^'"]*sherpa/i)
  })

  it('MODEL_TIERS prefers large-v3-turbo before whisper-base', () => {
    const src = readFileSync(join(__dirname, 'whisper-asr-host.ts'), 'utf8')
    const tiersBlock = src.slice(src.indexOf('const MODEL_TIERS'), src.indexOf('const MODEL_REVISION'))
    const turboIdx = tiersBlock.indexOf('whisper-large-v3-turbo')
    const baseIdx = tiersBlock.indexOf('Xenova/whisper-base')
    expect(turboIdx).toBeGreaterThan(-1)
    expect(baseIdx).toBeGreaterThan(-1)
    expect(turboIdx).toBeLessThan(baseIdx)
  })
})

describe('MQA-246 — an import must not silently run on the floor transcription model', () => {
  const src = readFileSync(join(__dirname, 'whisper-asr-host.ts'), 'utf8')
  const importer = readFileSync(join(__dirname, 'whisper-import.ts'), 'utf8')
  const settingsUi = readFileSync(join(__dirname, '..', 'renderer', 'src', 'components', 'Settings.tsx'), 'utf8')

  it('the ready message names the tier it resolved, and whether that is a degradation', () => {
    // Resolvable at init because the tier is decided by file presence alone — the model load is lazy, so
    // reporting it only after loading would mean the first import is already running before anyone knows.
    expect(src).toMatch(/function resolveTier\(dir: string \| null\)/)
    expect(src).toMatch(/type: 'ready', tier: readyTier\.id, degraded: readyTier\.id !== MODEL_TIERS\[0\]\.id/)
  })

  it('a degraded tier is recorded where the user can actually see it', () => {
    // The fallback is by design; the silence was the defect. Same after-the-fact contract the live
    // engine-swap note already uses — never a live banner mid-import.
    expect(importer).toMatch(/asrImportTierFallbackAt/)
    expect(importer).toMatch(/if \(m\.degraded\)/)
    expect(settingsUi).toMatch(/settings\.asrImportTierFallbackAt != null/)
    expect(settingsUi).toMatch(/asrImportTierFallbackAt: null/) // dismissable, like its siblings
  })

  it('the note is written once, not re-stamped on every import', () => {
    expect(importer).toMatch(/getSettings\(\)\.asrImportTierFallbackAt == null/)
  })
})

describe('MQA-247 — the fetched high tier must actually win over the bundled floor', () => {
  const hostSrc = readFileSync(join(__dirname, 'whisper-asr-host.ts'), 'utf8')
  it('reports the high tier, not degraded, when it exists in the FETCHED root only', async () => {
    // The whole point of the feature: the packaged resources directory can never hold this model, so if
    // the probe only ever searched that root the 1.61 GB fetch would land in a directory nothing reads.
    const fetched = mkdtempSync(join(tmpdir(), 'metis-asr-fetched-'))
    try {
      mkdirSync(join(fetched, 'onnx-community', 'whisper-large-v3-turbo'), { recursive: true })
      await loadHost()
      port.emit('message', { data: { type: 'init', modelsPath: tempDir, fetchedModelsPath: fetched } })
      expect(lastMessage()).toEqual({
        type: 'ready',
        tier: 'onnx-community/whisper-large-v3-turbo',
        degraded: false
      })
    } finally {
      rmSync(fetched, { recursive: true, force: true })
    }
  })

  it('falls back to the floor and says so when the fetched root is absent or empty', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'metis-asr-empty-'))
    try {
      await loadHost()
      port.emit('message', { data: { type: 'init', modelsPath: tempDir, fetchedModelsPath: empty } })
      expect(lastMessage()).toEqual({ type: 'ready', tier: 'Xenova/whisper-base', degraded: true })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('the loader is pointed at the root the tier was found in, not unconditionally at the package', () => {
    // Selecting the fetched tier and then loading from the packaged root would find nothing — a failure
    // that looks like a corrupt download rather than a wiring bug, so it is pinned against source.
    expect(hostSrc).toMatch(/env\.localModelPath = root \?\? modelsPath/)
    expect(hostSrc).toMatch(/function tierAndRoot\(dir: string \| null\)/)
  })
})
