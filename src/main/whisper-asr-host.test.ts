import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  it('replies ready to an init message', async () => {
    await loadHost()
    port.emit('message', { data: { type: 'init', modelsPath: tempDir } })
    expect(lastMessage()).toEqual({ type: 'ready' })
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
