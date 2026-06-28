import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranscriptLine } from '@shared/ipc'

const SR = 16000
const WINDOW_SEC = 6
const MAX_QUEUE = 24 // ~2.4 min of audio; drop oldest if the model is slow/failed to load
export type AudioSource = 'mic' | 'system' | 'both'
type Speaker = 'them' | 'you'

// The AudioWorklet processor, inlined as a Blob URL. Vite compiles Workers (new Worker(new URL(...))) but
// NOT AudioWorklets (audioWorklet.addModule), so the old `new URL('./whisper-worklet.ts', import.meta.url)`
// shipped an unbuilt path and addModule rejected with "The user aborted a request." — which broke Listen
// entirely (looked like a mic-permission error, was actually the worklet failing to load). Inlining is
// bundler-proof and loads under file:// in the packaged app.
const WORKLET_SRC = `
const WINDOW_SAMPLES = ${SR} * ${WINDOW_SEC}
class WhisperWorklet extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(WINDOW_SAMPLES); this.fill = 0 }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0] || input[0].length === 0) return true
    const data = input[0]
    let offset = 0
    while (offset < data.length) {
      const take = Math.min(WINDOW_SAMPLES - this.fill, data.length - offset)
      this.buf.set(data.subarray(offset, offset + take), this.fill)
      this.fill += take
      offset += take
      if (this.fill >= WINDOW_SAMPLES) {
        const chunk = this.buf.slice(0, WINDOW_SAMPLES)
        this.port.postMessage({ audio: chunk }, [chunk.buffer])
        this.fill = 0
      }
    }
    return true
  }
}
registerProcessor('whisper-worklet', WhisperWorklet)
`
let workletBlobUrl = ''
function workletModuleUrl(): string {
  if (!workletBlobUrl) workletBlobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
  return workletBlobUrl
}

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
  start: (source: AudioSource) => Promise<void>
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
    error: null as string | null
  })
  const [lines, setLines] = useState<TranscriptLine[]>([])

  const workerRef = useRef<Worker | null>(null)
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

  const pump = useCallback((): void => {
    if (!readyRef.current || busy.current || !workerRef.current || queue.current.length === 0) return
    busy.current = true
    const job = queue.current.shift() as { audio: Float32Array; speaker: Speaker }
    workerRef.current.postMessage({ type: 'audio', audio: job.audio, speaker: job.speaker }, [
      job.audio.buffer
    ])
  }, [])

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current
    const w = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent): void => {
      const m = e.data as { type: string; text?: string; speaker?: Speaker; message?: string }
      if (m.type === 'ready') {
        readyRef.current = true
        setState((s) => ({ ...s, ready: true, loading: false }))
        pump() // drain windows captured while the model loaded
      } else if (m.type === 'error') {
        setState((s) => ({ ...s, error: m.message ?? 'transcription error', loading: false }))
        busy.current = false
        pump()
      } else if (m.type === 'text') {
        if (m.text && liveRef.current) {
          const line: TranscriptLine = {
            speaker: (m.speaker as Speaker) || 'you',
            text: m.text,
            t: Date.now()
          }
          // Update the ref synchronously BEFORE firing onQ, so text() (read inside the handler)
          // already includes the line that triggered the auto-answer.
          const next = [...linesRef.current, line]
          linesRef.current = next
          setLines(next)
          if (line.speaker === 'them' && isQuestion(line.text)) onQRef.current?.(line)
        }
        busy.current = false
        pump()
      }
    }
    w.onerror = (err: ErrorEvent): void => {
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
      await ctx.audioWorklet.addModule(workletModuleUrl())
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
    async (source: AudioSource): Promise<void> => {
      if (workerIdleTimer.current) {
        clearTimeout(workerIdleTimer.current) // re-arming before the idle release fires: keep the worker warm
        workerIdleTimer.current = null
      }
      queue.current = []
      busy.current = false
      liveRef.current = true
      setState((s) => ({ ...s, loading: !readyRef.current, error: null, listening: true }))
      try {
        await window.toto.setListeningState(true)
      } catch {
        /* main may not have a tray; ignore */
      }
      ensureWorker().postMessage({ type: 'init', model: 'Xenova/whisper-tiny' }) // multilingual
      let micOk = false
      let sysOk = false
      const MIC_HELP =
        'Allow Microphone for AskToto in System Settings → Privacy & Security, then start Listen again.'
      const openMic = async (): Promise<void> => {
        // Request the OS mic permission up front (shows the prompt the first time) so getUserMedia doesn't
        // reject with an opaque "the user aborted a request" when the mic hasn't been granted yet.
        const granted = await window.toto.requestMicAccess().catch(() => true)
        if (!granted) throw new Error(MIC_HELP)
        let mic: MediaStream
        try {
          mic = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
          })
        } catch {
          throw new Error(MIC_HELP)
        }
        await openChannel('you', mic)
        micOk = true
      }
      try {
        // 1. Mic = the reliable channel. Open it first whenever it's requested.
        if (source === 'mic' || source === 'both') await openMic()
        // 2. System audio = best-effort. Needs macOS Screen Recording; if it's denied or the request is
        //    cancelled ("user aborted"), NEVER kill the session — fall back to the mic and carry on.
        if (source === 'system' || source === 'both') {
          try {
            await window.toto.armAudio(true) // arm the loopback handler only for this request
            let sys: MediaStream
            try {
              // Audio-only loopback: the main handler returns audio: 'loopback' and never a video track.
              sys = await navigator.mediaDevices.getDisplayMedia({ audio: true })
            } finally {
              await window.toto.armAudio(false)
            }
            if (sys.getAudioTracks().length) {
              await openChannel('them', sys)
              sysOk = true
            } else {
              throw new Error('No system audio track')
            }
          } catch {
            if (!micOk) {
              try {
                await openMic() // system asked for but unavailable → at least hear the user
              } catch {
                /* mic fallback failed too → handled by the not-anything check below */
              }
            }
            if (micOk) {
              setState((s) => ({
                ...s,
                error:
                  'Hearing your mic. To also capture the other side of the call, turn on Screen Recording in Settings → Privacy & Security, then start Listen again.'
              }))
            }
          }
        }
        if (!micOk && !sysOk) {
          throw new Error(
            'Microphone unavailable. Allow Microphone for AskToto in System Settings → Privacy & Security, then start Listen again.'
          )
        }
      } catch (err) {
        // hard failure: tear everything down so no channel stays hot while UI says "not listening"
        liveRef.current = false
        closeChannel('you')
        closeChannel('them')
        try {
          await window.toto.setListeningState(false)
        } catch {
          /* ignore */
        }
        setState((s) => ({
          ...s,
          error: err instanceof Error ? err.message : String(err),
          listening: false,
          loading: false
        }))
        // A failed start shouldn't pin the whisper worker + ~21MB ONNX wasm in memory for the app's life —
        // arm the same idle release stop() uses (ensureWorker recreates it on the next start()).
        if (workerIdleTimer.current) clearTimeout(workerIdleTimer.current)
        workerIdleTimer.current = setTimeout(() => {
          workerRef.current?.terminate()
          workerRef.current = null
          readyRef.current = false
          workerIdleTimer.current = null
        }, WORKER_IDLE_RELEASE_MS)
      }
    },
    // closeChannel referenced in body (defined below); stable useCallback, omitted to avoid TDZ in deps
    [ensureWorker, openChannel]
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

  return { ...state, lines, start, stop, clear, text }
}
