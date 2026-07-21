import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptLine } from '@shared/ipc'
import { collapseRepeatedPhrase, isNonSpeechLine, repeatKey } from '@shared/transcript-filter'
import { detectLanguage } from '@shared/lang-id'
import { WHISPER_WORKLET_SRC } from './whisper-worklet-src'
import { isWindows } from './keys'
import { compileEntityCasingCandidates, applyEntityCasingCompiled } from './entity-casing'
import { transcriptToText } from './transcript'
import { shouldUseBundledAsr } from './asr-offline'

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
// Cross-line half of the repetition-loop guard (intra-line half = collapseRepeatedPhrase): a looping
// decoder returns the identical line for window after window; real speech repeats the same normalized
// line at most once. Two consecutive copies stay, the rest of the run is dropped.
const MAX_CONSECUTIVE_DUPES = 2
const PARAKEET_MAX_FAILURES = 3 // consecutive Parakeet failures → fall back to Whisper for the rest of the session
const PARAKEET_EMPTY_RUN_MAX = 5 // consecutive '' returns on flowing audio → treat as engine stall, fall back to Whisper
const THEM_WATCHDOG_MS = 20_000 // 20 s with the 'them' channel open but no window emitted → surface soft note
// Exact text of the soft "not hearing the other side" note, shared by the watchdog (sets it) and the
// first-'them'-emission handler (clears it) so loopback arriving AFTER the watchdog fired isn't left stuck.
const THEM_SILENT_MSG = isWindows
  ? 'Not hearing the other side. Check the call volume and that the meeting is playing through your default output device.'
  : 'Not hearing the other side. Check the call volume and that Screen Recording is granted.'
// Silent-capture-death recovery notes. A Bluetooth headset disconnect, default-device change, or
// lid-close sleep kills a capture track with no error anywhere — the UI kept saying "Listening" while
// a whole side of the meeting was silently lost. Matched by exact string (same contract as the notes above).
const MIC_LOST_MSG = 'Microphone input stopped (device disconnected or sleep); reconnecting automatically…'
const THEM_LOST_MSG =
  'System-audio capture stopped (display sleep or a device change); reconnecting automatically…'
// Backpressure became user-visible truncation: transcription fell behind capture long enough that
// audio windows were discarded. Exact-string contract like the other sticky notes.
const DROPPED_MSG = 'Transcription fell behind, so some audio was skipped. The transcript may have gaps.'
// Exact text of the "offline, waiting to reconnect" / "reconnected, restarting" notes, shared by
// armNetworkRetry (sets them) and the worker's 'ready' handler (clears them once recovery succeeds) —
// matched by exact string so other sticky notes (THEM_SILENT_MSG, the Parakeet-fallback footnote) are
// never accidentally cleared by a network recovery that has nothing to do with them.
const OFFLINE_MSG =
  "No internet connection. The speech model is paused and will restart automatically once you're back online."
const RECONNECTING_MSG = 'Back online. Restarting the speech model…'
// A model-load failure that looks connectivity-related (DNS/fetch/ECONNREFUSED-style messages
// transformers.js/fetch surface), so it can be distinguished from a genuine non-network load failure
// (e.g. a missing bundled file) — which should surface as-is instead of wrongly claiming "you're offline".
const NETWORK_ERR =
  /network|fetch failed|enotfound|econnrefused|getaddrinfo|offline|dns|failed to fetch|err_internet_disconnected/i

/** Exported for unit testing — the pure decision behind armNetworkRetry (see useListen below). */
export function looksLikeNetworkError(message: string, online: boolean): boolean {
  return !online || NETWORK_ERR.test(message)
}
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
// Terminal question-mark variants beyond ASCII '?' (U+003F): fullwidth '？' (U+FF1F, CJK) and Arabic '؟'
// (U+061F) — Whisper transcribes many languages with these, so relying on endsWith('?') alone silently
// dropped every non-English question from proactive auto-suggest.
const TERMINAL_Q = /[?？؟]$/
// QWORDS is a hard-coded English word list — only meaningful for space-delimited Latin-script clauses.
// Gate the word-count/QWORDS branch on that so it can't misfire on non-Latin text (CJK/Arabic/Cyrillic,
// which QWORDS wouldn't match anyway and which TERMINAL_Q already handles). Cover the full Latin range,
// NOT just ASCII: Whisper/entity-casing emit a curly apostrophe (U+2019 in "What's"/"don't"/"L'Oréal")
// and accented letters (café, naïve) — a pure-ASCII gate silently dropped every such English question.
const LATIN_CLAUSE = /^[\x00-ɏ‘’“”–—…]*$/
export function isQuestion(t: string): boolean {
  const s = t.trim()
  if (!s) return false
  if (TERMINAL_Q.test(s)) return true // explicit terminal punctuation → complete even when short
  // Evaluate only the run's last clause: an accumulated/long turn may carry a completed leading sentence
  // (e.g. "So we shipped the update. What should we prioritize") -- QWORDS must match that clause's opening
  // word, not the whole run's, or a finished non-question opener permanently blocks every later question
  // in the same 'them' turn.
  const lastClause = s.split(/(?<=[.!?？؟])\s+/).pop() ?? s
  if (DANGLING.test(lastClause.replace(/[.,;:!?？؟\s]+$/, ''))) return false // still mid-sentence → not yet a question
  return LATIN_CLAUSE.test(lastClause) && lastClause.split(/\s+/).length >= 3 && QWORDS.test(lastClause)
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
  /** True only once capture is actually confirmed (mic and/or system audio channel open) — see the
   *  `capturing` field on the internal state above for why this must not be conflated with `listening`. */
  capturing: boolean
  paused: boolean
  ready: boolean
  loading: boolean
  lines: TranscriptLine[]
  error: string | null
  loadingPct: number | null // model-loading progress when the worker reports it; otherwise null
  // True once the active worker reports that 'best' quality was requested but did NOT get the WebGPU/
  // large model (no bundled model, no WebGPU adapter, or a WebGPU load failure) — every packaged build
  // hits this, since the large model is deliberately excluded from release resources. Lets a caller show
  // an honest "reduced" state instead of the toggle silently always running whisper-base.
  qualityDegraded: boolean
  start: (
    source: AudioSource,
    quality?: 'best' | 'fast',
    engine?: 'whisper' | 'parakeet' | 'apple',
    language?: string
  ) => Promise<void>
  /** onDrained (optional) fires once the up-to-DRAIN_CEILING_MS post-stop drain has fully settled — i.e.
   *  after the final flushed window has committed via commitLine, so `text()` read inside it reflects the
   *  complete transcript. Skipped if a fresh start() supersedes this session before the drain finishes. */
  stop: (onDrained?: () => void) => void
  /** Suspend capture without ending the meeting — the transcript, worker, and (on macOS) the fragile
   *  system-audio loopback session all stay warm so resume() picks back up mid-session. */
  pause: () => void
  resume: () => void
  clear: () => void
  text: () => string
  /** Apply a changed spoken-language setting to the RUNNING session (no capture restart): Whisper gets
   *  a warm re-init (the worker updates its language-follow seed before the already-loaded early
   *  return), Apple Speech reads settings per window main-side, Parakeet always auto-detects. */
  setLanguage: (language: string) => Promise<void>
}

const WORKER_IDLE_RELEASE_MS = 180_000 // 3 min: free the whisper worker + ONNX wasm after Listen goes idle

/** Escapes regex metacharacters so a user-typed correction word can't corrupt the pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Acquire the microphone, honouring a chosen deviceId when one is set. If that specific device has gone
 * away (e.g. AirPods disconnected), fall back to the system default so a meeting never loses its mic over
 * a device that vanished. Empty deviceId means "follow the system default" from the start.
 */
async function acquireMic(deviceId: string): Promise<MediaStream> {
  const base: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  if (!deviceId) return navigator.mediaDevices.getUserMedia({ audio: base })
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } })
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: base })
  }
}

export function useListen(
  onQuestion?: (line: TranscriptLine) => void,
  corrections?: { from: string; to: string }[],
  // Fired on a mid-session Parakeet→Whisper fallback. Deliberately NOT surfaced as a live error state —
  // it's a background engine swap, not something worth interrupting the meeting for — so the caller can
  // persist it to Settings (a checkable trace) instead of the UI showing an alarming banner.
  onEngineFallback?: (reason: string) => void,
  // Preferred microphone deviceId ('' = system default). Read through a ref so a change mid-session takes
  // effect on the next (re)acquire without re-subscribing anything.
  micDeviceId?: string,
  // Canonical people/account names from the brain (brain:entityNames), for the ASR entity-casing bias —
  // spells a known name correctly (e.g. "l'oreal" -> "L'Oréal") without any fuzzy/phonetic guessing. Gated
  // by settings.asrEntityBias in App.tsx (pass undefined/[] to disable). Applied AFTER asrCorrections so
  // an explicit user correction always wins.
  entityNames?: string[]
): ListenApi {
  const [state, setState] = useState({
    listening: false,
    // True only once at least one audio channel (mic or system loopback) has actually opened — distinct
    // from `listening`, which flips true optimistically at the top of start() before mic/system acquisition
    // even begins. Consumers that gate a "you are being recorded" consent indicator should read this
    // instead of `listening`, so the banner can't flash on a start() that ultimately fails to capture
    // anything (see the both-failed early-return branch below, which never sets this true).
    capturing: false,
    paused: false,
    ready: false,
    loading: false,
    error: null as string | null,
    loadingPct: null as number | null,
    qualityDegraded: false
  })
  const [lines, setLines] = useState<TranscriptLine[]>([])

  const workerRef = useRef<Worker | null>(null)
  const loadedQualityRef = useRef<'best' | 'fast' | null>(null) // quality the warm worker was loaded with
  // The quality the USER actually asked for when start() was called, captured unconditionally of engine
  // and independent of loadedQualityRef (which stays null whenever the whisper worker hasn't loaded yet,
  // e.g. mid-Parakeet/Apple session). fallBackToWhisper and armNetworkRetry's retry() read this so a
  // mid-session engine swap or a network-recovery reload honors the original choice instead of 'fast'.
  const requestedQualityRef = useRef<'best' | 'fast'>('fast')
  // Spoken-language hint from settings ('auto' or a language display name, e.g. 'Portuguese'). Read
  // through a ref for the same reason as requestedQualityRef: fallback/retry re-inits fire long after
  // start() returned and must re-send the language the session was started with.
  const asrLanguageRef = useRef<string>('auto')
  const engineRef = useRef<'whisper' | 'parakeet' | 'apple'>('whisper') // active ASR engine for this session
  // Cached bundled-model flag: queried once from the main process and reused for every init message.
  // Fail closed on an IPC/preload error: installed builds must never turn a broken capability probe into
  // a remote model fetch. `false` is returned deliberately by the main process only for an unprovisioned
  // development build.
  const asrBundledRef = useRef<boolean | null>(null)
  const getAsrBundled = useCallback(async (): Promise<boolean> => {
    if (asrBundledRef.current === null) {
      const bundledProbe = await window.toto.asrBundled().catch(() => undefined)
      asrBundledRef.current = shouldUseBundledAsr(import.meta.env.PROD, bundledProbe)
    }
    return asrBundledRef.current
  }, [])
  const workerIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const channels = useRef<Partial<Record<Speaker, Channel>>>({})
  const queue = useRef<{ audio: Float32Array; speaker: Speaker }[]>([])
  const busy = useRef(false)
  const readyRef = useRef(false)
  const liveRef = useRef(false) // true only between start() and stop() — guards stale results
  // Synchronous in-flight guard for start(): a rapid double-click/double-hotkey on Listen calls start()
  // twice before React re-renders listen.listening to true (that state update is async), so a boolean
  // ref — set synchronously at the very top of start(), before any `await` — is required; guarding on
  // component state or disabling the button is not enough to stop the second call from ever entering.
  // Cleared in start()'s own `finally` on every exit path (success, failure, or early return), so it
  // can never wedge a later, legitimate session.
  const startingRef = useRef(false)
  const pausedRef = useRef(false) // true only between pause() and resume() — belt-and-suspenders on pushAudio;
  // suspending each channel's AudioContext already stops the worklet from emitting in the first place.
  const crashedRef = useRef(false) // set in worker onerror (it already tore down) → stop() must not redo it
  const parakeetFailures = useRef(0) // consecutive Parakeet IPC failures → switch to Whisper after a few
  const parakeetEmptyRunRef = useRef(0) // consecutive '' returns on flowing audio → engine stall detection
  const themWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null) // fires if 'them' emits nothing for THEM_WATCHDOG_MS
  const themHeardRef = useRef(false) // flips true on the first real 'them' window so we clear the watchdog note exactly once
  const onQRef = useRef(onQuestion)
  onQRef.current = onQuestion
  const onFallbackRef = useRef(onEngineFallback)
  onFallbackRef.current = onEngineFallback
  // Compiled once per corrections-list change (not per line) — word-boundary + case-insensitive so
  // correcting "Toto" never also corrupts "Tomato".
  const correctionsRef = useRef<{ re: RegExp; to: string }[]>([])
  correctionsRef.current = (corrections ?? [])
    .filter((c) => c.from.trim())
    .map((c) => ({ re: new RegExp(`\\b${escapeRegExp(c.from.trim())}\\b`, 'gi'), to: c.to }))
  // Compiled once per entityNames-list change (not per line), same idiom as correctionsRef above.
  const entityCasingRef = useRef<ReturnType<typeof compileEntityCasingCandidates>>([])
  entityCasingRef.current = compileEntityCasingCandidates(entityNames ?? [])
  // Preferred mic, read through a ref so the latest choice is used on every (re)acquire.
  const micDeviceIdRef = useRef<string>('')
  micDeviceIdRef.current = micDeviceId ?? ''
  const linesRef = useRef<TranscriptLine[]>([])
  linesRef.current = lines
  // Trailing run of consecutive 'them' speech (joined) since the last 'you' turn or last auto-answer fire.
  // The auto-answer endpoints on this COALESCED turn rather than a single VAD window, so a question split
  // across windows by a mid-sentence hesitation pause (more likely now the endpoint is a snappy 0.6s) still
  // fires once and complete — instead of firing on the truncated first fragment and then being locked out
  // by the App-level suggest throttle. Reset on a 'you' line, on fire, and on start()/clear().
  const themRunRef = useRef('')
  // Trailing run of consecutive committed lines with the same normalized text + speaker — the state for
  // the MAX_CONSECUTIVE_DUPES guard. Reset on start() so a phrase legitimately reopening a new meeting
  // is never suppressed by the previous session's tail.
  const repeatRunRef = useRef<{ key: string; speaker: string; count: number }>({ key: '', speaker: '', count: 0 })

  // Add a transcribed line + fire the auto-answer hook. Shared by the Whisper worker and Parakeet paths.
  // `name` is the optional Speaker Intelligence label (main-side voice embedding on THEM windows) — the
  // same additive field the Teams-VTT backfill writes, so render/save paths need no change.
  const commitLine = useCallback((text: string, speaker: Speaker, name?: string): void => {
    // Drop phantom/hallucinated lines + non-speech sound-event captions ("[BELL RINGS]", "(applause)",
    // "♪♪♪") before touching state — so they never display live, never reach the recap, never get saved.
    // Single chokepoint for both the Whisper worker and Parakeet paths.
    if (isNonSpeechLine(text)) return
    // Collapse an intra-line decoder loop BEFORE corrections/casing so those run on the short form.
    let corrected = collapseRepeatedPhrase(text)
    for (const { re, to } of correctionsRef.current) corrected = corrected.replace(re, to)
    // Entity-casing bias runs AFTER corrections so an explicit user correction always wins.
    if (entityCasingRef.current.length) corrected = applyEntityCasingCompiled(entityCasingRef.current, corrected)
    if (corrected && liveRef.current) {
      // Cross-line repetition-loop guard: same normalized line, same speaker, window after window.
      const key = repeatKey(corrected)
      const run = repeatRunRef.current
      if (key && run.key === key && run.speaker === (speaker || 'you')) {
        run.count += 1
        if (run.count > MAX_CONSECUTIVE_DUPES) return // keep counting so the whole run stays suppressed
      } else {
        repeatRunRef.current = { key, speaker: speaker || 'you', count: 1 }
      }
      // Tag the line's spoken language (conservative: undefined unless confident) so mixed-language
      // meetings can render switch markers for the recap LLM and the saved transcript. Computed here —
      // the single chokepoint — so Parakeet and Apple Speech lines get tagged exactly like Whisper's.
      const lang = detectLanguage(corrected).lang ?? undefined
      const line: TranscriptLine = {
        speaker: speaker || 'you',
        text: corrected,
        t: Date.now(),
        ...(name ? { name } : {}),
        ...(lang ? { lang } : {})
      }
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
        .then((res) => {
          // Normalize both feed shapes: bare string (legacy/error paths) and {text, name?} (Speaker
          // Intelligence labels THEM windows main-side — see SPEAKER-INTELLIGENCE-PLAN §3).
          const text = typeof res === 'string' ? res : res.text
          const speakerName = typeof res === 'string' ? undefined : res.name
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
            commitLine(text, job.speaker, speakerName)
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
    if (engineRef.current === 'apple') {
      // Apple Speech (SFSpeechRecognizer, on-device) also runs in the MAIN process via the mac-helper
      // sidecar — same batch-per-window IPC contract as Parakeet above, just a different engine and IPC
      // channel. Reuses the exact same race-against-timeout / failure-count / empty-run / fallback-to-
      // Whisper logic (the two engines are mutually exclusive per session, so sharing the counters is safe).
      const feed = window.toto.appleSpeechFeed(job.audio, job.speaker)
      const timeout = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('apple speech feed timed out')), PARAKEET_FEED_TIMEOUT_MS)
      )
      void Promise.race([feed, timeout])
        .then((res) => {
          const text = typeof res === 'string' ? res : res.text
          const speakerName = typeof res === 'string' ? undefined : res.name
          parakeetFailures.current = 0 // success (even empty) resets the IPC-failure streak
          if (text === '') {
            parakeetEmptyRunRef.current += 1
            if (parakeetEmptyRunRef.current >= PARAKEET_EMPTY_RUN_MAX) {
              console.warn('[listen] apple speech returning empty every window — falling back to Whisper')
              fallBackToWhisper()
            }
          } else {
            parakeetEmptyRunRef.current = 0
            commitLine(text, job.speaker, speakerName)
          }
        })
        .catch((err) => {
          parakeetFailures.current += 1
          console.warn(
            `[listen] apple speech window failed (${parakeetFailures.current}/${PARAKEET_MAX_FAILURES}):`,
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
      const m = e.data as {
        type: string
        text?: string
        speaker?: Speaker
        message?: string
        engine?: string
        qualityDegraded?: boolean
      }
      if (m.type === 'log') {
        console.warn('[whisper]', m.message)
      } else if (m.type === 'progress') {
        setState((s) => ({ ...s, loadingPct: (m as { pct?: number }).pct ?? null }))
      } else if (m.type === 'ready') {
        readyRef.current = true
        if (m.engine) console.info('[whisper] engine:', m.engine)
        // Clear the offline/reconnecting note on a successful recovery — but ONLY that exact note, so an
        // unrelated sticky message (THEM_SILENT_MSG, the Parakeet-fallback footnote) is never clobbered.
        setState((s) => ({
          ...s,
          ready: true,
          loading: false,
          loadingPct: null,
          qualityDegraded: !!m.qualityDegraded,
          error: s.error === OFFLINE_MSG || s.error === RECONNECTING_MSG ? null : s.error
        }))
        pump() // drain windows captured while the model loaded
      } else if (m.type === 'error') {
        // armNetworkRetry is defined further down (after ensureWorker) and forward-referenced via closure
        // — same pattern as pump → fallBackToWhisper above. It only runs later, once this handler actually
        // fires, by which point it's fully initialized; deliberately omitted from this useCallback's deps.
        if (!armNetworkRetry(m.message ?? '')) {
          setState((s) => ({ ...s, error: m.message ?? 'transcription error', loading: false }))
        }
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
      pausedRef.current = false
      queue.current = []
      themRunRef.current = '' // crash wipes the in-progress 'them' question turn (parity with stop()/start())
      closeChannel('you')
      closeChannel('them')
      void window.toto.setListeningState(false).catch(() => {})
      setState((s) => ({
        ...s,
        error: err.message || 'transcription worker error',
        listening: false,
        capturing: false,
        paused: false,
        loading: false
      }))
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
  // keeps working, loading it at the quality the user actually asked for at start() (requestedQualityRef),
  // not whatever loadedQualityRef happens to hold (it's null throughout a Parakeet session — Whisper's
  // worker was never touched). The window that tripped the threshold is lost, but every subsequent window
  // is transcribed by Whisper once its worker finishes loading.
  // (ensureWorker/getAsrBundled are stable; referenced from pump above before this line — fine at call time.)
  const fallBackToWhisper = useCallback((): void => {
    if (engineRef.current !== 'parakeet' && engineRef.current !== 'apple') return // already switched
    const failedEngine = engineRef.current
    console.warn(`[listen] ${failedEngine} failing repeatedly — switching to Whisper for the rest of this session`)
    engineRef.current = 'whisper'
    readyRef.current = false
    parakeetFailures.current = 0
    onFallbackRef.current?.(`${failedEngine === 'apple' ? 'Apple Speech' : 'Parakeet'} failed repeatedly`)
    // loading only — no live `error` banner. The engine swap happens silently; onEngineFallback records
    // it somewhere checkable (Settings) instead of interrupting the meeting.
    setState((s) => ({ ...s, loading: true }))
    void getAsrBundled()
      .then((bundled) => {
        ensureWorker().postMessage({ type: 'init', quality: requestedQualityRef.current, bundled, language: asrLanguageRef.current })
      })
      .catch(() => {})
  }, [ensureWorker, getAsrBundled])

  // Pending 'online' listener for a network-caused Whisper load failure, so a second failure (or a fresh
  // session) can replace it instead of stacking listeners.
  const networkRetryCleanupRef = useRef<(() => void) | null>(null)
  const disarmNetworkRetry = useCallback((): void => {
    networkRetryCleanupRef.current?.()
    networkRetryCleanupRef.current = null
  }, [])

  /**
   * Whisper's model only needs the network the FIRST time it loads (the bundled/packaged app loads from
   * local resources and never touches the network at all — see whisper.worker.ts's allowRemoteModels
   * guard). So the only way wifi can break transcription is a load failure before the model is ready.
   * When that failure looks connectivity-related (offline, or the error text matches NETWORK_ERR), this
   * shows a clear, sticky note and automatically retries the load once the browser reports 'online' —
   * instead of leaving Whisper dead for the rest of the meeting with no visible explanation. Returns
   * false for a non-network load failure (or one after the model was already ready), so the caller falls
   * through to the original raw-error behavior unchanged.
   */
  const armNetworkRetry = useCallback(
    (rawMessage: string): boolean => {
      if (readyRef.current) return false // already loaded — a per-window error, not a load failure
      if (!looksLikeNetworkError(rawMessage, navigator.onLine)) return false // unrelated failure — surface as-is
      setState((s) => ({ ...s, loading: false, loadingPct: null, error: OFFLINE_MSG }))
      disarmNetworkRetry()
      const retry = (): void => {
        disarmNetworkRetry()
        if (!liveRef.current || readyRef.current || engineRef.current !== 'whisper') return
        setState((s) => ({ ...s, loading: true, loadingPct: null, error: RECONNECTING_MSG }))
        workerRef.current?.terminate()
        workerRef.current = null
        readyRef.current = false
        void getAsrBundled()
          .then((bundled) => {
            if (!liveRef.current || readyRef.current) return
            ensureWorker().postMessage({ type: 'init', quality: requestedQualityRef.current, bundled, language: asrLanguageRef.current })
          })
          .catch(() => {})
      }
      if (navigator.onLine) {
        // The connection is already back by the time we got here — retry now. The browser only fires
        // 'online' on a state TRANSITION, so waiting for a future event that may never come would wedge.
        retry()
      } else {
        window.addEventListener('online', retry)
        networkRetryCleanupRef.current = () => window.removeEventListener('online', retry)
      }
      return true
    },
    [disarmNetworkRetry, ensureWorker, getAsrBundled]
  )

  const pushAudio = useCallback(
    (sp: Speaker, audio: Float32Array): void => {
      if (!liveRef.current || pausedRef.current) return
      queue.current.push({ audio, speaker: sp })
      if (queue.current.length > MAX_QUEUE) {
        const dropped = queue.current.length - MAX_QUEUE
        queue.current.splice(0, dropped) // bound memory; drop oldest
        // Backpressure: transcription is falling behind capture, so audio windows are being lost (corrupts
        // the recap). Logged rather than silently swallowed so it's diagnosable instead of an invisible gap.
        console.warn(`[listen] audio backpressure: dropped ${dropped} window(s) (queue > ${MAX_QUEUE})`)
        // Surface it — a silent drop reads as "the transcript stopped" with no explanation. Never
        // clobber a more specific note already showing (offline, device-lost, them-silent).
        setState((s) => (s.error == null ? { ...s, error: DROPPED_MSG } : s))
      }
      pump()
    },
    [pump]
  )

  // Arms (or re-arms) the 'them'-silence watchdog: if no 'them' window has been emitted within
  // THEM_WATCHDOG_MS of this call, surface the soft THEM_SILENT_MSG note. Shared by openChannel (channel
  // just opened) and resume() (channel survives a pause, but the clock must restart from the resume point
  // — see resume()'s comment for why it must not keep ticking through a pause). No-op once themHeardRef is
  // already true, so it can never fire a false note after real 'them' audio has already been heard.
  function armThemWatchdog(): void {
    if (themWatchdogRef.current) clearTimeout(themWatchdogRef.current)
    if (themHeardRef.current) return
    themWatchdogRef.current = setTimeout(() => {
      themWatchdogRef.current = null
      if (liveRef.current && !pausedRef.current && channels.current.them) {
        setState((s) => ({ ...s, error: THEM_SILENT_MSG }))
      }
    }, THEM_WATCHDOG_MS)
  }

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
        channelCount: 1,
        // Default channelCountMode is 'max', which IGNORES channelCount and passes through however many
        // channels the upstream carries — 'them' (system loopback) is commonly stereo. 'explicit' +
        // 'speakers' makes the graph itself downmix L+R to mono before process() runs, instead of the
        // worklet silently reading only input[0] and dropping the right channel.
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers'
      })
      // 'them' (system loopback): un-AGC'd call audio is typically 2–4× quieter than mic input and
      // often never crosses the fixed VAD ON/EMIT_RMS thresholds. A GainNode lifts it into the
      // detectable range without altering the mic channel or the VAD thresholds themselves.
      // The boost also lifts steady background (hold music, fans) over those thresholds; the worklet's
      // emit-time envelope-spread gate (isSpeechLikeWindow in ./vad) drops those windows before the ASR.
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
      // If a pause is already in effect (e.g. this channel just finished mic/system-audio recovery mid-pause),
      // suspend it immediately instead of leaving it running until the next resume()/stop(). The onstatechange
      // handler below already guards on pausedRef.current, so it will correctly leave this suspended context alone.
      if (pausedRef.current) void ctx.suspend().catch(() => {})

      // Silent-death detection: a track that ends OUTSIDE our own teardown (Bluetooth disconnect,
      // default-device switch, lid-close sleep terminating the SCStream) previously left the UI saying
      // "Listening" while this side of the meeting was silently lost. (`track.stop()` from closeChannel
      // does NOT fire 'ended' on the stopping context, and the identity guard covers replaced channels.)
      // Both sides now surface a "reconnecting…" note and re-acquire automatically — mic via
      // recoverMicRef, system audio via recoverSystemAudioRef (which re-runs the programmatic arm-dance
      // getDisplayMedia; no user gesture is needed, so a blip no longer forces a "Toggle Listen" restart).
      stream.getAudioTracks().forEach((t) => {
        t.onended = (): void => {
          if (!liveRef.current || channels.current[sp] !== ch) return
          console.warn(`[listen] ${sp} audio track ended unexpectedly (device change / sleep)`)
          closeChannel(sp)
          if (sp === 'you') {
            setState((s) => ({ ...s, error: MIC_LOST_MSG }))
            void recoverMicRef.current?.()
          } else {
            setState((s) => ({ ...s, error: THEM_LOST_MSG }))
            void recoverSystemAudioRef.current?.()
          }
        }
      })
      // macOS can leave an AudioContext suspended after sleep/wake even when its tracks survive —
      // resume it instead of processing silence forever. But pause() ALSO suspends this same ctx on
      // purpose (see pause() below) — without the pausedRef check this handler would immediately
      // resume it right back, so an intentional pause could never actually stay suspended. Only an
      // UNEXPECTED suspension (OS/interruption) should be auto-resumed; a user-initiated pause must not.
      ctx.onstatechange = (): void => {
        if (liveRef.current && !pausedRef.current && channels.current[sp] === ch && ctx.state === 'suspended') {
          void ctx.resume().catch(() => {})
        }
      }

      // Watchdog: if 'them' is open for THEM_WATCHDOG_MS with zero windows the loopback is likely
      // still too quiet or the SCKit session is misconfigured. Surface a soft, non-fatal note the UI
      // can display — mic keeps working, teardown is NOT triggered.
      if (sp === 'them') {
        themHeardRef.current = false // fresh channel — re-arm first-emission detection
        armThemWatchdog()
      }
    },
    [pushAudio]
  )

  // Re-acquire the microphone after its track died (device disconnect / sleep) or the default input
  // moved (Bluetooth headset on/off). Kept in a ref so openChannel (defined above) can call it without
  // a circular useCallback dependency — same forward-reference pattern as pump/armNetworkRetry.
  const micRecoveringRef = useRef(false)
  const recoverMicRef = useRef<(() => Promise<void>) | null>(null)
  recoverMicRef.current = async (): Promise<void> => {
    if (!liveRef.current || micRecoveringRef.current) return
    micRecoveringRef.current = true
    try {
      const mic = await acquireMic(micDeviceIdRef.current)
      if (!liveRef.current) {
        mic.getTracks().forEach((t) => t.stop())
        return
      }
      await openChannel('you', mic)
      setState((s) => (s.error === MIC_LOST_MSG ? { ...s, error: null } : s))
    } catch {
      // Nothing to acquire (no mic connected) — the sticky MIC_LOST_MSG stays until a device change
      // retriggers recovery or the user restarts Listen.
      setState((s) => ({ ...s, error: MIC_LOST_MSG }))
    } finally {
      micRecoveringRef.current = false
    }
  }

  // Re-acquire system-audio ('them') after its loopback track died (display sleep, default-output swap,
  // Bluetooth change). Mirrors recoverMicRef but re-runs the arm-dance getDisplayMedia acquisition that
  // start() uses — this IS doable programmatically (armAudio + the main-process loopback handler need no
  // user gesture), so a mid-meeting blip no longer forces a destructive "Toggle Listen" restart that would
  // end the meeting and split it into two transcripts. Also invoked by the live permission watcher when
  // Screen Recording flips to granted mid-session. Routed through openChannel so the them-watchdog + the
  // themHeardRef first-emission detection re-arm for free.
  const sysRecoveringRef = useRef(false)
  // True while the current session requested system audio ('system'/'both') — gates the live permission
  // watcher so a mic-only session never tries to grab the loopback.
  const wantsSystemRef = useRef(false)
  const recoverSystemAudioRef = useRef<(() => Promise<void>) | null>(null)
  recoverSystemAudioRef.current = async (): Promise<void> => {
    if (!liveRef.current || sysRecoveringRef.current) return
    if (channels.current.them) return // already have a live 'them' channel — nothing to recover
    sysRecoveringRef.current = true
    try {
      await window.toto.armAudio(true)
      let sys: MediaStream
      try {
        if (isWindows) {
          // Windows loopback audio doesn't need a bound video stream the way macOS's ScreenCaptureKit
          // binding does — try audio-only first so a genuine screen source is never grabbed (and no
          // OS/EDR screen-recording indicator fires) for what the user only intended as system audio.
          try {
            sys = await navigator.mediaDevices.getDisplayMedia({ audio: true })
          } catch {
            sys = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true })
          }
        } else {
          sys = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true })
        }
      } finally {
        await window.toto.armAudio(false)
      }
      const liveAudio = sys.getAudioTracks().filter((t) => t.readyState !== 'ended')
      if (!liveRef.current || !liveAudio.length) {
        sys.getTracks().forEach((t) => t.stop())
        return
      }
      await openChannel('them', sys)
      setState((s) => (s.error === THEM_LOST_MSG ? { ...s, error: null } : s))
    } catch {
      // Couldn't re-acquire (permission genuinely revoked, or no loopback available) — leave the sticky
      // note so the live permission watcher / a devicechange can retrigger recovery later.
      setState((s) => (s.error === null ? { ...s, error: THEM_LOST_MSG } : s))
    } finally {
      sysRecoveringRef.current = false
    }
  }

  // Follow the default input across device changes while the mic channel is live. A Bluetooth switch
  // often leaves the old track "alive" but permanently silent (no 'ended' event) — the classic silent
  // death. Debounced: connect+disconnect storms settle before we re-acquire once.
  const devChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const onDeviceChange = (): void => {
      if (!liveRef.current || !channels.current.you) return
      if (devChangeTimerRef.current) clearTimeout(devChangeTimerRef.current)
      devChangeTimerRef.current = setTimeout(() => {
        devChangeTimerRef.current = null
        void recoverMicRef.current?.()
      }, 800)
    }
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
      if (devChangeTimerRef.current) clearTimeout(devChangeTimerRef.current)
    }
  }, [])

  // Live Screen-Recording permission watcher. If a session wants system audio but the 'them' channel
  // never opened (permission wasn't granted at start, so the user is on the mic-only fallback), poll for
  // the permission flipping to 'granted' and auto-resume the them channel IN PLACE — no destructive
  // "Toggle Listen" restart. This is the "set up automatically" behaviour: after the one unavoidable macOS
  // Settings toggle, Métis picks up system audio on its own. Only runs while listening + system was
  // requested; the getPermissions poll is skipped entirely once 'them' is live.
  useEffect(() => {
    // win32's getPermissions always reports screenRecording as 'unknown' (no such OS-level permission
    // concept on Windows) — the poll below can structurally never see 'granted' there, so it would just
    // burn a 3s interval for the whole meeting with zero chance of firing. Skip it entirely on Windows.
    if (isWindows || !state.listening || !wantsSystemRef.current) return
    const iv = setInterval(() => {
      if (channels.current.them || sysRecoveringRef.current) return // already have it / mid-recovery
      void window.toto
        .getPermissions()
        .then((p) => {
          // Windows never reports 'granted' here (windowsScreenStatus() hard-codes 'unknown' — there is no
          // OS permission gate to poll), which made this watcher dead code there: a transient start-time
          // loopback failure was never retried. Drive the retry off actual capture state on Windows instead
          // of a permission string that will never flip.
          if ((isWindows || p?.screenRecording === 'granted') && !channels.current.them) {
            void recoverSystemAudioRef.current?.()
          }
        })
        .catch(() => {})
    }, 3000)
    return () => clearInterval(iv)
  }, [state.listening])

  const start = useCallback(
    async (
      source: AudioSource,
      quality: 'best' | 'fast' = 'best',
      engine: 'whisper' | 'parakeet' | 'apple' = 'whisper',
      language: string = 'auto'
    ): Promise<void> => {
      // Re-entrancy guard: a rapid double-click/double-hotkey calls start() twice before React re-renders
      // listen.listening to true (that state flip is async), so this MUST be a synchronous ref check right
      // at the top, before the first `await` — checking/disabling on component state is too late and lets
      // the second call open a full second set of mic/system-audio channels (leaked AudioContext + stream).
      // Cleared in the `finally` below so it never wedges a future session.
      if (startingRef.current) return
      startingRef.current = true
      try {
        // Capture the caller's requested quality up front, unconditional of which engine ends up running
        // this session — fallBackToWhisper and armNetworkRetry's retry() (both able to fire well after this
        // start() call returns) read requestedQualityRef instead of loadedQualityRef, which stays null for
        // the whole lifetime of a Parakeet session.
        requestedQualityRef.current = quality
        asrLanguageRef.current = language
        if (workerIdleTimer.current) {
          clearTimeout(workerIdleTimer.current) // re-arming before the idle release fires: keep the worker warm
          workerIdleTimer.current = null
        }
        // A stop() may still be draining — cancel its initial kickoff timer and reset the stopping guard so
        // this fresh session is not torn down when finishTeardown fires for the previous stop().
        if (drainTimerRef.current) {
          clearTimeout(drainTimerRef.current)
          drainTimerRef.current = null
          // The cancelled drain never got to run finishTeardown's closeChannel calls -- close both channels
          // here so a speaker the new source excludes (e.g. restarting mic-only after a mic+system session)
          // doesn't leak its AudioContext/MediaStream indefinitely.
          closeChannel('you')
          closeChannel('them')
        }
        stoppingRef.current = false
        sessionEpochRef.current += 1
        queue.current = []
        busy.current = false
        liveRef.current = true
        wantsSystemRef.current = source === 'system' || source === 'both'
        pausedRef.current = false
        disarmNetworkRetry() // a fresh session supersedes any retry armed for the previous one
        crashedRef.current = false // fresh session — re-enable stop()'s teardown after any prior crash
        parakeetFailures.current = 0 // reset the failure streak so a new session gets a clean shot at Parakeet
        parakeetEmptyRunRef.current = 0 // clear the empty-window run counter for a fresh session
        engineRef.current = engine
        themRunRef.current = '' // fresh session → no carried-over 'them' question turn
        repeatRunRef.current = { key: '', speaker: '', count: 0 } // fresh session → no carried-over dupe run
        setState((s) => ({ ...s, error: null, listening: true, paused: false }))
        try {
          await window.toto.setListeningState(true)
        } catch {
          /* main may not have a tray; ignore */
        }

        if (engine === 'parakeet') {
          // Parakeet runs in the MAIN process; free any warm Whisper worker, then require its bundled model.
          // ANY failure falls back to Whisper so Listen always works.
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

        if (engine === 'apple') {
          // Apple Speech also runs in the MAIN process via the mac-helper sidecar, but — unlike
          // Parakeet — ships no bundled model to check/download: availability (macOS + helper present +
          // on-device authorization) is resolved lazily inside appleSpeechTranscribe. A genuinely
          // unavailable engine (non-mac, helper missing, authorization denied) simply returns '' for
          // every window, which the empty-run fallback in pump() above already catches — so there is no
          // separate status/ensure round trip to make here.
          if (workerRef.current) {
            workerRef.current.terminate()
            workerRef.current = null
          }
          loadedQualityRef.current = null
          readyRef.current = true
          setState((s) => ({ ...s, ready: true, loading: false, loadingPct: null }))
          pump()
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
          //          false → development-only remote resolver when local assets were not provisioned.
          const bundled = await getAsrBundled()
          if (!bundled && !navigator.onLine && !readyRef.current) {
            // Non-bundled (remote-model) path needs the network to fetch the model and we're offline right
            // now — skip the guaranteed-to-fail fetch and go straight to the "waiting for network" state
            // instead of surfacing a raw, confusing fetch error. armNetworkRetry arms the auto-restart.
            armNetworkRetry('offline')
          } else {
            // resetFollow: a fresh session must never inherit the previous meeting's converged
            // language-follow state from a warm worker (see whisper.worker.ts's init handler).
            ensureWorker().postMessage({ type: 'init', quality, bundled, language: asrLanguageRef.current, resetFollow: true })
          }
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
            const mic = await acquireMic(micDeviceIdRef.current)
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
              if (isWindows) {
                // Windows loopback audio doesn't need a bound video stream — try audio-only first so a
                // genuine screen source is never grabbed (and no OS/EDR screen-recording indicator fires)
                // for what the user only intended as system-audio capture. Fall back to the video-bound
                // request below if this Electron/Chromium build still requires a paired video track.
                try {
                  sys = await navigator.mediaDevices.getDisplayMedia({ audio: true })
                } catch {
                  sys = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true })
                }
              } else {
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
              }
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
            msg = isWindows
              ? 'Could not capture system audio. Make sure the meeting plays through your default output device and no other app has it exclusively, or switch Listen to your microphone in Settings, Audio tab.'
              : isSysPermDenied
                ? 'System audio needs Screen Recording permission. Grant it in System Settings → Privacy & Security → Screen Recording, then restart Listen.'
                : "Couldn't capture system audio. Grant Screen Recording in System Settings, or switch Listen to your microphone in Settings → Audio."
          } else {
            msg = isWindows
              ? 'Could not start the microphone. Check that Windows microphone access is allowed for Métis and that a mic is connected.'
              : "Couldn't start the microphone. Check Microphone access in System Settings → Privacy & Security → Microphone."
          }
          setState((s) => ({ ...s, error: msg, listening: false, capturing: false, loading: false }))
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
          note = isWindows
            ? 'System audio unavailable. Listening to your microphone only. Check that the meeting plays through your default output device.'
            : isSysPermDenied
              ? 'System audio needs Screen Recording permission. Listening to microphone only; grant it in System Settings → Privacy & Security → Screen Recording, then restart Listen.'
              : 'System audio unavailable. Listening to your microphone only. Grant Screen Recording to hear the other side.'
        } else if (source === 'both' && !micOk && sysOk) {
          note = 'Microphone unavailable. Listening to system audio only.'
        }
        // At least one channel (mic and/or system loopback) is confirmed open here — this is the point
        // a consent/recording indicator should key off, not the optimistic `listening: true` set at the
        // top of start() before any capture was actually acquired.
        setState((s) => ({ ...s, error: note, listening: true, capturing: true, loading: !readyRef.current }))
      } finally {
        // Every exit path (the several early `return`s above, a thrown error, or the normal fall-through)
        // clears the guard so a later, legitimate start() is never permanently blocked.
        startingRef.current = false
      }
    },
    // closeChannel referenced in body (defined below); stable useCallback, omitted to avoid TDZ in deps
    [armNetworkRetry, disarmNetworkRetry, ensureWorker, getAsrBundled, openChannel, pump]
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

  // Suspending each open channel's AudioContext (rather than closing it) halts the worklet's audio-render
  // callback entirely — no new windows reach pushAudio — while leaving the MediaStream tracks alive. That
  // matters most for the macOS 'them' channel: its video+audio pair shares one ScreenCaptureKit SCStream
  // session (see the IMPORTANT comment in start() above), and stopping any track there would kill the whole
  // session. Suspend/resume never touches tracks, so the loopback session survives a pause intact.
  const pause = useCallback((): void => {
    if (!liveRef.current || pausedRef.current) return
    pausedRef.current = true
    // The 'them' watchdog is armed once at channel-open and otherwise runs on a wall-clock timer that
    // doesn't know about pause — left ticking, an ordinary pause longer than THEM_WATCHDOG_MS (20s) fires
    // a false "not hearing the other side" note over what is actually an intentional pause with nothing
    // wrong. Clear it here; resume() re-arms from the resume point so the full window applies post-pause.
    if (themWatchdogRef.current) {
      clearTimeout(themWatchdogRef.current)
      themWatchdogRef.current = null
    }
    // Flush each worklet's partial PCM/VAD buffer before its AudioContext actually suspends. Without this,
    // whatever's mid-utterance in the worklet (buf/fill/vad hysteresis) survives the pause untouched, and
    // resume() lets it keep writing new audio straight into that stale buffer with no reset in between --
    // splicing pre-pause and post-resume speech into one garbled utterance. flush (the worklet's emit())
    // always resets buf/fill/vad even when the flushed audio itself is silence/near-empty, so this alone
    // stops the splice; pushAudio already drops anything it emits since pausedRef.current is true.
    // The actual ctx.suspend() is deferred behind a short drain wait -- same pattern as stop()'s
    // waitForDrain, minus its teardown side effects (no closeChannel, no session/queue wipe) since pause is
    // reversible and the channels must stay alive -- giving the cross-thread flush message time to reach
    // the worklet before rendering halts. Flushed again right before suspending in case fresh audio arrived
    // during that wait.
    const flushAll = (): void => {
      for (const ch of Object.values(channels.current)) {
        try {
          ch?.worklet.port.postMessage('flush')
        } catch {
          /* ignore if port is already closed */
        }
      }
    }
    flushAll()
    const PAUSE_DRAIN_CEILING_MS = 4000
    const startedAt = Date.now()
    const waitThenSuspend = (): void => {
      if (!pausedRef.current) return // resumed before the drain finished — nothing left to suspend
      if ((queue.current.length === 0 && !busy.current) || Date.now() - startedAt > PAUSE_DRAIN_CEILING_MS) {
        flushAll()
        for (const ch of Object.values(channels.current)) {
          void ch?.ctx.suspend().catch(() => {})
        }
        return
      }
      setTimeout(waitThenSuspend, 60)
    }
    setTimeout(waitThenSuspend, 80)
    setState((s) => ({ ...s, paused: true }))
  }, [])

  const resume = useCallback((): void => {
    if (!liveRef.current || !pausedRef.current) return
    pausedRef.current = false
    for (const ch of Object.values(channels.current)) {
      void ch?.ctx.resume().catch(() => {})
    }
    // Re-arm the 'them' watchdog (paused above) so a still-silent 'them' channel gets a fresh
    // THEM_WATCHDOG_MS window post-resume instead of staying permanently disarmed. No-op if 'them' isn't
    // open, or if it already emitted audio before the pause (armThemWatchdog checks themHeardRef).
    if (channels.current.them) armThemWatchdog()
    setState((s) => ({ ...s, paused: false }))
  }, [])

  const stoppingRef = useRef(false) // double-stop guard
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null) // pending initial drain kickoff timer
  const sessionEpochRef = useRef(0) // incremented each start(); drain/finishTeardown bails if epoch changed
  const stop = useCallback((onDrained?: () => void): void => {
    // crashedRef → the worker onerror handler already ran the full teardown; running it again here would
    // thrash state (re-fire setListeningState(false), wipe the crash error) → the "dead-end" tray mismatch.
    if (stoppingRef.current || crashedRef.current) {
      // Nothing left to drain (already stopping, or torn down by a crash) — fire the callback right away
      // so a caller relying on it (e.g. endReview's recap) still runs instead of silently never firing.
      onDrained?.()
      return
    }
    stoppingRef.current = true
    const myEpoch = sessionEpochRef.current

    // 0. A worklet's port message is handled on the audio-rendering thread — it won't run while that
    //    thread is suspended. Resume before flushing so a Stop hit while Paused still processes the flush
    //    and commits the final window, instead of silently dropping it.
    if (pausedRef.current) {
      pausedRef.current = false
      for (const ch of Object.values(channels.current)) void ch?.ctx.resume().catch(() => {})
    }

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
    // Parakeet decodes run in the main process over IPC and race their own PARAKEET_FEED_TIMEOUT_MS
    // timeout per window (see pump() above). A drain ceiling shorter than that timeout would tear down
    // (liveRef=false) while the last decode is still in flight — and commitLine drops any line that lands
    // after liveRef flips false — silently losing the final sentence of a Parakeet session. Give Parakeet
    // sessions a ceiling that comfortably outlasts their own feed timeout — Apple Speech feeds over the
    // same IPC path with the same timeout (see its pump above), so it gets the same headroom; Whisper
    // (in-process, no IPC round trip) keeps the original 4s ceiling.
    const DRAIN_CEILING_MS =
      engineRef.current === 'parakeet' || engineRef.current === 'apple' ? PARAKEET_FEED_TIMEOUT_MS + 1000 : 4000
    const startedAt = Date.now()
    const finishTeardown = (): void => {
      // A new start() ran while we were draining — it already owns the session; do not clobber it.
      // Leave stoppingRef alone: start() already reset it for the new session, so an old-epoch tick
      // clearing it here would weaken that session's double-stop guard.
      if (sessionEpochRef.current !== myEpoch) return
      liveRef.current = false
      disarmNetworkRetry() // session over — a pending 'online' retry must not fire into the next one
      queue.current = [] // drop anything still undispatched past the ceiling so it can't leak into the next session
      themRunRef.current = '' // run after the drain: any final flushed question already fired while liveRef was true
      closeChannel('you')
      closeChannel('them')
      void window.toto.setListeningState(false).catch(() => {})
      setState((s) => ({ ...s, listening: false, capturing: false, paused: false, loading: false, error: null }))
      drainTimerRef.current = null
      stoppingRef.current = false
      // The final flushed window (if any) has now committed via commitLine — text() reflects the
      // complete post-drain transcript, safe for a caller (e.g. the recap) to read.
      onDrained?.()
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
  }, [closeChannel, disarmNetworkRetry])

  const clear = useCallback((): void => {
    setLines([])
    themRunRef.current = '' // wiping the transcript also drops any in-progress 'them' question turn
  }, [])

  const text = useCallback((): string => {
    return transcriptToText(linesRef.current)
  }, [])

  useEffect(() => {
    return () => {
      // Unmount must release hardware synchronously -- stop()'s drain is async (up to DRAIN_CEILING_MS)
      // and would keep running (and re-arm a new workerIdleTimer) after this instance is gone with nothing
      // left able to cancel it. So this bypasses stop() entirely and tears everything down directly.
      if (drainTimerRef.current) {
        clearTimeout(drainTimerRef.current)
        drainTimerRef.current = null
      }
      liveRef.current = false
      disarmNetworkRetry()
      closeChannel('you')
      closeChannel('them')
      if (workerIdleTimer.current) clearTimeout(workerIdleTimer.current)
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [closeChannel, disarmNetworkRetry])

  // Pre-warm the small default model in the BACKGROUND a few seconds after startup, so the first time the
  // user presses Listen the bundled model is already loaded (no setup pause mid-meeting).
  // Deferred + idle-scheduled so it never competes with the first paint / onboarding interaction.
  useEffect(() => {
    let warmed = false
    const warm = async (): Promise<void> => {
      if (warmed || workerRef.current) return
      warmed = true
      try {
        const bundled = await getAsrBundled()
        // Prewarm carries no language: the setting is only known per-session at start(), whose init
        // message updates the (already warm) worker's language before the first audio window.
        ensureWorker().postMessage({ type: 'init', quality: 'fast', bundled })
        loadedQualityRef.current = 'fast'
      } catch {
        /* best-effort prewarm */
      }
    }
    const t = setTimeout(() => void warm(), 4000)
    return () => clearTimeout(t)
  }, [ensureWorker, getAsrBundled])

  // Mid-session spoken-language change (Settings → Audio while listening). The ref update covers every
  // engine's future reads; only a live Whisper worker needs an explicit nudge — a warm re-init whose
  // language lands before the worker's already-loaded early return (see whisper.worker.ts).
  const setLanguage = useCallback(
    async (language: string): Promise<void> => {
      if (asrLanguageRef.current === language) return
      asrLanguageRef.current = language
      if (engineRef.current !== 'whisper' || !workerRef.current || !liveRef.current) return
      try {
        const bundled = await getAsrBundled()
        workerRef.current.postMessage({ type: 'init', quality: requestedQualityRef.current, bundled, language })
      } catch {
        /* best-effort: the next session's start() re-sends the language anyway */
      }
    },
    [getAsrBundled]
  )

  // Memoized so consumers (App.tsx passes this whole object around as a dependency) only see a new
  // identity when a real piece of it changes — start/stop/pause/resume/clear/text are already
  // useCallback-stable, so without this the returned object was a fresh literal on every render.
  return useMemo(
    () => ({ ...state, lines, start, stop, pause, resume, clear, text, setLanguage }),
    [state, lines, start, stop, pause, resume, clear, text, setLanguage]
  )
}
