/**
 * Métis 2.0 Cap 2 — always-on command ear.
 * getUserMedia + Parakeet/Apple YOU feeds. Main owns Cap2 ingest.
 * Must resume AudioContext (Chromium starts suspended without a gesture).
 *
 * Engine cascade (Tony live FAIL tip 72c36473 root cause): the ear used to call ONE engine chosen up
 * front. On Tony's Mac the Parakeet model files were absent, so every 2s window rejected the IPC and
 * Apple Speech — the fallback that needs no downloaded model — was never tried. Hey Métis was silent
 * while `ASKTOTO_CAP2_PROVE` (which injects text past the mic) passed. Every engine is now tried per
 * window, each isolated: one engine throwing or being unavailable can never mute the others, an engine
 * that reports itself unavailable is dropped for the session, and when NO engine can transcribe the
 * chip says so instead of failing silent.
 *
 * Windows overlap: "Hey Métis" spoken across a window boundary used to be split into two halves that
 * neither matched the wake regex. Each window carries the previous window's tail (WINDOW_SEC − HOP_SEC)
 * so a wake phrase is always whole in at least one window.
 */
const TARGET_RATE = 16_000
/** Window handed to ASR. Shorter than Listen's meeting windows — wake must feel like Hey Siri. */
const WINDOW_SEC = 1.5
/** Advance per window. WINDOW_SEC − HOP_SEC is the overlap that keeps a straddling wake phrase whole. */
const HOP_SEC = 1.0
/** Never queue more than this much audio: a slow engine must drop old audio, not add latency forever. */
const MAX_PENDING_SEC = 6
const RMS_MIN = 0.003
/** Consecutive engine throws before that engine is considered dead for this session. */
const ENGINE_FAIL_MAX = 3
/** Fed windows with speech-level audio but zero text from every engine before we call the ear broken. */
const NO_TEXT_MAX = 8
/** Windows of digital silence (peak exactly 0) before we report a muted/blocked mic. */
const SILENT_WINDOW_MAX = 20

export type MetisCommandEarStatus =
  | { state: 'idle' }
  | { state: 'arming' }
  | { state: 'listening' }
  | { state: 'denied'; reason: string }
  | { state: 'error'; reason: string }
  | { state: 'heard'; text: string; via: 'apple' | 'parakeet' }

export type MetisCommandEarOptions = {
  enabled: boolean
  /** Deprecated ordering hint. Both engines are always tried; this only puts Apple first. */
  preferApple?: boolean
  isMeetingListening?: () => boolean
  onStatus?: (status: MetisCommandEarStatus) => void
  onMicDenied?: () => void
}

type EngineId = 'parakeet' | 'apple'

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

/** Main marks a feed `unavailable` when the engine cannot run at all (model missing, non-darwin, no
 *  helper). That is a permanent fact for this session — stop paying for it every window. */
function feedUnavailable(result: unknown): boolean {
  return !!result && typeof result === 'object' && (result as { unavailable?: unknown }).unavailable === true
}

/** Main answers a FAILED decode with `{ text: '', error: true }` rather than rejecting. That used to
 *  be indistinguishable from genuine silence here: the fail counter was reset and the engine stayed in
 *  the cascade forever, so a permanently broken engine (Tony live FAIL: the Parakeet helper could not
 *  load its native addon) cost a doomed round-trip on every single wake window. A resolved error is an
 *  engine failure, and counts as one. */
function feedErrored(result: unknown): boolean {
  return !!result && typeof result === 'object' && (result as { error?: unknown }).error === true
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
  const engineFails: Record<EngineId, number> = { parakeet: 0, apple: 0 }
  const engineDead: Record<EngineId, boolean> = { parakeet: false, apple: false }
  let noTextRun = 0
  let silentRun = 0
  let reportedBroken = false

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

  /** One window through every live engine. Each engine is isolated: a throw or an unavailable verdict
   *  retires that engine only, and the next one still gets this window. */
  const transcribeWindow = async (windowSamples: Float32Array): Promise<{ text: string; via: EngineId } | null> => {
    const order: EngineId[] = opts.preferApple === true ? ['apple', 'parakeet'] : ['parakeet', 'apple']
    for (const via of order) {
      if (engineDead[via]) continue
      const feed = via === 'apple' ? window.toto.appleSpeechFeed : window.toto.parakeetFeed
      if (typeof feed !== 'function') {
        engineDead[via] = true
        continue
      }
      try {
        const result = await feed(windowSamples, 'you', Date.now())
        if (feedUnavailable(result)) {
          engineDead[via] = true
          console.warn('[cap2-ear] engine unavailable:', via)
          continue
        }
        if (feedErrored(result)) {
          engineFails[via] += 1
          if (engineFails[via] >= ENGINE_FAIL_MAX) {
            engineDead[via] = true
            console.warn('[cap2-ear] engine retired after repeated decode errors:', via)
          }
          continue
        }
        engineFails[via] = 0
        const text = feedText(result)
        if (text) return { text, via }
      } catch (err) {
        engineFails[via] += 1
        if (engineFails[via] >= ENGINE_FAIL_MAX) {
          engineDead[via] = true
          console.warn('[cap2-ear] engine retired after repeated failures:', via, err)
        }
      }
    }
    return null
  }

  /** Never fail silent: an ear that cannot transcribe must say so on the chip. */
  const reportBroken = (reason: string): void => {
    if (reportedBroken) return
    reportedBroken = true
    status({ state: 'error', reason })
  }

  void (async () => {
    // macOS hands back a stream of digital silence rather than an error when the mic TCC grant was
    // never made, so ask for it before the first window instead of listening to nothing forever.
    try {
      await window.toto.cap2EarPrepare?.()
    } catch {
      /* best effort — getUserMedia below still raises its own prompt/error */
    }
    if (stopped) return
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
    const hop = Math.floor(TARGET_RATE * HOP_SEC)
    const maxPending = Math.floor(TARGET_RATE * MAX_PENDING_SEC)

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
      // A slow engine must cost audio, not latency: keep the newest MAX_PENDING_SEC only.
      if (pending.length > maxPending) pending = pending.slice(pending.length - maxPending)
      if (pending.length < needed || feeding) return
      const windowSamples = pending.slice(0, needed)
      // Advance by one hop, not a whole window — the overlap keeps a straddling "Hey Métis" whole.
      pending = pending.slice(Math.min(hop, pending.length))
      let sum = 0
      let peak = 0
      for (let i = 0; i < windowSamples.length; i++) {
        const s = windowSamples[i]!
        sum += s * s
        const a = s < 0 ? -s : s
        if (a > peak) peak = a
      }
      const rms = Math.sqrt(sum / windowSamples.length)
      if (peak === 0) {
        silentRun += 1
        // Electron on macOS returns a live track of zeros when the mic grant is missing/muted.
        if (silentRun >= SILENT_WINDOW_MAX) reportBroken('mic-silent')
        return
      }
      silentRun = 0
      if (rms < RMS_MIN) return

      feeding = true
      void (async () => {
        try {
          const heard = await transcribeWindow(windowSamples)
          if (engineDead.parakeet && engineDead.apple) {
            reportBroken('asr-engine-missing')
            return
          }
          if (heard) {
            noTextRun = 0
            reportedBroken = false
            status({ state: 'heard', text: heard.text, via: heard.via })
            return
          }
          noTextRun += 1
          if (noTextRun >= NO_TEXT_MAX) reportBroken('asr-no-text')
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
