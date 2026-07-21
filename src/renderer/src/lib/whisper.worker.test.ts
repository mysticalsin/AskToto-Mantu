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

  it('pins the decoder to the init language and never asks for translation', async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    vi.stubGlobal('self', worker)
    const asrFn = vi.fn().mockResolvedValue({ text: 'olá, tudo bem' })
    transformers.pipeline.mockResolvedValueOnce(asrFn)

    await import('./whisper.worker')
    await worker.onmessage?.({
      data: { type: 'init', quality: 'fast', bundled: false, language: 'Portuguese' }
    } as MessageEvent)
    const audio = new Float32Array(16)
    await worker.onmessage?.({ data: { type: 'audio', audio, speaker: 'them' } } as MessageEvent)

    expect(asrFn).toHaveBeenCalledWith(
      audio,
      expect.objectContaining({ return_timestamps: false, language: 'portuguese', task: 'transcribe' })
    )
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'text', text: 'olá, tudo bem', speaker: 'them' })
  })

  it("decodes with auto-detect (no language option) for 'auto' and for names Whisper does not know", async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    vi.stubGlobal('self', worker)
    const asrFn = vi.fn().mockResolvedValue({ text: 'hello' })
    transformers.pipeline.mockResolvedValueOnce(asrFn)

    await import('./whisper.worker')
    // An unknown value (stale setting, managed-config garbage) must degrade to auto-detect, not throw
    // mid-meeting inside transformers.js.
    await worker.onmessage?.({
      data: { type: 'init', quality: 'fast', bundled: false, language: 'Klingon' }
    } as MessageEvent)
    await worker.onmessage?.({ data: { type: 'audio', audio: new Float32Array(16), speaker: 'you' } } as MessageEvent)

    expect(asrFn).toHaveBeenCalledTimes(1)
    expect(asrFn.mock.calls[0][1]).toEqual({ return_timestamps: false })
  })

  it('updates the language on a warm worker: a later init re-pins decoding without reloading the model', async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    vi.stubGlobal('self', worker)
    const asrFn = vi.fn().mockResolvedValue({ text: 'x' })
    transformers.pipeline.mockResolvedValueOnce(asrFn)

    await import('./whisper.worker')
    // Prewarm-style init carries no language…
    await worker.onmessage?.({ data: { type: 'init', quality: 'fast', bundled: false } } as MessageEvent)
    // …then the session init on the already-loaded worker carries the user's spoken language. The model
    // must NOT reload (single pipeline call) but the next decode must be pinned.
    await worker.onmessage?.({
      data: { type: 'init', quality: 'fast', bundled: false, language: 'Portuguese' }
    } as MessageEvent)
    await worker.onmessage?.({ data: { type: 'audio', audio: new Float32Array(16), speaker: 'you' } } as MessageEvent)

    expect(transformers.pipeline).toHaveBeenCalledTimes(1)
    expect(asrFn.mock.calls[0][1]).toEqual(
      expect.objectContaining({ language: 'portuguese', task: 'transcribe' })
    )
  })

  it('probes without the pin every 4th window so a real language switch can be noticed', async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    vi.stubGlobal('self', worker)
    // Text with no confident language signal: the follow machine must not move, so the cadence is pure.
    const asrFn = vi.fn().mockResolvedValue({ text: 'hmm hmm okay' })
    transformers.pipeline.mockResolvedValueOnce(asrFn)

    await import('./whisper.worker')
    await worker.onmessage?.({
      data: { type: 'init', quality: 'fast', bundled: false, language: 'Portuguese' }
    } as MessageEvent)
    for (let i = 0; i < 5; i++) {
      await worker.onmessage?.({ data: { type: 'audio', audio: new Float32Array(16), speaker: 'you' } } as MessageEvent)
    }

    const langs = asrFn.mock.calls.map((c) => c[1].language)
    expect(langs).toEqual(['portuguese', 'portuguese', 'portuguese', undefined, 'portuguese'])
  })

  it('follows a mid-meeting language switch: probe detects it, one confirmation re-pins the decoder', async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    vi.stubGlobal('self', worker)
    const pt = 'então vamos ver isso com você, não é, para fechar o contrato'
    const en = 'so we are going to talk about the budget and the plan for the team'
    const asrFn = vi.fn()
    // Windows 1-3: Portuguese speech. Window 4 (probe, un-pinned): the conversation has switched to
    // English and the auto decode surfaces it. Window 5 (confirmation, un-pinned): English again →
    // re-pin. Window 6: decoded pinned to English.
    for (const text of [pt, pt, pt, en, en, en]) asrFn.mockResolvedValueOnce({ text })
    transformers.pipeline.mockResolvedValueOnce(asrFn)

    await import('./whisper.worker')
    await worker.onmessage?.({
      data: { type: 'init', quality: 'fast', bundled: false, language: 'Portuguese' }
    } as MessageEvent)
    for (let i = 0; i < 6; i++) {
      await worker.onmessage?.({ data: { type: 'audio', audio: new Float32Array(16), speaker: 'them' } } as MessageEvent)
    }

    const langs = asrFn.mock.calls.map((c) => c[1].language)
    expect(langs).toEqual(['portuguese', 'portuguese', 'portuguese', undefined, undefined, 'english'])
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'log', message: expect.stringContaining('Portuguese → English') })
    )
  })

  it("converges onto the conversation's language in 'auto' mode after two confident detections", async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    vi.stubGlobal('self', worker)
    const pt = 'a gente vai ver isso com você, não é, para o contrato'
    const asrFn = vi.fn().mockResolvedValue({ text: pt })
    transformers.pipeline.mockResolvedValueOnce(asrFn)

    await import('./whisper.worker')
    await worker.onmessage?.({ data: { type: 'init', quality: 'fast', bundled: false, language: 'auto' } } as MessageEvent)
    for (let i = 0; i < 3; i++) {
      await worker.onmessage?.({ data: { type: 'audio', audio: new Float32Array(16), speaker: 'you' } } as MessageEvent)
    }

    const langs = asrFn.mock.calls.map((c) => c[1].language)
    // Windows 1-2 decode auto (gathering evidence); window 3 decodes pinned to the converged language.
    expect(langs).toEqual([undefined, undefined, 'portuguese'])
  })

  it('resets the follow machine when a live init changes the language mid-session', async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    vi.stubGlobal('self', worker)
    const pt = 'a gente vai ver isso com você, não é, para o contrato'
    const asrFn = vi.fn().mockResolvedValue({ text: pt })
    transformers.pipeline.mockResolvedValueOnce(asrFn)

    await import('./whisper.worker')
    await worker.onmessage?.({ data: { type: 'init', quality: 'fast', bundled: false, language: 'auto' } } as MessageEvent)
    await worker.onmessage?.({ data: { type: 'audio', audio: new Float32Array(16), speaker: 'you' } } as MessageEvent)
    await worker.onmessage?.({ data: { type: 'audio', audio: new Float32Array(16), speaker: 'you' } } as MessageEvent)
    // Converged onto Portuguese; the user now flips Settings to French mid-meeting (warm re-init).
    await worker.onmessage?.({ data: { type: 'init', quality: 'fast', bundled: false, language: 'French' } } as MessageEvent)
    await worker.onmessage?.({ data: { type: 'audio', audio: new Float32Array(16), speaker: 'you' } } as MessageEvent)

    expect(transformers.pipeline).toHaveBeenCalledTimes(1) // warm re-init never reloads the model
    const langs = asrFn.mock.calls.map((c) => c[1].language)
    expect(langs[2]).toBe('french') // window counter reset too: first post-change window is pinned, not a probe
  })

  it('never leaks the previous session\'s converged language into a new session (resetFollow)', async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    vi.stubGlobal('self', worker)
    const pt = 'a gente vai ver isso com você, não é, para o contrato'
    const asrFn = vi.fn().mockResolvedValue({ text: pt })
    transformers.pipeline.mockResolvedValueOnce(asrFn)

    await import('./whisper.worker')
    // Session 1 ('auto'): converges onto Portuguese. Sessions send resetFollow, like listen.ts's start().
    await worker.onmessage?.({
      data: { type: 'init', quality: 'fast', bundled: false, language: 'auto', resetFollow: true }
    } as MessageEvent)
    for (let i = 0; i < 3; i++) {
      await worker.onmessage?.({ data: { type: 'audio', audio: new Float32Array(16), speaker: 'you' } } as MessageEvent)
    }
    expect(asrFn.mock.calls[2][1].language).toBe('portuguese') // session 1 converged

    // Session 2 starts with the SAME 'auto' value on the still-warm worker (the default case — user
    // never touched Settings between meetings). Without the resetFollow hard reset this window would
    // decode pinned to Portuguese — the exact cross-session leak the 4-agent review demonstrated.
    await worker.onmessage?.({
      data: { type: 'init', quality: 'fast', bundled: false, language: 'auto', resetFollow: true }
    } as MessageEvent)
    await worker.onmessage?.({ data: { type: 'audio', audio: new Float32Array(16), speaker: 'you' } } as MessageEvent)

    expect(transformers.pipeline).toHaveBeenCalledTimes(1) // still the same warm model
    expect(asrFn.mock.calls[3][1].language).toBeUndefined() // fresh session decodes auto, no inherited pin
  })

  it('abandons an unconfirmed switch after its patience budget instead of probing forever', async () => {
    const worker = {
      navigator: {},
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined
    }
    vi.stubGlobal('self', worker)
    const es = 'entonces vamos a ver esto con usted, pero no es para hoy'
    const de = 'wir haben das nicht mit der neuen Version gemacht, aber das ist gut'
    const fr = "alors nous allons voir ça avec vous, mais pas pour aujourd'hui"
    const noise = 'hmm hmm okay'
    const asrFn = vi.fn()
    // Windows 1-3 pinned-Portuguese noise; window 4 probes and detections then ALTERNATE languages
    // (Spanish → German → French → noise): no candidate ever confirms, so after PROBE_PATIENCE the run
    // must die. Window 8 is a regular periodic probe (8 % PROBE_EVERY === 0); window 9 must be pinned
    // to Portuguese again — not left un-pinned for the session.
    for (const text of [noise, noise, noise, es, de, fr, noise, noise, noise]) asrFn.mockResolvedValueOnce({ text })
    transformers.pipeline.mockResolvedValueOnce(asrFn)

    await import('./whisper.worker')
    await worker.onmessage?.({
      data: { type: 'init', quality: 'fast', bundled: false, language: 'Portuguese', resetFollow: true }
    } as MessageEvent)
    for (let i = 0; i < 9; i++) {
      await worker.onmessage?.({ data: { type: 'audio', audio: new Float32Array(16), speaker: 'them' } } as MessageEvent)
    }

    const langs = asrFn.mock.calls.map((c) => c[1].language)
    expect(langs[8]).toBe('portuguese') // back to the pin — probing did not become permanent
    expect(langs.slice(0, 3)).toEqual(['portuguese', 'portuguese', 'portuguese']) // and was pinned before
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
