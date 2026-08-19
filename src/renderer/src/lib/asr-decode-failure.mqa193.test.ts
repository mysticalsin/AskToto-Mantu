/**
 * asr-decode-failure.mqa193.test.ts — MQA-193.
 *
 * A per-window Whisper decode failure painted the raw transformers.js/onnxruntime exception
 * ("Aborted(). Build with -sASSERTIONS for more info.", "RuntimeError: memory access out of bounds")
 * into the live-meeting danger banner, and left it there. Two halves:
 *
 *  1. whisper.worker.ts's decode catch posted `{type:'error', message: err.message}` — the exact thing
 *     the load-failure branch two screens above refuses to do, under a comment saying the raw text "is
 *     meaningless to a user mid-meeting". The banner has no dismiss control.
 *  2. Nothing retracted it. listen.ts's 'text' handler never touched `error`, and the 'ready' handler
 *     clears only the offline/reconnecting notes — so a single bad 6s window sat on screen for the rest
 *     of the meeting while every subsequent window transcribed fine.
 *
 * The worker half is exercised for real (the file's own harness: a fake `self`, a mocked transformers
 * pipeline). The listen half is a pure decision plus a structural pin on the wiring — vitest runs the
 * `node` environment with no jsdom in this repo, so the hook itself cannot be rendered.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteAfterDecodedWindow } from './listen'

const transformers = vi.hoisted(() => ({
  pipeline: vi.fn(),
  env: {
    allowRemoteModels: true,
    allowLocalModels: false,
    localModelPath: '',
    useBrowserCache: false,
    backends: { onnx: { wasm: { wasmPaths: 'https://cdn.example.invalid/ort/' } } }
  }
}))

vi.mock('@huggingface/transformers', () => transformers)

type FakeWorker = {
  navigator: Record<string, unknown>
  postMessage: ReturnType<typeof vi.fn>
  onmessage?: (event: MessageEvent) => Promise<void>
}

/** The engine-internal text a WASM fault actually surfaces — never fit for a live-meeting banner. */
const WASM_FAULT = 'Aborted(). Build with -sASSERTIONS for more info.'

describe('MQA-193 — a failed audio window never puts engine text in the live banner', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transformers.env.allowRemoteModels = true
    transformers.env.allowLocalModels = false
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  async function decodeFailure(): Promise<FakeWorker> {
    const worker: FakeWorker = { navigator: {}, postMessage: vi.fn(), onmessage: undefined }
    vi.stubGlobal('self', worker)
    const asrFn = vi.fn().mockRejectedValue(new Error(WASM_FAULT))
    transformers.pipeline.mockResolvedValueOnce(asrFn)

    await import('./whisper.worker')
    await worker.onmessage?.({ data: { type: 'init', quality: 'fast', bundled: false } } as MessageEvent)
    worker.postMessage.mockClear() // drop the 'ready' post — only the decode reply is under test
    await worker.onmessage?.({
      data: { type: 'audio', audio: new Float32Array(16), speaker: 'them' }
    } as MessageEvent)
    return worker
  }

  it('keeps the raw exception in a log post, the way the load-failure branch already does', async () => {
    const worker = await decodeFailure()
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'log', message: expect.stringContaining(WASM_FAULT) })
    )
  })

  it('surfaces a human line instead of the exception, and says only what is true', async () => {
    const worker = await decodeFailure()
    const errors = worker.postMessage.mock.calls
      .map(([m]) => m as { type: string; message?: string })
      .filter((m) => m.type === 'error')
    expect(errors).toHaveLength(1)
    // The bug verbatim: the WASM fault text was the user-facing message.
    expect(errors[0].message).not.toContain(WASM_FAULT)
    expect(errors[0].message).not.toMatch(/aborted|assertions|memory access|runtimeerror/i)
    // It must name the real consequence (a gap in the transcript) and the real state (still running) —
    // the next window decodes normally, so "transcription stopped" would be a lie in the other direction.
    expect(errors[0].message).toMatch(/could not be transcribed/i)
    expect(errors[0].message).toMatch(/continuing/i)
  })

  it('still replies exactly once so the renderer queue is never wedged', async () => {
    const worker = await decodeFailure()
    const terminal = worker.postMessage.mock.calls
      .map(([m]) => m as { type: string })
      .filter((m) => m.type === 'error' || m.type === 'text')
    expect(terminal).toHaveLength(1)
  })
})

describe('MQA-193 — a decoded window retracts the transient decode note and nothing else', () => {
  const DECODE_NOTE = 'Part of the audio could not be transcribed. Transcription is continuing.'

  it('clears the note the failed window put up', () => {
    expect(noteAfterDecodedWindow(DECODE_NOTE, DECODE_NOTE)).toBeNull()
  })

  it('never clobbers an unrelated sticky note that happens to be on screen', () => {
    const micLost = 'Microphone input stopped (device disconnected or sleep); reconnecting automatically…'
    const themSilent = 'Not hearing the other side. Check the call volume and that Screen Recording is granted.'
    expect(noteAfterDecodedWindow(micLost, DECODE_NOTE)).toBe(micLost)
    expect(noteAfterDecodedWindow(themSilent, DECODE_NOTE)).toBe(themSilent)
  })

  it('is a no-op when no decode note is outstanding, or the banner is already clear', () => {
    const other = 'Transcription fell behind, so some audio was skipped. The transcript may have gaps.'
    expect(noteAfterDecodedWindow(other, null)).toBe(other)
    expect(noteAfterDecodedWindow(null, DECODE_NOTE)).toBeNull()
    expect(noteAfterDecodedWindow(null, null)).toBeNull()
  })
})

describe('MQA-193 — wiring', () => {
  const source = readFileSync(join(__dirname, 'listen.ts'), 'utf8').replace(/\r\n/g, '\n')

  function blockBetween(start: string, end: string): string {
    const from = source.indexOf(start)
    if (from === -1) throw new Error(`asr-decode-failure.mqa193 anchor not found (source moved?): ${start}`)
    const to = source.indexOf(end, from + start.length)
    if (to === -1) throw new Error(`asr-decode-failure.mqa193 end anchor not found after "${start}": ${end}`)
    return source.slice(from, to)
  }

  it('remembers the per-window note only when the model was already loaded', () => {
    const block = blockBetween("} else if (m.type === 'error') {", "} else if (m.type === 'text') {")
    // readyRef true == armNetworkRetry declined it as a per-window failure, not a load failure. A load
    // failure must stay sticky — there is nothing to recover from on the next window.
    expect(block).toMatch(/readyRef\.current/)
    expect(block).toMatch(/decodeNoteRef\.current = /)
  })

  it('retracts it on the next window that decodes', () => {
    const block = blockBetween("} else if (m.type === 'text') {", 'w.onerror')
    expect(block).toMatch(/noteAfterDecodedWindow\(/)
    expect(block).toMatch(/decodeNoteRef\.current = null/)
  })
})
