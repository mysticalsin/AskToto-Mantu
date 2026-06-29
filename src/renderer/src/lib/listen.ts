import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranscriptLine } from '@shared/ipc'
import { WHISPER_WORKLET_SRC } from './whisper-worklet-src'

const SR = 16000

// The AudioWorklet module is loaded from an inlined Blob URL (created once, reused) so it resolves in
// both the Vite dev server and the packaged Electron build. See whisper-worklet-src.ts for the why.
let _workletUrl: string | null = null
function whisperWorkletUrl(): string {
  if (!_workletUrl) {
    _workletUrl = URL.createObjectURL(new Blob([WHISPER_WORKLET_SRC], { type: 'application/javascript' }))
  }
  return _workletUrl
}
const WINDOW_SEC = 6
const MAX_QUEUE = 24 // ~2.4 min of audio; drop oldest if the model is slow/failed to load
export type AudioSource = 'mic' | 'system' | 'both'
type Speaker = 'them' | 'you'

/** Soft audible chime generated in-browser (no asset file). */
export function playListenChime(): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(523.25, ctx.currentTime) // C5
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.08)
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.28)
    setTimeout(() => void ctx.close(), 350)
  } catch {
    /* ignore */
  }
}

const QWORDS =
  /^(what|why|how|when|where|who|which|can|could|would|do|does|did|are|is|have|has|tell me|walk me|describe|explain|give me)\b/i
export function isQuestion(t: string): boolean {
  const s = t.trim()
  if (!s) return false
  return s.endsWith('?') || (s.split(/\s+/).length >= 3 && QWORDS.test(s))
}

// Whisper (and to a lesser extent other ASR) emit caption-style filler on silence/non-speech. Drop a line
// only when its ENTIRE text is one of these phantoms — never substring-match, so real speech is untouched.
const PHANTOM = new Set(['you', 'thank you', 'thanks for watching', 'thanks', 'bye', 'okay', 'ok'])
function isPhantom(t: string): boolean {
  const s = t.trim().toLowerCase().replace(/[.!?\s]+$/g, '')
  return s === '' || PHANTOM.has(s)
}

interface Channel {
  ctx: AudioContext
  src: MediaStreamAudioSourceNode
  worklet: AudioWorkletNode
  stream: MediaStream
}

export interface ListenApi {
  listening: boolean
  ready: boolean
  loading: boolean
  lines: TranscriptLine[]
  error: string | null
  loadingPct: number | null // model-download progress (0-100) on first run, else null
  start: (source: AudioSource, quality?: 'best' | 'fast', engine?: 'whisper' | 'parakeet') => Promise<void>
  stop: () => void
  clear: () => void
  text: () => string
}

const WORKER_IDLE_RELEASE_MS = 180_000 // 3 min: free the whisper worker + ONNX wasm after Listen goes idle

export function useListen(onQuestion?: (line: TranscriptLine) => void): ListenApi {
  const [state, setState] = useState({
    listening: false,
    ready: false,
    loading: false,
    error: null as string | null,
    loadingPct: null as number | null
  })
  const [lines, setLines] = useState<TranscriptLine[]>([])

  const workerRef = useRef<Worker | null>(null)
  const loadedQualityRef = useRef<'best' | 'fast' | null>(null) // quality the warm worker was loaded with
  const engineRef = useRef<'whisper' | 'parakeet'>('whisper') // active ASR engine for this session
  // Cached bundled-model flag: queried once from the main process and reused for every init message.
  // null = not yet fetched; false = absent (dev build / no fetch-models run) → use remote CDN path.
  const asrBundledRef = useRef<boolean | null>(null)
  const getAsrBundled = useCallback(async (): Promise<boolean> => {
    if (asrBundledRef.current === null) {
      asrBundledRef.current = await window.toto.asrBundled().catch(() => false)
    }
    return asrBundledRef.current
  }, [])
  const workerIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const channels = useRef<Partial<Record<Speaker, Channel>>>({})
  const queue = useRef<{ audio: Float32Array; speaker: Speaker }[]>([])
  const busy = useRef(false)
  const readyRef = useRef(false)
  const liveRef = useRef(false) // true only between start() and stop() — guards stale results
  const onQRef = useRef(onQuestion)
  onQRef.current = onQuestion
  const linesRef = useRef<TranscriptLine[]>([])
  linesRef.current = lines

  // Add a transcribed line + fire the auto-answer hook. Shared by the Whisper worker and Parakeet paths.
  const commitLine = useCallback((text: string, speaker: Speaker): void => {
    // Drop phantom/hallucinated lines before touching state (covers both Whisper and Parakeet paths).
    if (isPhantom(text)) return
    if (text && liveRef.current) {
      const line: TranscriptLine = { speaker: speaker || 'you', text, t: Date.now() }
      // Update the ref synchronously BEFORE firing onQ, so text() (read inside the handler) already
      // includes the line that triggered the auto-answer.
      const next = [...linesRef.current, line]
      linesRef.current = next
      setLines(next)
      if (line.speaker === 'them' && isQuestion(line.text)) onQRef.current?.(line)
    }
  }, [])

  const pump = useCallback((): void => {
    if (!readyRef.current || busy.current || queue.current.length === 0) return
    const job = queue.current.shift() as { audio: Float32Array; speaker: Speaker }
    busy.current = true
    if (engineRef.current === 'parakeet') {
      // Parakeet runs in the MAIN process (native addon) — hand the window over IPC, get text back.
      void window.toto
        .parakeetFeed(job.audio, job.speaker)
        .then((text) => commitLine(text, job.speaker))
        .catch(() => {})
        .finally(() => {
          busy.current = false
          pump()
        })
      return
    }
    if (!workerRef.current) {
      busy.current = false
      return
    }
    workerRef.current.postMessage({ type: 'audio', audio: job.audio, speaker: job.speaker }, [job.audio.buffer])
  }, [commitLine])

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current
    const w = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent): void => {
      const m = e.data as { type: string; text?: string; speaker?: Speaker; message?: string; engine?: string }
      if (m.type === 'log') {
        console.warn('[whisper]', m.message)
      } else if (m.type === 'progress') {
        setState((s) => ({ ...s, loadingPct: (m as { pct?: number }).pct ?? null }))
      } else if (m.type === 'ready') {
        readyRef.current = true
        if (m.engine) console.info('[whisper] engine:', m.engine)
        setState((s) => ({ ...s, ready: true, loading: false, loadingPct: null }))
        pump() // drain windows captured while the model loaded
      } else if (m.type === 'error') {
        setState((s) => ({ ...s, error: m.message ?? 'transcription error', loading: false }))
        busy.current = false
        pump()
      } else if (m.type === 'text') {
        commitLine(m.text || '', (m.speaker as Speaker) || 'you')
        busy.current = false
        pump()
      }
    }
    w.onerror = (err: ErrorEvent): void => {
      // A worker crash must FULLY tear down capture, not just the worker — otherwise the mic + system
      // AudioContexts stay hot and the tray stays in 'recording' while the UI reads 'not listening',
      // an unrecoverable dead end. Mirror stop()'s teardown so a crash returns to a clean idle state.
      liveRef.current = false
      queue.current = []
      closeChannel('you')
      closeChannel('them')
      void window.toto.setListeningState(false).catch(() => {})
      setState((s) => ({ ...s, error: err.message || 'transcription worker error', listening: false, loading: false }))
      busy.current = false
      workerRef.current?.terminate()
      workerRef.current = null
      readyRef.current = false
    }
    workerRef.current = w
    return w
  }, [pump])

  const pushAudio = useCallback(
    (sp: Speaker, audio: Float32Array): void => {
      if (!liveRef.current) return
      queue.current.push({ audio, speaker: sp })
      if (queue.current.length > MAX_QUEUE) {
        queue.current.splice(0, queue.current.length - MAX_QUEUE) // bound memory; drop oldest
      }
      pump()
    },
    [pump]
  )

  const openChannel = useCallback(
    async (sp: Speaker, stream: MediaStream): Promise<void> => {
      closeChannel(sp) // close any prior channel for this speaker (avoid orphan on retry)
      const ctx = new AudioContext({ sampleRate: SR })
      const src = ctx.createMediaStreamSource(stream)
      await ctx.audioWorklet.addModule(whisperWorkletUrl())
      // Race guard: if stop() ran while we were awaiting addModule, tear down instead of wiring a stale channel.
      if (!liveRef.current) {
        src.disconnect()
        stream.getTracks().forEach((t) => t.stop())
        void ctx.close().catch(() => {})
        return
      }
      const worklet = new AudioWorkletNode(ctx, 'whisper-worklet', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1
      })
      worklet.port.onmessage = (ev: MessageEvent): void => {
        const data = ev.data as { audio?: Float32Array }
        if (data.audio) pushAudio(sp, data.audio)
      }
      const ch: Channel = { ctx, src, worklet, stream }
      channels.current[sp] = ch
      src.connect(worklet)
      worklet.connect(ctx.destination) // keeps the node processing; output stays silent
    },
    [pushAudio]
  )

  const start = useCallback(
    async (
      source: AudioSource,
      quality: 'best' | 'fast' = 'best',
      engine: 'whisper' | 'parakeet' = 'whisper'
    ): Promise<void> => {
      if (workerIdleTimer.current) {
        clearTimeout(workerIdleTimer.current) // re-arming before the idle release fires: keep the worker warm
        workerIdleTimer.current = null
      }
      queue.current = []
      busy.current = false
      liveRef.current = true
      engineRef.current = engine
      setState((s) => ({ ...s, error: null, listening: true }))
      try {
        await window.toto.setListeningState(true)
      } catch {
        /* main may not have a tray; ignore */
      }

      if (engine === 'parakeet') {
        // Parakeet runs in the MAIN process; free any warm Whisper worker, then ensure the model (a one-time
        // ~487MB download with progress). ANY failure falls back to Whisper so Listen always works.
        if (workerRef.current) {
          workerRef.current.terminate()
          workerRef.current = null
        }
        loadedQualityRef.current = null
        readyRef.current = false
        setState((s) => ({ ...s, loading: true, loadingPct: null }))
        try {
          const st = await window.toto.parakeetStatus()
          if (!st.ready) {
            const off = window.toto.onParakeetProgress((pct) => setState((s) => ({ ...s, loadingPct: pct })))
            try {
              const r = await window.toto.parakeetEnsure()
              if (!r?.ok) throw new Error(r?.error || 'parakeet model unavailable')
            } finally {
              off()
            }
          }
          readyRef.current = true
          setState((s) => ({ ...s, ready: true, loading: false, loadingPct: null }))
          pump()
        } catch (e) {
          console.warn('[listen] parakeet unavailable, using whisper:', (e as Error)?.message)
          engineRef.current = 'whisper'
        }
      }

      if (engineRef.current === 'whisper') {
        // If the quality changed since the warm worker loaded (or we just fell back from Parakeet),
        // terminate so the next init reloads the correct model. Unchanged quality → instant warm restart.
        if (workerRef.current && loadedQualityRef.current !== null && loadedQualityRef.current !== quality) {
          workerRef.current.terminate()
          workerRef.current = null
          readyRef.current = false
        }
        loadedQualityRef.current = quality
        setState((s) => ({ ...s, loading: !readyRef.current }))
        // The worker selects the model: 'best' → WebGPU + whisper-large-v3-turbo (~99 languages); 'fast'
        // (or fallback) → WASM + whisper-base. init is a no-op if a model is already loaded.
        // bundled: true → worker uses the asr-model:// scheme (offline, packaged resources);
        //          false → worker uses transformers.js defaults (remote HF + CDN wasm, proven fallback).
        const bundled = await getAsrBundled()
        ensureWorker().postMessage({ type: 'init', quality, bundled })
        if (readyRef.current) pump() // warm worker already ready → drain immediately
      }

      // Capture each side INDEPENDENTLY. The mic ("you") and the system loopback ("them") fail for
      // different reasons (mic = Microphone permission; loopback = Screen Recording + Electron's
      // getDisplayMedia, which throws a raw "user aborted a request" on many machines). Isolating them
      // means a system-audio failure never masks a perfectly good microphone — you keep listening,
      // mic-only, with a clear note instead of a scary abort.
      let micOk = false
      let sysOk = false

      if (source === 'mic' || source === 'both') {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
          })
          if (!liveRef.current) {
            mic.getTracks().forEach((t) => t.stop())
            return
          }
          await openChannel('you', mic)
          micOk = true
        } catch (e) {
          console.warn('[listen] microphone capture failed:', (e as Error)?.name, (e as Error)?.message)
        }
      }

      if (source === 'system' || source === 'both') {
        try {
          await window.toto.armAudio(true) // arm the loopback handler only for this request
          let sys: MediaStream
          try {
            // macOS produces system-audio loopback ONLY as part of a ScreenCaptureKit (screen-video)
            // stream — an audio-only getDisplayMedia never starts capture ("Error starting capture").
            // So we request a minimal 1fps video track to start the stream, then immediately stop and
            // remove it: only the system-audio track is kept, and no video frame is ever read or sent.
            sys = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true })
            sys.getVideoTracks().forEach((t) => {
              t.stop()
              sys.removeTrack(t)
            })
          } finally {
            await window.toto.armAudio(false)
          }
          if (!sys.getAudioTracks().length) throw new Error('no system audio track returned')
          if (!liveRef.current) {
            sys.getTracks().forEach((t) => t.stop())
            return
          }
          await openChannel('them', sys)
          sysOk = true
        } catch (e) {
          console.warn('[listen] system-audio capture failed:', (e as Error)?.name, (e as Error)?.message)
        }
      }

      if (!micOk && !sysOk) {
        // Nothing came up — tear down so no half-open channel stays hot while the UI says "not listening".
        liveRef.current = false
        closeChannel('you')
        closeChannel('them')
        try {
          await window.toto.setListeningState(false)
        } catch {
          /* ignore */
        }
        const msg =
          source === 'system'
            ? 'Couldn’t capture system audio. Grant Screen Recording in System Settings, or switch Listen to your microphone in Settings → Audio.'
            : 'Couldn’t start the microphone. Check Microphone access in System Settings → Privacy & Security → Microphone.'
        setState((s) => ({ ...s, error: msg, listening: false, loading: false }))
        // A failed start shouldn't pin the whisper worker + ~21MB ONNX wasm in memory for the app's life —
        // arm the same idle release stop() uses (ensureWorker recreates it on the next start()).
        if (workerIdleTimer.current) clearTimeout(workerIdleTimer.current)
        workerIdleTimer.current = setTimeout(() => {
          workerRef.current?.terminate()
          workerRef.current = null
          readyRef.current = false
          workerIdleTimer.current = null
        }, WORKER_IDLE_RELEASE_MS)
        return
      }

      // At least one side is live → we ARE listening. Surface a soft note if the other side is missing.
      const note =
        source === 'both' && micOk && !sysOk
          ? 'System audio unavailable. Listening to your microphone only. Grant Screen Recording to hear the other side.'
          : source === 'both' && !micOk && sysOk
            ? 'Microphone unavailable. Listening to system audio only.'
            : null
      setState((s) => ({ ...s, error: note, listening: true, loading: !readyRef.current }))
    },
    // closeChannel referenced in body (defined below); stable useCallback, omitted to avoid TDZ in deps
    [ensureWorker, openChannel, pump]
  )

  const closeChannel = useCallback((sp: Speaker): void => {
    const ch = channels.current[sp]
    if (!ch) return
    ch.worklet.disconnect()
    ch.worklet.port.onmessage = null
    ch.src.disconnect()
    ch.stream.getTracks().forEach((t) => t.stop())
    void ch.ctx.close().catch(() => {})
    delete channels.current[sp]
  }, [])

  const stop = useCallback((): void => {
    liveRef.current = false
    queue.current = [] // drop undispatched windows so they can't leak into the next session
    closeChannel('you')
    closeChannel('them')
    void window.toto.setListeningState(false).catch(() => {})
    setState((s) => ({ ...s, listening: false, loading: false, error: null }))
    // Release the whisper worker (+ ~21MB ONNX wasm + loaded model) after a few idle minutes so it does
    // not sit resident for the entire life of an always-on overlay. ensureWorker() recreates it and start()
    // re-inits the model on the next session; re-arming within the window keeps it warm.
    if (workerIdleTimer.current) clearTimeout(workerIdleTimer.current)
    workerIdleTimer.current = setTimeout(() => {
      workerRef.current?.terminate()
      workerRef.current = null
      readyRef.current = false
      workerIdleTimer.current = null
    }, WORKER_IDLE_RELEASE_MS)
  }, [closeChannel])

  const clear = useCallback((): void => {
    setLines([])
  }, [])

  const text = useCallback((): string => {
    return linesRef.current
      .map((l) => `${l.speaker === 'them' ? 'THEM' : 'YOU'}: ${l.text}`)
      .join('\n')
  }, [])

  useEffect(() => {
    return () => {
      stop()
      if (workerIdleTimer.current) clearTimeout(workerIdleTimer.current)
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [stop])

  // Pre-warm the small default model in the BACKGROUND a few seconds after startup, so the first time the
  // user presses Listen the model is already loaded (no "downloading speech model…" spinner mid-meeting).
  // Deferred + idle-scheduled so it never competes with the first paint / onboarding interaction.
  useEffect(() => {
    let warmed = false
    const warm = async (): Promise<void> => {
      if (warmed || workerRef.current) return
      warmed = true
      try {
        const bundled = await getAsrBundled()
        ensureWorker().postMessage({ type: 'init', quality: 'fast', bundled })
        loadedQualityRef.current = 'fast'
      } catch {
        /* best-effort prewarm */
      }
    }
    const t = setTimeout(() => void warm(), 4000)
    return () => clearTimeout(t)
  }, [ensureWorker, getAsrBundled])

  return { ...state, lines, start, stop, clear, text }
}
