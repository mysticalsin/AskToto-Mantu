import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('Whisper worker bundled mode', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transformers.env.allowRemoteModels = true
    transformers.env.allowLocalModels = false
    transformers.env.localModelPath = ''
    // Neutral/untouched starting value — the opposite of the bundled path's expected `false`, so those
    // tests actually prove the 'init' handler sets it rather than merely leaving a fixture default alone.
    transformers.env.useBrowserCache = true
    transformers.env.backends.onnx.wasm.wasmPaths = 'https://cdn.example.invalid/ort/'
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('makes one local attempt and never retries remotely when bundled assets fail to load', async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    const fetchSpy = vi.fn()
    vi.stubGlobal('self', worker)
    vi.stubGlobal('fetch', fetchSpy)
    transformers.pipeline.mockRejectedValueOnce(new Error('missing local tokenizer'))

    await import('./whisper.worker')
    await worker.onmessage?.({ data: { type: 'init', quality: 'best', bundled: true } } as MessageEvent)

    expect(transformers.env.allowRemoteModels).toBe(false)
    expect(transformers.env.allowLocalModels).toBe(true)
    expect(transformers.env.localModelPath).toBe('asr-model://models')
    expect(transformers.env.backends.onnx.wasm.wasmPaths).toBe('asr-model://ort/')
    // Chromium's Cache Storage API only recognizes http(s) requests, so leaving the browser cache on for
    // the asr-model:// bundled path only produced dead "Request scheme 'asr-model' is unsupported" spam
    // on every load — the bundled path also gains nothing from it (every file is already local disk).
    expect(transformers.env.useBrowserCache).toBe(false)
    expect(transformers.pipeline).toHaveBeenCalledTimes(1)
    expect(transformers.pipeline).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'Xenova/whisper-base',
      expect.objectContaining({ dtype: 'q8', revision: 'main' })
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringMatching(/Reinstall Métis/) })
    )
  })

  it('ignores a remote-mode request in production and still initializes from bundled assets', async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    vi.stubEnv('PROD', 'true')
    vi.stubGlobal('self', worker)
    transformers.pipeline.mockResolvedValueOnce({})

    await import('./whisper.worker')
    await worker.onmessage?.({ data: { type: 'init', quality: 'fast', bundled: false } } as MessageEvent)

    expect(transformers.env.allowRemoteModels).toBe(false)
    expect(transformers.env.allowLocalModels).toBe(true)
    expect(transformers.env.localModelPath).toBe('asr-model://models')
    expect(transformers.env.useBrowserCache).toBe(false)
    expect(transformers.pipeline).toHaveBeenCalledTimes(1)
    expect(transformers.pipeline).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'Xenova/whisper-base',
      expect.objectContaining({ dtype: 'q8', revision: 'main' })
    )
  })

  it('only enables the browser cache for the dev-only remote fallback (never the bundled path)', async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    // Deliberately does NOT stub PROD: vi.stubEnv writes a non-empty string, and even 'false' is truthy
    // in the `production || ...` check inside shouldUseBundledAsr, so the only way to actually exercise
    // its "not production" branch is to leave import.meta.env.PROD at Vitest's own (falsy) test default —
    // same as the sibling "makes one local attempt…" test above, which also never touches PROD.
    vi.stubGlobal('self', worker)
    transformers.pipeline.mockResolvedValueOnce({})

    await import('./whisper.worker')
    await worker.onmessage?.({ data: { type: 'init', quality: 'fast', bundled: false } } as MessageEvent)

    expect(transformers.env.allowRemoteModels).toBe(true)
    expect(transformers.env.allowLocalModels).toBe(false)
    expect(transformers.env.useBrowserCache).toBe(true)
  })
})
