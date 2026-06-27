import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranscriptLine } from '@shared/ipc'

const SR = 16000
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

export function useListen(onQuestion?: (line: TranscriptLine) => void): ListenApi {
  const [state, setState] = useState({
    listening: false,
    ready: false,
    loading: false,
    error: null as string | null
  })
  const [lines, setLines] = useState<TranscriptLine[]>([])

  const workerRef = useRef<Worker | null>(null)
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
      const workletUrl = new URL('./whisper-worklet.ts', import.meta.url).href
      await ctx.audioWorklet.addModule(workletUrl)
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
      try {
        if (source === 'mic' || source === 'both') {
          const mic = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
          })
          await openChannel('you', mic)
          micOk = true
        }
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
            if (sys.getAudioTracks().length) await openChannel('them', sys)
            else throw new Error('No system audio track')
          } catch (sysErr) {
            if (micOk) {
              // degrade to mic-only rather than killing the whole session
              setState((s) => ({
                ...s,
                error: 'System audio unavailable — listening to your mic only. Grant Screen Recording for both sides.'
              }))
            } else {
              throw sysErr
            }
          }
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
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [stop])

  return { ...state, lines, start, stop, clear, text }
}
