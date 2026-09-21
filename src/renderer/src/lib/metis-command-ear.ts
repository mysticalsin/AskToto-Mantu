/**
 * Métis 2.0 Cap 2 — always-on command ear.
 * getUserMedia + Apple/Parakeet YOU feeds. Main owns Cap2 ingest.
 * Must resume AudioContext (Chromium starts suspended without a gesture).
 */
const TARGET_RATE = 16_000
const WINDOW_SEC = 2.0
const RMS_MIN = 0.003

export type MetisCommandEarStatus =
  | { state: 'idle' }
  | { state: 'arming' }
  | { state: 'listening' }
  | { state: 'denied'; reason: string }
  | { state: 'error'; reason: string }
  | { state: 'heard'; text: string; via: 'apple' | 'parakeet' }

export type MetisCommandEarOptions = {
  enabled: boolean
  preferApple?: boolean
  isMeetingListening?: () => boolean
  onStatus?: (status: MetisCommandEarStatus) => void
  onMicDenied?: () => void
}

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_RATE) return input
  const ratio = inputRate / TARGET_RATE
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    let n = 0
    for (let j = start; j < end; j++) {
      sum += input[j] ?? 0
      n++
    }
    out[i] = n ? sum / n : 0
  }
  return out
}

function feedText(result: unknown): string {
  if (typeof result === 'string') return result.trim()
  if (result && typeof result === 'object' && 'text' in result) {
    const t = (result as { text?: unknown }).text
    return typeof t === 'string' ? t.trim() : ''
  }
  return ''
}

export function startMetisCommandEar(opts: MetisCommandEarOptions): () => void {
  let stopped = false
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  let processor: ScriptProcessorNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let sink: GainNode | null = null
  let pending = new Float32Array(0)
  let feeding = false
  let resumeHook: (() => void) | null = null
  let resumeTimer: ReturnType<typeof setInterval> | null = null

  const status = (s: MetisCommandEarStatus) => {
    try {
      opts.onStatus?.(s)
    } catch {
      /* ignore */
    }
  }

  const stop = () => {
    stopped = true
    if (resumeTimer) {
      clearInterval(resumeTimer)
      resumeTimer = null
    }
    if (resumeHook) {
      window.removeEventListener('pointerdown', resumeHook, true)
      window.removeEventListener('keydown', resumeHook, true)
      resumeHook = null
    }
    try {
      processor?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      source?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      sink?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      void ctx?.close()
    } catch {
      /* ignore */
    }
    stream?.getTracks().forEach((t) => t.stop())
    processor = null
    source = null
    sink = null
    ctx = null
    stream = null
    status({ state: 'idle' })
  }

  if (!opts.enabled) {
    status({ state: 'idle' })
    return stop
  }

  status({ state: 'arming' })

  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
    } catch (err) {
      const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : 'error'
      status({ state: 'denied', reason: name })
      if (name === 'NotAllowedError' || name === 'SecurityError') opts.onMicDenied?.()
      return
    }
    if (stopped) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    ctx = new AudioContext()
    const ensureRunning = () => {
      if (ctx && ctx.state === 'suspended') void ctx.resume()
    }
    ensureRunning()
    resumeHook = () => ensureRunning()
    window.addEventListener('pointerdown', resumeHook, true)
    window.addEventListener('keydown', resumeHook, true)

    const inputRate = ctx.sampleRate
    source = ctx.createMediaStreamSource(stream)
    processor = ctx.createScriptProcessor(4096, 1, 1)
    // Silent sink — never route mic to speakers.
    sink = ctx.createGain()
    sink.gain.value = 0
    const needed = Math.floor(TARGET_RATE * WINDOW_SEC)

    processor.onaudioprocess = (ev) => {
      if (stopped) return
      ensureRunning()
      if (opts.isMeetingListening?.()) return
      const input = ev.inputBuffer.getChannelData(0)
      const chunk = downsampleTo16k(input, inputRate)
      const merged = new Float32Array(pending.length + chunk.length)
      merged.set(pending, 0)
      merged.set(chunk, pending.length)
      pending = merged
      if (pending.length < needed || feeding) return
      const windowSamples = pending.slice(0, needed)
      pending = pending.slice(needed)
      let sum = 0
      for (let i = 0; i < windowSamples.length; i++) sum += windowSamples[i]! * windowSamples[i]!
      const rms = Math.sqrt(sum / windowSamples.length)
      if (rms < RMS_MIN) return

      feeding = true
      void (async () => {
        try {
          let via: 'apple' | 'parakeet' = 'parakeet'
          let text = ''
          if (opts.preferApple !== false && typeof window.toto.appleSpeechFeed === 'function') {
            via = 'apple'
            text = feedText(await window.toto.appleSpeechFeed(windowSamples, 'you', Date.now()))
          }
          if (!text && typeof window.toto.parakeetFeed === 'function') {
            via = 'parakeet'
            text = feedText(await window.toto.parakeetFeed(windowSamples, 'you', Date.now()))
          }
          if (text) status({ state: 'heard', text, via })
        } catch (err) {
          status({ state: 'error', reason: String(err instanceof Error ? err.message : err) })
        } finally {
          feeding = false
        }
      })()
    }

    source.connect(processor)
    processor.connect(sink)
    sink.connect(ctx.destination)
    status({ state: 'listening' })
    document.documentElement.dataset.metisCommandEar = '1'
    // Parked Dock/Island often has no gesture — Chromium leaves AudioContext suspended.
    resumeTimer = setInterval(() => {
      if (!stopped) ensureRunning()
    }, 750)
  })()

  return () => {
    document.documentElement.dataset.metisCommandEar = '0'
    stop()
  }
}
