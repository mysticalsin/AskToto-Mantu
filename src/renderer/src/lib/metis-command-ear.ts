/**
 * Métis 2.0 Cap 2 — always-on command ear.
 * Reuses getUserMedia + main Parakeet/Apple feeds (speaker "you").
 * Main owns Cap2 ingest; this never invents desktop commands in the renderer.
 */
const TARGET_RATE = 16_000
const WINDOW_SEC = 2.5

export type MetisCommandEarOptions = {
  /** When false, ear is idle (cleanup still returned). */
  enabled: boolean
  /** Prefer apple on macOS when available; otherwise parakeet. */
  preferApple?: boolean
  /** Skip capturing while a full meeting Listen owns the mic. */
  isMeetingListening?: () => boolean
  onMicDenied?: () => void
  onError?: (err: unknown) => void
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

async function openMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
}

/**
 * Start the Cap2 ear. Returns a stop function.
 * Safe to call repeatedly; previous loop is stopped first by the caller.
 */
export function startMetisCommandEar(opts: MetisCommandEarOptions): () => void {
  let stopped = false
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  let processor: ScriptProcessorNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let pending = new Float32Array(0)
  let feeding = false

  const stop = () => {
    stopped = true
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
      void ctx?.close()
    } catch {
      /* ignore */
    }
    stream?.getTracks().forEach((t) => t.stop())
    processor = null
    source = null
    ctx = null
    stream = null
  }

  if (!opts.enabled) return stop

  void (async () => {
    try {
      stream = await openMic()
    } catch (err) {
      const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') opts.onMicDenied?.()
      else opts.onError?.(err)
      return
    }
    if (stopped) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    ctx = new AudioContext()
    const inputRate = ctx.sampleRate
    source = ctx.createMediaStreamSource(stream)
    // ScriptProcessor is deprecated but already used elsewhere for low-deps PCM; keep Cap2 on same path.
    processor = ctx.createScriptProcessor(4096, 1, 1)
    const needed = Math.floor(TARGET_RATE * WINDOW_SEC)

    processor.onaudioprocess = (ev) => {
      if (stopped) return
      if (opts.isMeetingListening?.()) return
      const input = ev.inputBuffer.getChannelData(0)
      const chunk = downsampleTo16k(input, inputRate)
      const merged = new Float32Array(pending.length + chunk.length)
      merged.set(pending, 0)
      merged.set(chunk, pending.length)
      pending = merged
      if (pending.length < needed || feeding) return
      const window = pending.slice(0, needed)
      pending = pending.slice(needed)
      // RMS gate: skip near-silence windows
      let sum = 0
      for (let i = 0; i < window.length; i++) sum += window[i]! * window[i]!
      const rms = Math.sqrt(sum / window.length)
      if (rms < 0.008) return

      feeding = true
      const feed =
        opts.preferApple !== false && window.toto.appleSpeechFeed
          ? window.toto.appleSpeechFeed(window, 'you', Date.now())
          : window.toto.parakeetFeed(window, 'you', Date.now())
      void Promise.resolve(feed)
        .catch((err) => opts.onError?.(err))
        .finally(() => {
          feeding = false
        })
    }

    source.connect(processor)
    processor.connect(ctx.destination)
  })()

  return stop
}
