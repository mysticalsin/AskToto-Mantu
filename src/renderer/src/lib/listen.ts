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
const PARAKEET_FEED_TIMEOUT_MS = 5000 // a single Parakeet window shouldn't take longer than this to transcribe
const PARAKEET_MAX_FAILURES = 3 // consecutive Parakeet failures → fall back to Whisper for the rest of the session
const PARAKEET_EMPTY_RUN_MAX = 5 // consecutive '' returns on flowing audio → treat as engine stall, fall back to Whisper
const THEM_WATCHDOG_MS = 20_000 // 20 s with the 'them' channel open but no window emitted → surface soft note
// Exact text of the soft "not hearing the other side" note, shared by the watchdog (sets it) and the
// first-'them'-emission handler (clears it) so loopback arriving AFTER the watchdog fired isn't left stuck.
const THEM_SILENT_MSG = 'Not hearing the other side — check the call volume and that Screen Recording is granted.'
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
// Words a complete question never ends on: articles, coordinating conjunctions, possessive determiners.
// A line that dangles on one of these (e.g. "what is the…") is a question cut mid-sentence by a VAD endpoint,
// not a finished one — so we hold off firing the auto-answer and let the coalesced turn accumulate the rest.
// (Stranded prepositions like "where are you from" are deliberately NOT here — they DO end real questions.)
const DANGLING = /\b(the|a|an|and|or|but|your|my|our|their|its)$/i
export function isQuestion(t: string): boolean {
  const s = t.trim()
  if (!s) return false
  if (s.endsWith('?')) return true // explicit terminal punctuation → complete even when short
  if (DANGLING.test(s.replace(/[.,;:!\s]+$/, ''))) return false // still mid-sentence → not yet a question
  return s.split(/\s+/).length >= 3 && QWORDS.test(s)
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
  gain?: GainNode // present on 'them' only: boosts quiet system-loopback above the VAD floor
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
  const crashedRef = useRef(false) // set in worker onerror (it already tore down) → stop() must not redo it
  const parakeetFailures = useRef(0) // consecutive Parakeet IPC failures → switch to Whisper after a few
  const parakeetEmptyRunRef = useRef(0) // consecutive '' returns on flowing audio → engine stall detection
  const themWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null) // fires if 'them' emits nothing for THEM_WATCHDOG_MS
  const themHeardRef = useRef(false) // flips true on the first real 'them' window so we clear the watchdog note exactly once
  const onQRef = useRef(onQuestion)
  onQRef.current = onQuestion
  const linesRef = useRef<TranscriptLine[]>([])
  linesRef.current = lines
  // Trailing run of consecutive 'them' speech (joined) since the last 'you' turn or last auto-answer fire.
  // The auto-answer endpoints on this COALESCED turn rather than a single VAD window, so a question split
  // across windows by a mid-sentence hesitation pause (more likely now the endpoint is a snappy 0.6s) still
  // fires once and complete — instead of firing on the truncated first fragment and then being locked out
  // by the App-level suggest throttle. Reset on a 'you' line, on fire, and on start()/clear().
  const themRunRef = useRef('')

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
      // Auto-answer endpoints on the COALESCED 'them' turn (themRunRef), not a single VAD window: a 'you'
      // line hands the turn back (clear the run); a 'them' line extends it. Fire once the joined run reads
      // as a complete question, then consume the run so a continued sentence doesn't re-fire mid-thought.
      if (line.speaker === 'them') {
        themRunRef.current = themRunRef.current ? `${themRunRef.current} ${line.text}` : line.text
        if (themRunRef.current.length > 600) themRunRef.current = themRunRef.current.slice(-600) // bound memory
        if (isQuestion(themRunRef.current)) {
          themRunRef.current = ''
          onQRef.current?.(line)
        }
      } else {
        themRunRef.current = ''
      }
    }
  }, [])

  const pump = useCallback((): void => {
    if (!readyRef.current || busy.current || queue.current.length === 0) return
    const job = queue.current.shift() as { audio: Float32Array; speaker: Speaker }
    busy.current = true
    if (engineRef.current === 'parakeet') {
      // Parakeet runs in the MAIN process (native addon) — hand the window over IPC, get text back.
      // Race against a timeout so a hung IPC can't stall the queue. On a real failure (reject or timeout)
      // count it; after a few consecutive failures, switch the whole session to Whisper so windows stop
      // being lost. An empty string is genuine silence (phantom-filtered in commitLine), never a failure.
      const feed = window.toto.parakeetFeed(job.audio, job.speaker)
      const timeout = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('parakeet feed timed out')), PARAKEET_FEED_TIMEOUT_MS)
      )
      void Promise.race([feed, timeout])
        .then((text) => {
          parakeetFailures.current = 0 // success (even empty) resets the IPC-failure streak
          if (text === '') {
            // Empty but technically successful: the window passed EMIT_RMS so audio WAS flowing — the
            // engine returning nothing every time signals a stall (wrong model path, native init failure,
            // silent loopback bug). Fall back to Whisper after a run so windows aren't silently swallowed.
            parakeetEmptyRunRef.current += 1
            if (parakeetEmptyRunRef.current >= PARAKEET_EMPTY_RUN_MAX) {
              console.warn('[listen] parakeet returning empty every window — falling back to Whisper')
              fallBackToWhisper()
            }
          } else {
            parakeetEmptyRunRef.current = 0
            commitLine(text, job.speaker)
          }
        })
        .catch((err) => {
          parakeetFailures.current += 1
          console.warn(
            `[listen] parakeet window failed (${parakeetFailures.current}/${PARAKEET_MAX_FAILURES}):`,
            (err as Error)?.message
          )
          if (parakeetFailures.current >= PARAKEET_MAX_FAILURES) fallBackToWhisper()
        })
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
    // fallBackToWhisper (called in the parakeet .catch above) is forward-declared below and intentionally
    // omitted from deps: pump → fallBackToWhisper → ensureWorker → pump is a cycle, so listing it would TDZ
    // at render. All four callbacks are stable (created once), so pump's captured reference never goes stale.
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
      themRunRef.current = '' // crash wipes the in-progress 'them' question turn (parity with stop()/start())
      closeChannel('you')
      closeChannel('them')
      void window.toto.setListeningState(false).catch(() => {})
      setState((s) => ({ ...s, error: err.message || 'transcription worker error', listening: false, loading: false }))
      busy.current = false
      workerRef.current?.terminate()
      workerRef.current = null
      readyRef.current = false
      crashedRef.current = true // the crash handler already tore everything down — stop() must not redo it
    }
    workerRef.current = w
    return w
  }, [pump])

  // Repeated Parakeet failures mid-session → permanently switch this session to Whisper so transcription
  // keeps working (mirrors the init-time fallback in start()). The window that tripped the threshold is
  // lost, but every subsequent window is transcribed by Whisper once its worker finishes loading.
  // (ensureWorker/getAsrBundled are stable; referenced from pump above before this line — fine at call time.)
  const fallBackToWhisper = useCallback((): void => {
    if (engineRef.current !== 'parakeet') return // already switched
    console.warn('[listen] parakeet failing repeatedly — switching to Whisper for the rest of this session')
    engineRef.current = 'whisper'
    readyRef.current = false
    parakeetFailures.current = 0
    setState((s) => ({ ...s, loading: true, error: 'Switched to the Whisper engine after repeated errors.' }))
    void getAsrBundled()
      .then((bundled) => {
        ensureWorker().postMessage({ type: 'init', quality: loadedQualityRef.current ?? 'fast', bundled })
      })
      .catch(() => {})
  }, [ensureWorker, getAsrBundled])

  const pushAudio = useCallback(
    (sp: Speaker, audio: Float32Array): void => {
      if (!liveRef.current) return
      queue.current.push({ audio, speaker: sp })
      if (queue.current.length > MAX_QUEUE) {
        const dropped = queue.current.length - MAX_QUEUE
        queue.current.splice(0, dropped) // bound memory; drop oldest
        // Backpressure: transcription is falling behind capture, so audio windows are being lost (corrupts
        // the recap). Logged rather than silently swallowed so it's diagnosable instead of an invisible gap.
        console.warn(`[listen] audio backpressure: dropped ${dropped} window(s) (queue > ${MAX_QUEUE})`)
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
      // 'them' (system loopback): un-AGC'd call audio is typically 2–4× quieter than mic input and
      // often never crosses the fixed VAD ON/EMIT_RMS thresholds. A GainNode lifts it into the
      // detectable range without altering the mic channel or the VAD thresholds themselves.
      const gain = sp === 'them' ? ctx.createGain() : null
      if (gain) gain.gain.value = 3.0 // ~10 dB boost; safe headroom before digital clip at 1.0

      worklet.port.onmessage = (ev: MessageEvent): void => {
        const data = ev.data as { audio?: Float32Array }
        if (data.audio) {
          // First real emission from 'them' proves the channel is alive: cancel the watchdog AND clear
          // the soft note if it's already showing (loopback can arrive AFTER the 20 s window — the note
          // must not stay stuck for the rest of the session). Guarded by themHeardRef so this runs once.
          if (sp === 'them' && !themHeardRef.current) {
            themHeardRef.current = true
            if (themWatchdogRef.current) {
              clearTimeout(themWatchdogRef.current)
              themWatchdogRef.current = null
            }
            setState((s) => (s.error === THEM_SILENT_MSG ? { ...s, error: null } : s))
          }
          pushAudio(sp, data.audio)
        }
      }
      const ch: Channel = { ctx, src, worklet, stream, gain: gain ?? undefined }
      channels.current[sp] = ch
      if (gain) {
        src.connect(gain)
        gain.connect(worklet)
      } else {
        src.connect(worklet)
      }
      worklet.connect(ctx.destination) // keeps the node processing; output stays silent

      // Watchdog: if 'them' is open for THEM_WATCHDOG_MS with zero windows the loopback is likely
      // still too quiet or the SCKit session is misconfigured. Surface a soft, non-fatal note the UI
      // can display — mic keeps working, teardown is NOT triggered.
      if (sp === 'them') {
        themHeardRef.current = false // fresh channel — re-arm first-emission detection
        if (themWatchdogRef.current) clearTimeout(themWatchdogRef.current)
        themWatchdogRef.current = setTimeout(() => {
          themWatchdogRef.current = null
          if (liveRef.current && channels.current.them) {
            setState((s) => ({ ...s, error: THEM_SILENT_MSG }))
          }
        }, THEM_WATCHDOG_MS)
      }
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
      // A stop() may still be draining — cancel its initial kickoff timer and reset the stopping guard so
      // this fresh session is not torn down when finishTeardown fires for the previous stop().
      if (drainTimerRef.current) {
        clearTimeout(drainTimerRef.current)
        drainTimerRef.current = null
      }
      stoppingRef.current = false
      sessionEpochRef.current += 1
      queue.current = []
      busy.current = false
      liveRef.current = true
      crashedRef.current = false // fresh session — re-enable stop()'s teardown after any prior crash
      parakeetFailures.current = 0 // reset the failure streak so a new session gets a clean shot at Parakeet
      parakeetEmptyRunRef.current = 0 // clear the empty-window run counter for a fresh session
      engineRef.current = engine
      themRunRef.current = '' // fresh session → no carried-over 'them' question turn
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

      if (!liveRef.current) return

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
      let sysErr: Error | null = null // captured for error-message classification below

      if (source === 'mic' || source === 'both') {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
          })
          if (!liveRef.current) {
            mic.getTracks().forEach((t) => t.stop())
            closeChannel('you')
            closeChannel('them')
            setState((s) => ({ ...s, listening: false }))
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
            // macOS: system-audio loopback only arrives inside a ScreenCaptureKit screen stream —
            // getDisplayMedia({ audio: true }) alone fails with "Error starting capture".  We
            // request a minimal 1fps video track to start the SCKit session.
            //
            // IMPORTANT: do NOT call t.stop() on the video track here.  On macOS, the video and
            // audio loopback share a single ScreenCaptureKit SCStream session.  Stopping the video
            // track before the audio worklet is connected can terminate that SCStream, leaving the
            // audio track in readyState='ended' — alive in getAudioTracks() but producing no PCM.
            // openChannel() stores the full stream (video + audio); closeChannel() calls t.stop()
            // on every track when Listen ends, releasing the recording indicator cleanly then.
            sys = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true })
          } finally {
            await window.toto.armAudio(false)
          }
          // Verify a live (non-ended) audio track is present.  If Screen Recording permission is
          // missing, main's handler returns callback({}) which makes getDisplayMedia throw AbortError
          // (caught below as isSysPermDenied).  If permission is granted but the track is already
          // ended (rare SCKit version mismatch), surface that explicitly rather than passing a
          // silent stream to the worklet.
          const liveAudio = sys.getAudioTracks().filter((t) => t.readyState !== 'ended')
          if (!liveAudio.length) {
            sys.getTracks().forEach((t) => t.stop())
            throw new Error('no system audio track') // non-abort → isSysPermDenied = false below
          }
          if (!liveRef.current) {
            sys.getTracks().forEach((t) => t.stop())
            closeChannel('you')
            closeChannel('them')
            setState((s) => ({ ...s, listening: false }))
            return
          }
          await openChannel('them', sys)
          sysOk = true
        } catch (e) {
          sysErr = e as Error
          console.warn('[listen] system-audio capture failed:', sysErr?.name, sysErr?.message)
        }
      }

      // AbortError or NotAllowedError from getDisplayMedia almost always means Screen Recording
      // permission was denied.  main's setDisplayMediaRequestHandler uses { useSystemPicker: false }
      // so there is NO user-facing picker to cancel — callback({}) from the main guard (fired when
      // desktopCapturer.getSources() returns empty due to missing permission) is what throws AbortError
      // in the renderer.  Surface the real cause rather than blaming a sleeping display.
      const isSysPermDenied =
        sysErr !== null &&
        (sysErr.name === 'AbortError' ||
          sysErr.name === 'NotAllowedError' ||
          /abort/i.test(sysErr.message ?? ''))

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
        let msg: string
        if (source === 'system') {
          msg = isSysPermDenied
            ? 'System audio needs Screen Recording permission — grant it in System Settings → Privacy & Security → Screen Recording, then restart Listen.'
            : "Couldn't capture system audio. Grant Screen Recording in System Settings, or switch Listen to your microphone in Settings → Audio."
        } else {
          msg = "Couldn't start the microphone. Check Microphone access in System Settings → Privacy & Security → Microphone."
        }
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
      let note: string | null = null
      if (source === 'both' && micOk && !sysOk) {
        note = isSysPermDenied
          ? 'System audio needs Screen Recording permission. Listening to microphone only — grant it in System Settings → Privacy & Security → Screen Recording, then restart Listen.'
          : 'System audio unavailable. Listening to your microphone only. Grant Screen Recording to hear the other side.'
      } else if (source === 'both' && !micOk && sysOk) {
        note = 'Microphone unavailable. Listening to system audio only.'
      }
      setState((s) => ({ ...s, error: note, listening: true, loading: !readyRef.current }))
    },
    // closeChannel referenced in body (defined below); stable useCallback, omitted to avoid TDZ in deps
    [ensureWorker, openChannel, pump]
  )

  const closeChannel = useCallback((sp: Speaker): void => {
    const ch = channels.current[sp]
    if (!ch) return
    // Clear the 'them' watchdog so it cannot fire after the channel is gone.
    if (sp === 'them' && themWatchdogRef.current) {
      clearTimeout(themWatchdogRef.current)
      themWatchdogRef.current = null
    }
    ch.worklet.disconnect()
    ch.worklet.port.onmessage = null
    ch.gain?.disconnect() // disconnect the boost node if present (them channel only)
    ch.src.disconnect()
    ch.stream.getTracks().forEach((t) => t.stop())
    void ch.ctx.close().catch(() => {})
    delete channels.current[sp]
  }, [])

  const stoppingRef = useRef(false) // double-stop guard
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null) // pending initial drain kickoff timer
  const sessionEpochRef = useRef(0) // incremented each start(); drain/finishTeardown bails if epoch changed
  const stop = useCallback((): void => {
    // crashedRef → the worker onerror handler already ran the full teardown; running it again here would
    // thrash state (re-fire setListeningState(false), wipe the crash error) → the "dead-end" tray mismatch.
    if (stoppingRef.current || crashedRef.current) return // already stopping or already torn down by a crash
    stoppingRef.current = true
    const myEpoch = sessionEpochRef.current

    // 1. Flush each open worklet's partial accumulation buffer WHILE liveRef is still true so that
    //    any flushed audio message routes through pushAudio → pump → commitLine before teardown.
    const speakers: Speaker[] = ['you', 'them']
    for (const sp of speakers) {
      const ch = channels.current[sp]
      if (ch) {
        try {
          ch.worklet.port.postMessage('flush')
        } catch {
          /* ignore if port is already closed */
        }
      }
    }

    // 2. Tear down only once the flushed final window has actually been transcribed — i.e. the queue
    //    has drained AND no decode is in flight (busy=false). The old fixed 250ms timer could fire
    //    mid-decode, and commitLine (gated on liveRef) would drop the last sentence once liveRef flipped
    //    false. liveRef stays TRUE through the drain so that final window still commits. A hard ceiling
    //    guards against a hung/never-returning decode wedging teardown.
    const DRAIN_CEILING_MS = 4000
    const startedAt = Date.now()
    const finishTeardown = (): void => {
      // A new start() ran while we were draining — it already owns the session; do not clobber it.
      // Leave stoppingRef alone: start() already reset it for the new session, so an old-epoch tick
      // clearing it here would weaken that session's double-stop guard.
      if (sessionEpochRef.current !== myEpoch) return
      liveRef.current = false
      queue.current = [] // drop anything still undispatched past the ceiling so it can't leak into the next session
      themRunRef.current = '' // run after the drain: any final flushed question already fired while liveRef was true
      closeChannel('you')
      closeChannel('them')
      void window.toto.setListeningState(false).catch(() => {})
      setState((s) => ({ ...s, listening: false, loading: false, error: null }))
      drainTimerRef.current = null
      stoppingRef.current = false
      // Release the whisper worker (+ ~21MB ONNX wasm + loaded model) after a few idle minutes so it
      // does not sit resident for the entire life of an always-on overlay. ensureWorker() recreates it
      // and start() re-inits the model on the next session; re-arming within the window keeps it warm.
      if (workerIdleTimer.current) clearTimeout(workerIdleTimer.current)
      workerIdleTimer.current = setTimeout(() => {
        workerRef.current?.terminate()
        workerRef.current = null
        readyRef.current = false
        workerIdleTimer.current = null
      }, WORKER_IDLE_RELEASE_MS)
    }
    const waitForDrain = (): void => {
      // A new start() ran — the previous stop()'s drain must not proceed; the new session owns the state.
      // (Leave stoppingRef alone, same reason as finishTeardown.)
      if (sessionEpochRef.current !== myEpoch) return
      if ((queue.current.length === 0 && !busy.current) || Date.now() - startedAt > DRAIN_CEILING_MS) {
        finishTeardown()
        return
      }
      // Track the re-arm in drainTimerRef so a fresh start() can cancel a still-pending drain tick.
      drainTimerRef.current = setTimeout(waitForDrain, 60)
    }
    // Give the worklet's flush message a tick to post its final window into the queue, then wait for drain.
    drainTimerRef.current = setTimeout(waitForDrain, 80)
  }, [closeChannel])

  const clear = useCallback((): void => {
    setLines([])
    themRunRef.current = '' // wiping the transcript also drops any in-progress 'them' question turn
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
