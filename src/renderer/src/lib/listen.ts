import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptLine } from '@shared/ipc'
import { collapseRepeatedPhrase, isNonSpeechLine, repeatKey } from '@shared/transcript-filter'
import { detectLanguage, detectLanguages } from '@shared/lang-id'
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
// ASR quality (1B.2a) — ~3.2 min of audio; drop oldest under backpressure if the model is slow/failed to
// load. Bumped from 24 (a small headroom increase, still bounded memory: ≤6s * 16kHz mono Float32Arrays,
// worst case ~12 MB total) since trimQueue below can now spend a LITTLE more room protecting the newest
// window of each speaker rather than trimming right up against the edge.
const MAX_QUEUE = 32
const PARAKEET_FEED_TIMEOUT_MS = 5000 // a single Parakeet window shouldn't take longer than this to transcribe
// ── Whisper 'auto' language probe (PROVEN FACT 2026-08-05, direct probe): transformers.js's whisper NEVER
// auto-detects on an un-pinned decode — it logs "No language specified - defaulting to English" and
// decodes ENGLISH regardless of what was actually spoken. So asrLanguage:'auto' needs a language-agnostic
// signal to pin off, exactly like the import path (main/whisper-import.ts) was just fixed to use: Parakeet
// takes no `language` option, so its output reflects what was actually said. Probe early/periodic 'them'
// or 'you' windows through window.toto.parakeetFeed (main-side, bundled on both platforms) alongside the
// whisper decode — fire-and-forget, never blocking — and once shared/lang-id.ts confidently identifies the
// audio, post the worker a 'pinLanguage' message (see whisper.worker.ts's block comment for the invariants
// that message latches: never un-pin once pinned; explicit settings languages are never probed at all).
const PROBE_WINDOW_BUDGET = 5 // probe EVERY one of the opening windows this densely, then drop to PROBE_EVERY
const PROBE_MIN_WORDS = 8 // a near-empty window ("Hello") can only mislead — wait for real substance
// 1B.2c — shouldProbeLanguageWindow already keeps probing forever past PROBE_WINDOW_BUDGET when no pin
// has landed (see its own block comment), but every one of those probes still had to clear PROBE_MIN_WORDS
// (8) — a meeting whose opening minute is entirely short utterances ("Sim.", "Tá bom.", "Oi, oi.") never
// produces a single qualifying window, so the FIRST pin could be delayed indefinitely even though the
// probe cadence itself never gave up. Once the opening budget is spent with no pin yet, lower the bar for
// that FIRST pin only (a shakier signal beats staying wrongly latched to English for the rest of the
// meeting) — see probeMinWords below. Once pinned, re-probes go back to the normal, stricter gate.
const PROBE_MIN_WORDS_AGGRESSIVE = 5
const PROBE_EVERY = 2 // once pinned, re-probe often enough to catch a mid-meeting / mid-sentence switch
const SWITCH_AFTER = 2 // consecutive confirming re-probes required before actually re-pinning
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

/**
 * Exported for unit testing — which live-banner note survives a window that decoded successfully.
 * A Whisper decode failure is per-window, not per-session (the very next window normally transcribes
 * fine), yet its note used to sit in the danger banner for the rest of the meeting because nothing ever
 * retracted it. `decodeNote` is the exact text the failing window put up, so the retraction is an
 * exact-string match — the same contract as OFFLINE_MSG/THEM_SILENT_MSG above, and the reason a fuzzy
 * "clear anything engine-shaped" rule is wrong: it would erase MIC_LOST_MSG/THEM_LOST_MSG/DROPPED_MSG,
 * which describe conditions a decoded window says nothing about.
 */
export function noteAfterDecodedWindow(current: string | null, decodeNote: string | null): string | null {
  return decodeNote !== null && current === decodeNote ? null : current
}

/**
 * Exported for unit testing — the pure probe cadence behind pump() (see PROBE_EVERY's block comment).
 * The un-pinned budget is an opening BURST, not a retirement: a meeting whose first windows are short
 * openers ("Oi", "Tudo bem?") burns all five of them on returns the PROBE_MIN_WORDS substance gate throws
 * away, and a probe that never landed must keep trying — an un-pinned whisper decode is hard-coded to
 * English by transformers.js, so "give up and stay auto" silently means "transcribe the rest of a
 * Portuguese meeting as English". Falling back to the PROBE_EVERY cadence (not every window) keeps the
 * steady-state probe load identical to the already-pinned case.
 */
export function shouldProbeLanguageWindow(windowIndex: number, pinned: boolean): boolean {
  if (pinned) return windowIndex % PROBE_EVERY === 0
  return windowIndex <= PROBE_WINDOW_BUDGET || windowIndex % PROBE_EVERY === 0
}

/**
 * Exported for unit testing — the pure minimum-substance gate behind probeLanguageWindow (see
 * PROBE_MIN_WORDS_AGGRESSIVE's block comment above). Only the FIRST pin ever gets the lower bar: once
 * `pinned` is true this returns the normal, stricter PROBE_MIN_WORDS regardless of windowIndex, so a
 * genuine mid-meeting language switch still needs real substance to re-pin, exactly as before.
 */
export function probeMinWords(pinned: boolean, windowIndex: number): number {
  return !pinned && windowIndex > PROBE_WINDOW_BUDGET ? PROBE_MIN_WORDS_AGGRESSIVE : PROBE_MIN_WORDS
}

/**
 * Live language pin / re-pin confirmation (MQA-235 for live).
 *
 * Import already majority-votes before the first pin because window 0 is often a wrong-language
 * greeting. Live used to latch on the FIRST confident probe — an English "thanks for joining" on a
 * French call pinned English for the rest of the meeting. The INITIAL pin now needs the same
 * SWITCH_AFTER consecutive confirming detections as a mid-meeting switch.
 *
 * Returns the next switch-run state and whether the worker should be (re)pinned to `detected`.
 */
export function advanceLanguageProbe(args: {
  detected: string
  pinnedLang: string | null
  switchRun: { lang: string; count: number } | null
  switchAfter?: number
  /** Window itself contains the new language alongside another — counts as stronger switch evidence. */
  mixed?: boolean
}): { pinnedLang: string | null; switchRun: { lang: string; count: number } | null; shouldPin: boolean } {
  const switchAfter = args.switchAfter ?? SWITCH_AFTER
  // Mixed evidence only accelerates a MID-meeting switch — first pin still needs SWITCH_AFTER.
  const step = args.mixed && args.pinnedLang !== null && args.detected !== args.pinnedLang ? 2 : 1
  if (args.pinnedLang === null) {
    const run =
      args.switchRun && args.switchRun.lang === args.detected
        ? { lang: args.detected, count: args.switchRun.count + step }
        : { lang: args.detected, count: step }
    if (run.count >= switchAfter) {
      return { pinnedLang: args.detected, switchRun: null, shouldPin: true }
    }
    return { pinnedLang: null, switchRun: run, shouldPin: false }
  }
  if (args.detected === args.pinnedLang) {
    return { pinnedLang: args.pinnedLang, switchRun: null, shouldPin: false }
  }
  const run =
    args.switchRun && args.switchRun.lang === args.detected
      ? { lang: args.detected, count: args.switchRun.count + step }
      : { lang: args.detected, count: step }
  if (run.count >= switchAfter) {
    return { pinnedLang: args.detected, switchRun: null, shouldPin: true }
  }
  return { pinnedLang: args.pinnedLang, switchRun: run, shouldPin: false }
}

/** True when a Parakeet/Apple feed returned empty because echo-defense dropped operator bleed — not an engine stall. */
export function feedEmptyIsEcho(res: string | { text: string; name?: string; echo?: boolean }): boolean {
  return typeof res !== 'string' && res.echo === true && res.text === ''
}

/**
 * Exported for unit testing — the pure trim behind pushAudio's backpressure guard (1B.2a). Bounds the
 * queue to maxLen by dropping the OLDEST windows first, same as before — but a naive drop-the-front trim
 * can silently erase every queued window of one speaker's channel when the other channel produced a
 * longer burst just ahead of it (e.g. five consecutive THEM windows queued right before a stale YOU one)
 * even though there was still room to keep one of each. So the newest already-queued window of EACH
 * speaker present is protected from the trim; oldest-first dropping still applies to everything else, so
 * a single-speaker backlog (the common case) trims exactly as it always did.
 */
export function trimQueue<T extends { speaker: string }>(queue: readonly T[], maxLen: number): T[] {
  if (queue.length <= maxLen) return queue.slice()
  const lastIndexOfSpeaker = new Map<string, number>()
  queue.forEach((job, i) => lastIndexOfSpeaker.set(job.speaker, i))
  const protectedIdx = new Set(lastIndexOfSpeaker.values())
  let excess = queue.length - maxLen
  const kept: T[] = []
  for (let i = 0; i < queue.length; i++) {
    if (excess > 0 && !protectedIdx.has(i)) {
      excess--
      continue
    }
    kept.push(queue[i])
  }
  return kept
}

/**
 * Exported for unit testing — the pure staleness decision behind probeLanguageWindow's `.then` (see)
 * useListen below). A probe is a fire-and-forget IPC round trip with no timeout whose first call of a
 * session pays the multi-second sherpa model load (parakeetRelease frees it between meetings), so it can
 * still be in flight when the user stops and starts a new meeting. `live` alone cannot express that:
 * start() raises it again for the NEXT session, so a session-1 probe resolving inside session 2 passed
 * the guard and pinned session 2's freshly reset worker to session 1's language. The session epoch
 * stamped at dispatch is the identity that survives the round trip — the same primitive stop()'s drain
 * uses to refuse to clobber a session it no longer owns.
 */
export function probeResultIsStale(
  dispatchEpoch: number,
  currentEpoch: number,
  live: boolean,
  engine: 'whisper' | 'parakeet' | 'apple',
  language: string
): boolean {
  return dispatchEpoch !== currentEpoch || !live || engine !== 'whisper' || language !== 'auto'
}

/** What the 'them' (system-loopback) side must do when the OS reports an audio-device change. */
export type ThemDeviceAction = 'ignore' | 'watch' | 'recover' | 'recycle'

/**
 * Exported for unit testing — the pure decision behind the 'them'-side silent-death recovery (see
 * armThemProbation and the devicechange effect in useListen). Called twice per device change: with
 * `sawWindow: null` when the change is debounced, then with the observed boolean when the probation
 * window expires. A device change that kills the loopback leaves the track in readyState 'live' and fires
 * no 'ended' event, so a still-registered channel is only trustworthy once it has emitted a window SINCE
 * the change — the previous session-long "we heard them once" latch could never notice the death.
 *
 * `hasDeathEvidence` (read only on the expiry call, when sawWindow is a boolean) is the MQA-109 guard: an
 * absent window during probation is NOT proof of death for a channel that was ALREADY confirmed healthy.
 * An unrelated device blip during a normal quiet stretch (you talking, the remote briefly silent) emits no
 * window while the loopback stays perfectly alive; recycling it there tears down a working capture —
 * exactly what armThemProbation's own contract says must never happen. So an already-healthy channel is
 * recycled ONLY with positive evidence its tracks actually died; a channel that never proved itself keeps
 * the original prove-or-die probation. Defaults to true so the debounce call (which returns 'watch' before
 * ever reading it) and any legacy three-arg caller keep the historical behaviour.
 */
export function themDeviceChangeAction(
  wantsSystem: boolean,
  hasThemChannel: boolean,
  sawWindow: boolean | null,
  hasDeathEvidence = true
): ThemDeviceAction {
  if (!wantsSystem) return 'ignore' // mic-only session — there is no loopback to keep alive
  if (!hasThemChannel) return 'recover' // nothing to wait on (start-time failure, or a channel already closed)
  if (sawWindow === null) return 'watch' // registered channel — let it prove itself before tearing it down
  if (sawWindow) return 'ignore' // proved itself again — no gratuitous teardown on a device blip
  return hasDeathEvidence ? 'recycle' : 'ignore' // MQA-109: quiet ≠ dead for an already-healthy channel
}

/**
 * Exported for unit testing — positive death evidence for an already-healthy 'them' channel (MQA-109).
 * The device-change probation recycles a confirmed-healthy loopback only when its audio actually died, not
 * merely because it went quiet: every remaining audio track has ended, or its source went muted (an empty
 * list means the channel is already gone, which also counts as dead so recovery still fires). Only AUDIO
 * tracks are passed in — the macOS/Windows loopback stream carries a 1fps video track that stays live and
 * would otherwise mask a dead audio track.
 */
export function themTracksLookDead(tracks: { readyState: string; muted: boolean }[]): boolean {
  if (tracks.length === 0) return true
  return tracks.every((t) => t.readyState === 'ended' || t.muted)
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
  limiter?: DynamicsCompressorNode // 'them' only: flattens the overs the boost creates (MQA-267)
}

/** A capture side the session REQUESTED but is NOT currently hearing, while Listen stays active
 *  ('them' = system-audio loopback / the remote side, 'you' = the microphone). Exposed as its own
 *  structured field — separate from the sticky `error` note, which only renders inside the Copilot
 *  body and later transient notes may overwrite — so persistent chrome (the Bar's "Heard live" chip,
 *  the minimized control pill) can show a truthful degraded state for the entire mic-only stretch.
 *  Tony sat through a whole meeting on 2026-07-20 with Screen Recording off and only found out from
 *  the unusable transcript: the red rec-dot and "Heard live" chip kept claiming everything was fine. */
export interface CaptureDegraded {
  side: 'you' | 'them'
  /** Full platform-aware explanation (used as tooltip copy) — the note text shown when the state was set. */
  note: string
  /** True when the cause is the macOS Screen Recording permission ('them' only). */
  permission: boolean
}

/**
 * Exported for unit testing — the pure decision behind recoverMic's success path (see useListen below).
 * `captureDegraded` is ONE slot but both sides can be degraded at once: on a mic-only session (Screen
 * Recording denied) a mic drop overwrites the 'them' entry with {side:'you'}, and the recovery ~200ms
 * later cleared the slot outright — so the Bar's chip went back to the confident red "Heard live" while
 * the remote half of the meeting was still not being captured and never would be (MQA-156), which is the
 * exact 2026-07-20 failure this field exists to prevent. A mic recovery may therefore only retire the
 * 'you' entry: while the session still wants system audio and has no 'them' channel, the remembered
 * 'them' cause — which carries the specific Screen-Recording copy and `permission` — is exposed again.
 */
export function degradedAfterMicRecovery(
  current: CaptureDegraded | null,
  themDegraded: CaptureDegraded | null,
  wantsSystem: boolean,
  hasThemChannel: boolean
): CaptureDegraded | null {
  if (current?.side !== 'you') return current
  return wantsSystem && !hasThemChannel ? themDegraded : null
}

/**
 * Delay before the next Windows system-audio retry, given how many have already failed back-to-back.
 * Doubles from the watcher's 3 s tick and holds at a 30 s ceiling — bounded work, but NEVER terminal.
 *
 * Both halves matter. A machine where WASAPI loopback cannot start at all (VDI/RDP with no render
 * endpoint, every output disabled, an app holding the endpoint exclusively) used to pay a full
 * getDisplayMedia acquisition every 3 s for the whole meeting — and each attempt that falls through to
 * the video-bound form runs up to 3 desktopCapturer.getSources screen enumerations, which is the exact
 * screen-grabbing path the audio-only attempt exists to avoid. Giving up entirely is not the answer
 * either: the headline case in the watcher's own comment (another app holding the render endpoint) emits
 * no 'devicechange', so nothing else would ever re-arm and the meeting stays mic-only — MQA-041.
 */
export function sysRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(3000 * 2 ** consecutiveFailures, 30_000)
}

/**
 * A failed 'them' re-acquire only ever RAISES: the sticky note when there is none, and the degradation
 * entry when there is none (an existing one carries the more specific start-time cause, e.g. the
 * Screen-Recording copy, and must survive). So once both are set the write is a no-op — and it must then
 * leave the state object alone rather than spreading a value-identical copy: the Windows retry above runs
 * on a repeating cadence for the whole meeting, and every spread re-rendered the entire App tree.
 */
export function themRecoveryFailureIsNoop(
  error: string | null,
  captureDegraded: CaptureDegraded | null
): boolean {
  return error !== null && captureDegraded !== null
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
  /** Non-null while a requested capture side isn't being heard (see CaptureDegraded above). */
  captureDegraded: CaptureDegraded | null
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
  /** 1.9.0 — rename a session cluster across the live transcript (Review "Name this speaker"). */
  remapSpeakerNames: (from: string, to: string) => void
  /** Apply main's finalizeSession merge map to in-memory lines. */
  applySpeakerMapping: (mapping: Record<string, string>) => void
}

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

/**
 * MQA-267 — voice processing must be OFF on the loopback ('them') track, and it defaulted ON.
 *
 * Probed on real Windows hardware (the index.ts CAVEAT said this path was never validated): the granted
 * loopback track came back with echoCancellation:true, noiseSuppression:true, autoGainControl:true.
 * Echo cancellation's entire purpose is to subtract the far-end audio playing through the speakers —
 * which on a loopback capture IS the signal. With the mic channel open beside it, the AEC reference
 * lines up and the 'them' audio is partially or wholly cancelled before it ever reaches ASR. That is the
 * reported symptom exactly: the main speaker transcribes, the other person intermittently vanishes, and
 * the transcript breaks mid-conversation. Noise suppression and AGC compound it — both are tuned for a
 * mouth near a microphone, not for rendered playout, so they pump and gate clean far-end speech.
 *
 * The MIC keeps its processing (acquireMic above): AEC on the mic is what stops the speakers bleeding
 * the other person's words into the 'you' channel as duplicates. The asymmetry is the design.
 */
const LOOPBACK_AUDIO: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
}

/** getDisplayMedia audio constraints are not reliably honored across Chromium versions, so the
 *  constraint is also applied to the LIVE track after the grant. applyConstraints on these three
 *  booleans works even where the initial request was ignored; a track that refuses is left as-is
 *  rather than failing the capture — degraded audio still beats no 'them' channel at all. */
async function stripLoopbackProcessing(sys: MediaStream): Promise<void> {
  for (const t of sys.getAudioTracks()) {
    try {
      await t.applyConstraints(LOOPBACK_AUDIO)
    } catch {
      /* keep the track — a processed 'them' is still better than none */
    }
  }
}

/** The one way a loopback stream is acquired. Windows tries audio-only first so no genuine screen
 *  source is grabbed (and no OS/EDR screen-recording indicator fires) for what the user intended as
 *  system audio; macOS must bind to a 1fps ScreenCaptureKit video stream or the audio never starts. */
async function acquireLoopback(): Promise<MediaStream> {
  let sys: MediaStream
  if (isWindows) {
    try {
      sys = await navigator.mediaDevices.getDisplayMedia({ audio: LOOPBACK_AUDIO })
    } catch {
      sys = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: LOOPBACK_AUDIO })
    }
  } else {
    sys = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: LOOPBACK_AUDIO })
  }
  await stripLoopbackProcessing(sys)
  return sys
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
  entityNames?: string[],
  // MQA-270 (B7): the configured ASR engine, so the whisper prewarm below can skip itself on parakeet/
  // apple sessions instead of loading ~100 MB of worker + ORT wasm + whisper-base weights that start()
  // will immediately terminate. Optional and undefined-tolerant: undefined means "unknown yet", which
  // warms (the pre-existing behaviour) rather than guessing cold.
  asrEngine?: string,
  // docs/asr/QUALITY.md — prewarm the quality the user will actually start with (default Best). A Fast
  // prewarm + Best start() used to terminate the warm worker and reload, so first Listen on the default
  // path sat behind a cold large-model load. Fast is a power option: only that setting prewarms Fast.
  asrQuality?: 'best' | 'fast'
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
    qualityDegraded: false,
    captureDegraded: null as CaptureDegraded | null
  })
  const [lines, setLines] = useState<TranscriptLine[]>([])

  const workerRef = useRef<Worker | null>(null)
  const loadedQualityRef = useRef<'best' | 'fast' | null>(null) // quality the warm worker was loaded with
  // The quality the USER actually asked for when start() was called, captured unconditionally of engine
  // and independent of loadedQualityRef (which stays null whenever the whisper worker hasn't loaded yet,
  // e.g. mid-Parakeet/Apple session). fallBackToWhisper and armNetworkRetry's retry() read this so a
  // mid-session engine swap or a network-recovery reload honors the original choice instead of 'fast'.
  const requestedQualityRef = useRef<'best' | 'fast'>('best')
  // Spoken-language hint from settings ('auto' or a language display name, e.g. 'Portuguese'). Read
  // through a ref for the same reason as requestedQualityRef: fallback/retry re-inits fire long after
  // start() returned and must re-send the language the session was started with.
  const asrLanguageRef = useRef<string>('auto')
  const engineRef = useRef<'whisper' | 'parakeet' | 'apple'>('parakeet') // active ASR engine for this session
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
  const queue = useRef<{ audio: Float32Array; speaker: Speaker; partial?: boolean }[]>([])
  const busy = useRef(false)
  const readyRef = useRef(false)
  // Exact text of the note a failed audio window put in the banner, so the next window that decodes can
  // retract THAT note and nothing else (see noteAfterDecodedWindow). Null whenever nothing is outstanding.
  const decodeNoteRef = useRef<string | null>(null)
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
  // Rolling proof-of-life for the device-change probation (see armThemProbation): true once a 'them' window
  // has arrived SINCE the probation was armed. Deliberately a bare boolean — the per-window audio callback
  // that sets it must stay free of clock reads and React state churn.
  const themWindowSeenRef = useRef(false)
  // The 'them'-side degradation cause, held independently of the single exposed `captureDegraded` slot so
  // a mic blip's {side:'you'} write + clear cannot erase a still-live mic-only stretch (MQA-156). Written
  // by every site that degrades 'them', dropped only when 'them' is genuinely capturing again or a new
  // session starts.
  const themDegradedRef = useRef<CaptureDegraded | null>(null)
  const onQRef = useRef(onQuestion)
  onQRef.current = onQuestion
  const onFallbackRef = useRef(onEngineFallback)
  onFallbackRef.current = onEngineFallback
  // Compiled once per corrections-list change (not per line) — word-boundary + case-insensitive so
  // correcting "Toto" never also corrupts "Tomato".
  // The identity guard is what makes "once per list change" true: as a bare render-body assignment this
  // ran once per RENDER, and App re-renders ~60x/s for the whole of a streaming answer (useAsk's flush is
  // rAF-batched), so a 500-name brain rebuilt 500 Unicode RegExps every animation frame. Both incoming
  // arrays are referentially stable between fetches (App's `entityNames` state and `settings.asrCorrections`),
  // so identity is exactly "the list changed".
  const correctionsRef = useRef<{ re: RegExp; to: string }[]>([])
  const compiledCorrectionsForRef = useRef<typeof corrections>(undefined)
  if (compiledCorrectionsForRef.current !== corrections) {
    compiledCorrectionsForRef.current = corrections
    correctionsRef.current = (corrections ?? [])
      .filter((c) => c.from.trim())
      .map((c) => ({ re: new RegExp(`\\b${escapeRegExp(c.from.trim())}\\b`, 'gi'), to: c.to }))
  }
  // Compiled once per entityNames-list change (not per line), same idiom as correctionsRef above.
  const entityCasingRef = useRef<ReturnType<typeof compileEntityCasingCandidates>>([])
  const compiledCasingForRef = useRef<typeof entityNames>(undefined)
  if (compiledCasingForRef.current !== entityNames) {
    compiledCasingForRef.current = entityNames
    entityCasingRef.current = compileEntityCasingCandidates(entityNames ?? [])
  }
  // Preferred mic, read through a ref so the latest choice is used on every (re)acquire.
  const micDeviceIdRef = useRef<string>('')
  micDeviceIdRef.current = micDeviceId ?? ''
  const linesRef = useRef<TranscriptLine[]>([])
  linesRef.current = lines
  // ASR quality (1B.2b) — the interim/provisional bubble currently shown while pump() has a window
  // dequeued and is decoding it. pump() processes windows strictly one at a time (the `busy` gate), so at
  // most one decode is ever in flight — a single ref (not a per-speaker map) is enough to track it.
  const provisionalRef = useRef<{ t: number; speaker: Speaker } | null>(null)
  // Speaker Intelligence (1C.2) — a raw-audio COPY of the 'them' window currently in flight through the
  // Whisper worker, stashed here right before its buffer transfers to the worker (postMessage's transfer
  // list detaches it — see pump() below), so the 'text' response handler can still hand the exact same
  // samples to window.toto.speakerEmbed. Whisper processes one window at a time same as pump() above, so
  // this single ref is enough; null whenever the in-flight window is 'you' (never labeled) or absent.
  const pendingWhisperEmbedRef = useRef<Float32Array | null>(null)
  // Epoch stamped when the Whisper audio window was posted — the worker reply is async and can land
  // after stop()/start() of the next meeting; without this check commitLine would paste into the new
  // transcript (liveRef is true again). Same class as the Parakeet/Apple jobEpoch guards in pump().
  const pendingWhisperEpochRef = useRef(0)
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
  // Whisper 'auto' language probe state (see PROBE_EVERY's block comment above) — mirrors
  // whisper-import.ts's module-level probePinned/activeLang/switchRun, scoped per session via refs since
  // this hook only ever runs one live session at a time (liveRef). Reset on every start() and on a real
  // setLanguage() change so a new/changed session never inherits a previous pin.
  const probePinnedRef = useRef(false)
  const pinnedLangRef = useRef<string | null>(null)
  const probeWindowCountRef = useRef(0)
  const probeSwitchRunRef = useRef<{ lang: string; count: number } | null>(null)

  // ASR quality (1B.2b) — shows a "…" placeholder for the speaker whose window pump() just dequeued and
  // started decoding, so the live transcript doesn't sit blank while a slow/backlogged model works
  // through the queue. `provisional: true` is the entire contract (see TranscriptLineSchema's own doc
  // comment): transcriptToText/save both filter it out, so a decode that never resolves (e.g. a worker
  // crash mid-window) can only ever leave a UI-only placeholder behind, never touch the saved transcript.
  const beginProvisional = useCallback((sp: Speaker): void => {
    const t = Date.now()
    provisionalRef.current = { t, speaker: sp }
    const line: TranscriptLine = { speaker: sp, text: '…', t, provisional: true }
    const next = [...linesRef.current, line]
    linesRef.current = next
    setLines(next)
  }, [])
  // Removes the provisional bubble (if any is still showing) — called at every point a window's decode
  // has SETTLED, whether that produced a real line or not (silence, a dropped duplicate, a decode error),
  // so the placeholder never lingers once there is nothing left to wait for. A no-op when clear()/stop()
  // already wiped `lines` out from under it.
  const clearProvisional = useCallback((): void => {
    const p = provisionalRef.current
    if (!p) return
    provisionalRef.current = null
    const next = linesRef.current.filter((l) => !(l.provisional && l.t === p.t))
    if (next.length === linesRef.current.length) return
    linesRef.current = next
    setLines(next)
  }, [])
  // Speaker Intelligence (1C.2) — attaches a name resolved AFTER the fact (the Whisper speakerEmbed round
  // trip finishes after the line already committed) to the specific line it belongs to, identified by the
  // `t` timestamp commitLine returned when it committed. Guarded on `!l.name` so a slow/duplicate resolve
  // can never clobber a name the line already has.
  const attachSpeakerName = useCallback((t: number, name: string): void => {
    const idx = linesRef.current.findIndex((l) => l.t === t && l.speaker === 'them' && !l.name)
    if (idx < 0) return
    const next = linesRef.current.slice()
    next[idx] = { ...next[idx], name }
    linesRef.current = next
    setLines(next)
  }, [])

  /** 1.9.0 — remap every line whose `name` is `from` to `to` (Review "Name this speaker"). */
  const remapSpeakerNames = useCallback((from: string, to: string): void => {
    const src = from.trim()
    const dest = to.trim()
    if (!src || !dest || src === dest) return
    let changed = false
    const next = linesRef.current.map((l) => {
      if (l.name !== src) return l
      changed = true
      return { ...l, name: dest }
    })
    if (!changed) return
    linesRef.current = next
    setLines(next)
  }, [])

  /** Apply a whole-session cluster merge map (Speaker 3 → Speaker 1) from main's finalizeSession. */
  const applySpeakerMapping = useCallback((mapping: Record<string, string>): void => {
    const entries = Object.entries(mapping).filter(([a, b]) => a && b && a !== b)
    if (!entries.length) return
    const map = new Map(entries)
    let changed = false
    const next = linesRef.current.map((l) => {
      const from = l.name
      if (!from) return l
      const to = map.get(from)
      if (!to || to === from) return l
      changed = true
      return { ...l, name: to }
    })
    if (!changed) return
    linesRef.current = next
    setLines(next)
  }, [])

  // Add a transcribed line + fire the auto-answer hook. Shared by the Whisper worker and Parakeet paths.
  // `name` is the optional Speaker Intelligence label (main-side voice embedding on THEM windows) — the
  // same additive field the Teams-VTT backfill writes, so render/save paths need no change. Returns the
  // committed line's `t` (its identity for attachSpeakerName above) so a caller can attach a
  // Speaker-Intelligence name once it resolves later — null on every path that did NOT commit a line
  // (phantom text, a suppressed dupe run, or a dead/stopped session), so a caller can skip that follow-up
  // work entirely instead of resolving a name for a line that was never shown.
  const commitLine = useCallback((text: string, speaker: Speaker, name?: string, provisional?: boolean): number | null => {
    // Drop phantom/hallucinated lines + non-speech sound-event captions ("[BELL RINGS]", "(applause)",
    // "♪♪♪") before touching state — so they never display live, never reach the recap, never get saved.
    // Single chokepoint for both the Whisper worker and Parakeet paths.
    if (isNonSpeechLine(text)) return null
    // Collapse an intra-line decoder loop BEFORE corrections/casing so those run on the short form.
    let corrected = collapseRepeatedPhrase(text)
    for (const { re, to } of correctionsRef.current) corrected = corrected.replace(re, to)
    // Entity-casing bias runs AFTER corrections so an explicit user correction always wins.
    if (entityCasingRef.current.length) corrected = applyEntityCasingCompiled(entityCasingRef.current, corrected)
    if (!corrected || !liveRef.current) return null
    // Cross-line repetition-loop guard: same normalized line, same speaker, window after window.
    const key = repeatKey(corrected)
    const run = repeatRunRef.current
    if (key && run.key === key && run.speaker === (speaker || 'you')) {
      run.count += 1
      if (run.count > MAX_CONSECUTIVE_DUPES) return null // keep counting so the whole run stays suppressed
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
      ...(lang ? { lang } : {}),
      ...(provisional ? { provisional: true } : {})
    }
    // A final window replaces any streaming partial from the same speaker; a newer partial replaces
    // the previous one so TTFC stays one live caption, not a stack of drafts.
    const withoutStale = linesRef.current.filter(
      (l) => !(l.provisional && l.speaker === line.speaker)
    )
    const next = [...withoutStale, line]
    // Update the ref synchronously BEFORE firing onQ, so text() (read inside the handler) already
    // includes the line that triggered the auto-answer.
    linesRef.current = next
    setLines(next)
    // Auto-answer endpoints on the COALESCED 'them' turn (themRunRef), not a single VAD window: a 'you'
    // line hands the turn back (clear the run); a 'them' line extends it. Fire once the joined run reads
    // as a complete question, then consume the run so a continued sentence doesn't re-fire mid-thought.
    if (provisional) return line.t
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
    return line.t
  }, [])

  // Probes ONE window through Parakeet (main-side IPC, language-agnostic) to pin/re-pin the live Whisper
  // worker's decode language — see PROBE_EVERY's block comment above and whisper.worker.ts's for the full
  // design. Fire-and-forget by construction: called from pump() alongside (never blocking) the whisper
  // decode, and a probe failure — Parakeet released between meetings (parakeetRelease), a flaky IPC round
  // trip, the model simply not being bundled on this platform — must never disturb whisper transcription,
  // so every exit here is silent. Mirrors whisper-import.ts's probeLanguage + reprobeForSwitch, merged into
  // one function since listen.ts (unlike the import job) drives its own single probe cadence in pump().
  const probeLanguageWindow = useCallback((audio: Float32Array, speaker: Speaker): void => {
    const epoch = sessionEpochRef.current
    window.toto
      .parakeetFeed(audio, speaker)
      .then((res) => {
        // The session may have moved on (stopped, switched engine, or the user set an explicit language)
        // by the time this async round trip resolves — a stale probe must not touch the current state.
        // The epoch stamped at dispatch is what makes "same session" checkable: liveRef is true again for
        // the NEXT meeting, so without it a probe from the previous one pinned this worker (MQA-157).
        if (
          probeResultIsStale(
            epoch,
            sessionEpochRef.current,
            liveRef.current,
            engineRef.current,
            asrLanguageRef.current
          )
        )
          return
        const text = typeof res === 'string' ? res : res.text
        // A near-empty window ("Hello") can only mislead — wait for a window with real substance. The bar
        // itself relaxes (once) if the opening probe burst spent PROBE_WINDOW_BUDGET windows without ever
        // pinning — see probeMinWords/PROBE_MIN_WORDS_AGGRESSIVE's block comment above.
        if (text.trim().split(/\s+/).filter(Boolean).length < probeMinWords(probePinnedRef.current, probeWindowCountRef.current)) return
        const found = detectLanguages(text)
        const detected = found.primary
        if (!detected) return
        // Mid-sentence switch: if the window itself is mixed, prefer the language that is NOT the pin.
        const switchTo =
          found.mixed && pinnedLangRef.current
            ? found.langs.find((l) => l !== pinnedLangRef.current) ?? detected
            : detected
        // MQA-235 (live): require SWITCH_AFTER consecutive confirming probes before the FIRST pin too —
        // a greeting in the wrong language used to latch the whole meeting (import already majority-votes).
        const next = advanceLanguageProbe({
          detected: switchTo,
          pinnedLang: probePinnedRef.current ? pinnedLangRef.current : null,
          switchRun: probeSwitchRunRef.current,
          mixed: found.mixed
        })
        probeSwitchRunRef.current = next.switchRun
        if (next.shouldPin && next.pinnedLang) {
          probePinnedRef.current = true
          pinnedLangRef.current = next.pinnedLang
          workerRef.current?.postMessage({ type: 'pinLanguage', language: next.pinnedLang })
        }
      })
      .catch(() => {
        /* silently non-fatal — see block comment above */
      })
  }, [])

  const pump = useCallback((): void => {
    if (!readyRef.current || busy.current || queue.current.length === 0) return
    const job = queue.current.shift() as { audio: Float32Array; speaker: Speaker; partial?: boolean }
    busy.current = true
    // Stamp the session epoch at dequeue so an in-flight decode that lands after stop()/start() of the
    // NEXT meeting cannot commitLine into the wrong transcript (liveRef is true again for the new
    // session — epoch is the only reliable "same meeting" check; same class as MQA-157 for probes).
    const jobEpoch = sessionEpochRef.current
    // ASR quality (1B.2b) — show the "…" placeholder for this speaker the instant decode actually BEGINS
    // (not merely queued), so its timing matches when real speech was captured rather than however long
    // it sat behind a backlog.
    beginProvisional(job.speaker)
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
          if (sessionEpochRef.current !== jobEpoch) return // meeting moved on — drop stale text
          // Normalize both feed shapes: bare string (legacy/error paths) and {text, name?} (Speaker
          // Intelligence labels THEM windows main-side — see SPEAKER-INTELLIGENCE-PLAN §3).
          const text = typeof res === 'string' ? res : res.text
          const speakerName = typeof res === 'string' ? undefined : res.name
          parakeetFailures.current = 0 // success (even empty) resets the IPC-failure streak
          if (text === '') {
            // Echo-defense dropping operator bleed is intentional silence — never count it as an engine
            // stall (that used to silent-downgrade a healthy Parakeet session to floor Whisper).
            if (feedEmptyIsEcho(res)) {
              parakeetEmptyRunRef.current = 0
            } else {
              // Empty but technically successful: the window passed EMIT_RMS so audio WAS flowing — the
              // engine returning nothing every time signals a stall (wrong model path, native init failure,
              // silent loopback bug). Fall back to Whisper after a run so windows aren't silently swallowed.
              parakeetEmptyRunRef.current += 1
              if (parakeetEmptyRunRef.current >= PARAKEET_EMPTY_RUN_MAX) {
                console.warn('[listen] parakeet returning empty every window — falling back to Whisper')
                fallBackToWhisper()
              }
            }
          } else {
            parakeetEmptyRunRef.current = 0
            commitLine(text, job.speaker, speakerName)
          }
        })
        .catch((err) => {
          if (sessionEpochRef.current !== jobEpoch) return
          parakeetFailures.current += 1
          console.warn(
            `[listen] parakeet window failed (${parakeetFailures.current}/${PARAKEET_MAX_FAILURES}):`,
            (err as Error)?.message
          )
          if (parakeetFailures.current >= PARAKEET_MAX_FAILURES) fallBackToWhisper()
        })
        .finally(() => {
          clearProvisional() // this window has settled one way or another — the placeholder's job is done
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
          if (sessionEpochRef.current !== jobEpoch) return
          const text = typeof res === 'string' ? res : res.text
          const speakerName = typeof res === 'string' ? undefined : res.name
          parakeetFailures.current = 0 // success (even empty) resets the IPC-failure streak
          if (text === '') {
            if (feedEmptyIsEcho(res)) {
              parakeetEmptyRunRef.current = 0
            } else {
              parakeetEmptyRunRef.current += 1
              if (parakeetEmptyRunRef.current >= PARAKEET_EMPTY_RUN_MAX) {
                console.warn('[listen] apple speech returning empty every window — falling back to Whisper')
                fallBackToWhisper()
              }
            }
          } else {
            parakeetEmptyRunRef.current = 0
            commitLine(text, job.speaker, speakerName)
          }
        })
        .catch((err) => {
          if (sessionEpochRef.current !== jobEpoch) return
          parakeetFailures.current += 1
          console.warn(
            `[listen] apple speech window failed (${parakeetFailures.current}/${PARAKEET_MAX_FAILURES}):`,
            (err as Error)?.message
          )
          if (parakeetFailures.current >= PARAKEET_MAX_FAILURES) fallBackToWhisper()
        })
        .finally(() => {
          clearProvisional()
          busy.current = false
          pump()
        })
      return
    }
    // Only the whisper engine falls through to here (parakeet/apple both returned above). In 'auto' mode
    // Whisper cannot tell what language this window is on its own (see PROBE_EVERY's block comment) — feed
    // it to Parakeet on the probe cadence too, BEFORE the audio buffer is transferred to the worker below
    // (postMessage's transfer list detaches job.audio.buffer synchronously; probeLanguageWindow must read it
    // first). Fire-and-forget: its own .then/.catch never touches busy/queue, so it cannot affect the pump
    // loop's timing or backpressure.
    if (asrLanguageRef.current === 'auto') {
      probeWindowCountRef.current += 1
      if (shouldProbeLanguageWindow(probeWindowCountRef.current, probePinnedRef.current)) {
        probeLanguageWindow(job.audio, job.speaker)
      }
    }
    if (!workerRef.current) {
      // beginProvisional already showed "…" — clear it so a missing worker never leaves a stuck placeholder.
      clearProvisional()
      busy.current = false
      return
    }
    // Speaker Intelligence (1C.2) — Whisper has no in-band speaker tap the way Parakeet/Apple's IPC feed
    // does, so a THEM window's audio must be COPIED here, before its buffer transfers to the worker below
    // (postMessage's transfer list detaches job.audio.buffer synchronously), so the 'text' response
    // handler can still hand the exact same samples to window.toto.speakerEmbed afterwards.
    if (job.speaker === 'them') pendingWhisperEmbedRef.current = job.audio.slice()
    else {
      pendingWhisperEmbedRef.current = null
      void window.toto.speakerEmbed(job.audio.slice(), 'you').catch(() => {})
    }
    pendingWhisperEpochRef.current = jobEpoch
    workerRef.current.postMessage(
      { type: 'audio', audio: job.audio, speaker: job.speaker, partial: !!job.partial },
      [job.audio.buffer]
    )
    // fallBackToWhisper (called in the parakeet .catch above) is forward-declared below and intentionally
    // omitted from deps: pump → fallBackToWhisper → ensureWorker → pump is a cycle, so listing it would TDZ
    // at render. All four callbacks are stable (created once), so pump's captured reference never goes stale.
  }, [commitLine, probeLanguageWindow, beginProvisional, clearProvisional])

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
        partial?: boolean
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
        if (pendingWhisperEpochRef.current !== sessionEpochRef.current) {
          // Stale decode from a previous meeting — drop without touching live UI/error state.
          clearProvisional()
          pendingWhisperEmbedRef.current = null
          busy.current = false
          pump()
          return
        }
        if (!armNetworkRetry(m.message ?? '')) {
          const note = m.message ?? 'transcription error'
          // armNetworkRetry declines once the model is loaded because this is a per-window decode
          // failure, not a load failure — and a per-window failure is transient. Record the exact note so
          // the next successful window takes it back down; a LOAD failure (readyRef false) stays sticky,
          // because nothing is going to recover it on its own.
          if (readyRef.current) decodeNoteRef.current = note
          setState((s) => ({ ...s, error: note, loading: false }))
        }
        clearProvisional() // this window has settled (with an error) — the placeholder's job is done
        pendingWhisperEmbedRef.current = null
        busy.current = false
        pump()
      } else if (m.type === 'text') {
        clearProvisional() // this window has settled — replace the placeholder with the real line below
        const embedAudio = pendingWhisperEmbedRef.current
        pendingWhisperEmbedRef.current = null
        if (pendingWhisperEpochRef.current !== sessionEpochRef.current) {
          // Meeting moved on while this window decoded — never commit into the new transcript.
          busy.current = false
          pump()
          return
        }
        const committedAt = commitLine(
          m.text || '',
          (m.speaker as Speaker) || 'you',
          undefined,
          !!m.partial
        )
        // Speaker Intelligence (1C.2) — fire-and-forget AFTER the line already committed: never blocks
        // the live decode, and a slow/failed round trip just leaves the line unlabeled (the pre-P2
        // outcome). Only for 'them' windows that actually produced a line — nothing to attach a name to
        // otherwise (silence, a suppressed dupe, or a 'you' window, which is never labeled).
        if (committedAt !== null && !m.partial && (m.speaker as Speaker) === 'them' && embedAudio) {
          void window.toto
            .speakerEmbed(embedAudio, 'them')
            .then((res) => {
              // Echo defense (parity with Parakeet/Apple): operator bleed through loopback must not stay
              // labeled as THEM. Whisper already committed the text before embed returns — drop the line.
              if (res?.echo) {
                const next = linesRef.current.filter((line) => line.t !== committedAt)
                linesRef.current = next
                setLines(next)
                return
              }
              if (res?.name) attachSpeakerName(committedAt, res.name)
            })
            .catch(() => {})
        }
        if (decodeNoteRef.current) {
          const note = decodeNoteRef.current
          decodeNoteRef.current = null
          setState((s) => {
            const next = noteAfterDecodedWindow(s.error, note)
            return next === s.error ? s : { ...s, error: next }
          })
        }
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
      provisionalRef.current = null // no decode is ever coming back to replace it now
      pendingWhisperEmbedRef.current = null
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
    (sp: Speaker, audio: Float32Array, partial = false): void => {
      if (!liveRef.current || pausedRef.current) return
      queue.current.push({ audio, speaker: sp, partial })
      if (queue.current.length > MAX_QUEUE) {
        const before = queue.current.length
        // bound memory; drop oldest, but never the newest window of either speaker — see trimQueue.
        queue.current = trimQueue(queue.current, MAX_QUEUE)
        const dropped = before - queue.current.length
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

  // Silent-death probation for a 'them' channel after an audio-device change. A default-output switch
  // mid-meeting (headphones plugged in) can leave the loopback capture in readyState 'live' while it
  // delivers nothing but silence: no 'ended' event fires, so the track handler never runs and
  // recoverSystemAudio self-blocks on the still-registered channel — the remote half of the meeting was
  // lost for good while the Bar kept showing the healthy "Heard live" chip. armThemWatchdog can't cover
  // this: it disarms permanently once the channel has been heard. Give the channel THEM_WATCHDOG_MS to
  // deliver ONE window, then recycle it if it delivered none. Armed only by a device change — a naturally
  // quiet stretch (you talking for 20 s) must never tear down a healthy loopback.
  function armThemProbation(): void {
    if (themWatchdogRef.current) clearTimeout(themWatchdogRef.current)
    themWindowSeenRef.current = false
    themWatchdogRef.current = setTimeout(() => {
      themWatchdogRef.current = null
      if (!liveRef.current || pausedRef.current) return
      // MQA-109: a channel that was already confirmed healthy (themHeardRef) must not be recycled just for
      // going quiet during probation — only with positive evidence its audio tracks actually died (all
      // ended, or the source went muted). A channel that never proved itself keeps the original prove-or-die
      // probation, so its death evidence stays true. Reading the live track state here (not on the per-window
      // audio callback) keeps the capture hot path allocation-free.
      const ch = channels.current.them
      const hasDeathEvidence = !themHeardRef.current || themTracksLookDead(ch ? ch.stream.getAudioTracks() : [])
      const verdict = themDeviceChangeAction(
        wantsSystemRef.current,
        !!ch,
        themWindowSeenRef.current,
        hasDeathEvidence
      )
      if (verdict !== 'recycle') return
      console.warn('[listen] them silent since the device change — recycling the loopback capture')
      closeChannel('them') // recoverSystemAudio refuses to run while a channel is still registered
      themDegradedRef.current = { side: 'them', note: THEM_LOST_MSG, permission: false }
      setState((s) => ({ ...s, error: THEM_LOST_MSG, captureDegraded: themDegradedRef.current }))
      void recoverSystemAudioRef.current?.()
    }, THEM_WATCHDOG_MS)
  }

  /** MQA-268: per-speaker serialization for openChannel. The channel record is stored only AFTER the
   *  `await addModule(...)` inside — so the Windows paced retry's `if (channels.current.them) return`
   *  guard reads undefined while a first open is still in flight, slips past, and opens a SECOND channel
   *  whose entry closeChannel closes nothing (the first record does not exist yet). Both worklets end up
   *  live on the same system audio, each with its own VAD clock, and every utterance transcribes twice —
   *  identical pairs when sentence pauses align the cuts, offset overlapping fragments when they do not.
   *  Observed verbatim on packaged 1.6.5: a five-sentence call where every line appeared exactly twice.
   *  Chaining opens per speaker makes the second open's closeChannel actually see (and stop) the first. */
  const openSeqRef = useRef<Partial<Record<Speaker, Promise<void>>>>({})
  // Ref-indirected like recoverSystemAudioRef below: openChannelNow's identity changes with pushAudio,
  // and the serializing wrapper must always invoke the CURRENT one, not the render it was created in.
  const openChannelNowRef = useRef<((sp: Speaker, stream: MediaStream) => Promise<void>) | null>(null)

  const openChannel = useCallback((sp: Speaker, stream: MediaStream): Promise<void> => {
    const prev = openSeqRef.current[sp] ?? Promise.resolve()
    // Chain regardless of the predecessor's outcome — a failed open must not wedge every later one.
    const run = prev.catch(() => {}).then(() => openChannelNowRef.current?.(sp, stream))
    openSeqRef.current[sp] = run.catch(() => {}) as Promise<void> // keep the chain alive past a failure
    return run as Promise<void>
  }, [])

  const openChannelNow = useCallback(
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
      if (gain) gain.gain.value = 3.0 // ~10 dB boost for a genuinely quiet loopback (low system volume)
      // MQA-267: the boost needs a limiter behind it now. The 3.0x was sized while the loopback ran
      // through AGC (default-on voice processing, since removed) which held the signal small — "safe
      // headroom" was true then. Un-processed loopback of a call at normal volume peaks near full scale,
      // and 3.0x that is +-3.0 in the float graph: Web Audio does not clamp, so the overs survive to the
      // ASR's [-1,1] PCM conversion and hard-clip there — distortion that degrades recognition the
      // opposite way the boost intended. A limiter keeps the lift for quiet signals and flattens only
      // the overs; ASR is robust to gain compression and terrible with clipping.
      const limiter = gain ? ctx.createDynamicsCompressor() : null
      if (limiter) {
        limiter.threshold.value = -6 // dBFS; engage just before full scale
        limiter.knee.value = 6
        limiter.ratio.value = 20 // limiting, not gentle compression
        limiter.attack.value = 0.001
        limiter.release.value = 0.1
      }

      worklet.port.onmessage = (ev: MessageEvent): void => {
        const data = ev.data as { audio?: Float32Array }
        if (data.audio) {
          if (sp === 'them') {
            // Rolling proof-of-life read by armThemProbation — one boolean store, nothing else, so the
            // per-window path stays as cheap as it was before the probation existed.
            themWindowSeenRef.current = true
            // First real emission from 'them' proves the channel is alive: cancel the watchdog AND clear
            // the soft note if it's already showing (loopback can arrive AFTER the 20 s window — the note
            // must not stay stuck for the rest of the session). Guarded by themHeardRef so this runs once.
            if (!themHeardRef.current) {
              themHeardRef.current = true
              if (themWatchdogRef.current) {
                clearTimeout(themWatchdogRef.current)
                themWatchdogRef.current = null
              }
              setState((s) => (s.error === THEM_SILENT_MSG ? { ...s, error: null } : s))
            }
          }
          pushAudio(sp, data.audio, !!(data as { partial?: boolean }).partial)
        }
      }
      const ch: Channel = { ctx, src, worklet, stream, gain: gain ?? undefined, limiter: limiter ?? undefined }
      channels.current[sp] = ch
      if (gain && limiter) {
        // them: source -> boost -> limiter -> worklet. The limiter must sit AFTER the gain — it exists
        // to flatten the overs the gain creates; upstream of it, it would do nothing.
        src.connect(gain)
        gain.connect(limiter)
        limiter.connect(worklet)
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
            setState((s) => ({ ...s, error: MIC_LOST_MSG, captureDegraded: { side: 'you', note: MIC_LOST_MSG, permission: false } }))
            void recoverMicRef.current?.()
          } else {
            themDegradedRef.current = { side: 'them', note: THEM_LOST_MSG, permission: false }
            setState((s) => ({ ...s, error: THEM_LOST_MSG, captureDegraded: themDegradedRef.current }))
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
  openChannelNowRef.current = openChannelNow

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
      setState((s) => ({
        ...s,
        error: s.error === MIC_LOST_MSG ? null : s.error,
        captureDegraded: degradedAfterMicRecovery(
          s.captureDegraded,
          themDegradedRef.current,
          wantsSystemRef.current,
          !!channels.current.them
        )
      }))
    } catch {
      // Nothing to acquire (no mic connected) — the sticky MIC_LOST_MSG stays until a device change
      // retriggers recovery or the user restarts Listen.
      setState((s) => ({ ...s, error: MIC_LOST_MSG, captureDegraded: { side: 'you', note: MIC_LOST_MSG, permission: false } }))
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
  // Pacing for the Windows arm of that watcher (see sysRetryDelayMs). Reset wherever recovery becomes
  // plausible again — a new session, a successful re-acquire, a real device change — so the backoff only
  // ever tracks a genuinely stuck loopback.
  const sysRetryAttemptsRef = useRef(0)
  const sysRetryNextAtRef = useRef(0)
  const recoverSystemAudioRef = useRef<(() => Promise<void>) | null>(null)
  recoverSystemAudioRef.current = async (): Promise<void> => {
    if (!liveRef.current || sysRecoveringRef.current) return
    if (channels.current.them) return // already have a live 'them' channel — nothing to recover
    sysRecoveringRef.current = true
    try {
      await window.toto.armAudio(true)
      let sys: MediaStream
      try {
        // MQA-267: acquired through the one shared path, which disables voice processing on the
        // loopback — see acquireLoopback/LOOPBACK_AUDIO for why AEC on this track eats the far end.
        sys = await acquireLoopback()
      } finally {
        await window.toto.armAudio(false)
      }
      const liveAudio = sys.getAudioTracks().filter((t) => t.readyState !== 'ended')
      if (!liveRef.current || !liveAudio.length) {
        sys.getTracks().forEach((t) => t.stop())
        return
      }
      await openChannel('them', sys)
      themDegradedRef.current = null // 'them' is capturing again — nothing left to restore on a later mic blip
      sysRetryAttemptsRef.current = 0 // recovered — a later loss starts its backoff from scratch
      sysRetryNextAtRef.current = 0
      setState((s) => ({
        ...s,
        // Clear the mid-session loss note AND the start-time mic-only note (held in captureDegraded.note):
        // the permission-watcher path used to match only THEM_LOST_MSG here, leaving "System audio needs
        // Screen Recording permission…" stuck for the rest of the session after a successful mid-meeting
        // grant + recovery.
        error:
          s.error === THEM_LOST_MSG || (s.captureDegraded?.side === 'them' && s.error === s.captureDegraded.note)
            ? null
            : s.error,
        captureDegraded: s.captureDegraded?.side === 'them' ? null : s.captureDegraded
      }))
    } catch {
      // Couldn't re-acquire (permission genuinely revoked, or no loopback available) — leave the sticky
      // note so the live permission watcher / a devicechange can retrigger recovery later.
      setState((s) =>
        themRecoveryFailureIsNoop(s.error, s.captureDegraded)
          ? s
          : {
              ...s,
              error: s.error === null ? THEM_LOST_MSG : s.error,
              captureDegraded: s.captureDegraded ?? { side: 'them', note: THEM_LOST_MSG, permission: false }
            }
      )
    } finally {
      sysRecoveringRef.current = false
    }
  }

  // Follow the default input across device changes while the mic channel is live. A Bluetooth switch
  // often leaves the old track "alive" but permanently silent (no 'ended' event) — the classic silent
  // death. Debounced: connect+disconnect storms settle before we re-acquire once.
  // The loopback ('them') side dies exactly the same way on a default-OUTPUT change — on Windows the old
  // render endpoint stays valid, so capture keeps handing us zero-filled buffers with no error and no
  // 'ended' — and used to have no detector at all past its first window, losing the whole remote side of
  // the meeting. It is handled here too, but through themDeviceChangeAction rather than a blind restart:
  // recycling on every device blip would needlessly tear down the macOS SCStream mid-meeting.
  const devChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const onDeviceChange = (): void => {
      if (!liveRef.current) return
      if (devChangeTimerRef.current) clearTimeout(devChangeTimerRef.current)
      devChangeTimerRef.current = setTimeout(() => {
        devChangeTimerRef.current = null
        if (channels.current.you) void recoverMicRef.current?.()
        const action = themDeviceChangeAction(wantsSystemRef.current, !!channels.current.them, null)
        if (action === 'watch') armThemProbation()
        else if (action === 'recover') {
          // A real device change is new evidence, not another blind retry — try immediately and drop
          // whatever backoff the watcher had built up.
          sysRetryAttemptsRef.current = 0
          sysRetryNextAtRef.current = 0
          void recoverSystemAudioRef.current?.()
        }
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
  // Settings toggle, Métis picks up system audio on its own. Windows has no permission to wait on, so the
  // same interval is a plain capture-state retry there. Only runs while listening + system was requested;
  // the tick is skipped entirely once 'them' is live.
  useEffect(() => {
    if (!state.listening || !wantsSystemRef.current) return
    const iv = setInterval(() => {
      if (channels.current.them || sysRecoveringRef.current) return // already have it / mid-recovery
      // Windows never reports 'granted' here (windowsScreenStatus() hard-codes 'unknown' — there is no OS
      // permission gate to poll), so the poll below can structurally never fire the retry there. Skipping
      // the whole EFFECT on that basis, as this used to, deleted the retry along with the pointless IPC: a
      // transient start-time loopback failure (default output mid-switch, another app holding the render
      // endpoint) left the meeting mic-only until the user stopped and restarted Listen — which splits the
      // meeting into two transcripts. Retry off actual capture state instead of a string that never flips.
      // Paced, because there is no permission flip to wait on here and nothing else bounds the loop when
      // the loopback is simply unavailable for the whole call — see sysRetryDelayMs.
      if (isWindows) {
        const now = Date.now()
        if (now < sysRetryNextAtRef.current) return
        sysRetryNextAtRef.current = now + sysRetryDelayMs(sysRetryAttemptsRef.current++)
        void recoverSystemAudioRef.current?.()
        return
      }
      void window.toto
        .getPermissions()
        .then((p) => {
          if (p?.screenRecording === 'granted' && !channels.current.them) {
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
      engine: 'whisper' | 'parakeet' | 'apple' = 'parakeet',
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
          clearTimeout(workerIdleTimer.current)
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
        provisionalRef.current = null // fresh session — no carried-over placeholder from the previous one
        pendingWhisperEmbedRef.current = null
        busy.current = false
        liveRef.current = true
        wantsSystemRef.current = source === 'system' || source === 'both'
        sysRetryAttemptsRef.current = 0 // fresh session → no carried-over loopback-retry backoff
        sysRetryNextAtRef.current = 0
        pausedRef.current = false
        disarmNetworkRetry() // a fresh session supersedes any retry armed for the previous one
        crashedRef.current = false // fresh session — re-enable stop()'s teardown after any prior crash
        parakeetFailures.current = 0 // reset the failure streak so a new session gets a clean shot at Parakeet
        parakeetEmptyRunRef.current = 0 // clear the empty-window run counter for a fresh session
        engineRef.current = engine
        themRunRef.current = '' // fresh session → no carried-over 'them' question turn
        repeatRunRef.current = { key: '', speaker: '', count: 0 } // fresh session → no carried-over dupe run
        // Fresh session → no carried-over Parakeet language pin (mirrors whisper.worker.ts's own
        // resetFollow, sent further below as part of the 'init' message for the exact same reason).
        probePinnedRef.current = false
        pinnedLangRef.current = null
        probeWindowCountRef.current = 0
        probeSwitchRunRef.current = null
        themDegradedRef.current = null // fresh session → no carried-over 'them' degradation cause
        setState((s) => ({ ...s, error: null, captureDegraded: null, listening: true, paused: false }))
        // MQA-285: same-turn capture. Kick getUserMedia BEFORE any await so the click gesture still
        // covers the permission prompt and the first second of audio is on the MediaStream — not lost
        // behind setListeningState / parakeetEnsure / getAsrBundled. Windows queue in pump() until
        // the (prewarmed) engine reports ready.
        let micP: Promise<MediaStream> | null = null
        if (source === 'mic' || source === 'both') {
          micP = acquireMic(micDeviceIdRef.current)
        }
        void window.toto.setListeningState(true).catch(() => {})

        void (async () => {
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
              if (!liveRef.current) return
              if (!st.ready) {
                const off = window.toto.onParakeetProgress((pct) => setState((s) => ({ ...s, loadingPct: pct })))
                try {
                  const r = await window.toto.parakeetEnsure()
                  if (!r?.ok) throw new Error(r?.error || 'parakeet model unavailable')
                } finally {
                  off()
                }
              }
              if (!liveRef.current) return
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
            if (!liveRef.current) return
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
        })()

        // Capture each side INDEPENDENTLY. The mic ("you") and the system loopback ("them") fail for
        // different reasons (mic = Microphone permission; loopback = Screen Recording + Electron's
        // getDisplayMedia, which throws a raw "user aborted a request" on many machines). Isolating them
        // means a system-audio failure never masks a perfectly good microphone — you keep listening,
        // mic-only, with a clear note instead of a scary abort.
        let micOk = false
        let sysOk = false
        let sysErr: Error | null = null // captured for error-message classification below

        if (micP) {
          try {
            const mic = await micP
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
              // MQA-267: acquired through the one shared path (voice processing disabled on the
              // loopback — AEC on this track subtracts the very audio it exists to capture).
              //
              // IMPORTANT (macOS): do NOT call t.stop() on the returned video track here. The video and
              // audio loopback share a single ScreenCaptureKit SCStream session; stopping the video
              // track before the audio worklet is connected can terminate that SCStream, leaving the
              // audio track in readyState 'ended' — alive in getAudioTracks() but producing no PCM.
              // openChannel() stores the full stream (video + audio); closeChannel() calls t.stop()
              // on every track when Listen ends, releasing the recording indicator cleanly then.
              // acquireLoopback never stops tracks, so this contract holds.
              sys = await acquireLoopback()
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
          // MQA-285: a failed start must not idle-unload a hot prewarmed engine — the next Listen
          // (or a retry) should still be instant. Unmount is the only teardown of the worker.
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
        // Mirror the soft note into the structured captureDegraded state: `micOk` discriminates the side
        // (note is only non-null on source==='both' with exactly one side up). The persistent chrome (Bar
        // chip / minimized pill) reads this instead of `error`, which only renders inside the Copilot body
        // and is invisible with the panel collapsed or the widget minimized — exactly how a whole meeting
        // ran mic-only unnoticed on 2026-07-20.
        const captureDegraded: CaptureDegraded | null = note
          ? { side: micOk ? 'them' : 'you', note, permission: micOk && isSysPermDenied }
          : null
        themDegradedRef.current = captureDegraded?.side === 'them' ? captureDegraded : null
        // At least one channel (mic and/or system loopback) is confirmed open here — this is the point
        // a consent/recording indicator should key off, not the optimistic `listening: true` set at the
        // top of start() before any capture was actually acquired.
        setState((s) => ({ ...s, error: note, captureDegraded, listening: true, capturing: true, loading: !readyRef.current }))
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
    ch.limiter?.disconnect()
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
      clearProvisional() // a decode still in flight at the ceiling never gets to replace its placeholder
      pendingWhisperEmbedRef.current = null
      themRunRef.current = '' // run after the drain: any final flushed question already fired while liveRef was true
      closeChannel('you')
      closeChannel('them')
      void window.toto.setListeningState(false).catch(() => {})
      // 1.9.0 — collapse over-split "Speaker N" clusters before the recap/save reads lines.
      void window.toto
        .speakerFinalize()
        .then((mapping) => {
          if (mapping && Object.keys(mapping).length) applySpeakerMapping(mapping)
        })
        .catch(() => {})
        .finally(() => {
          setState((s) => ({
            ...s,
            listening: false,
            capturing: false,
            paused: false,
            loading: false,
            error: null,
            captureDegraded: null
          }))
          drainTimerRef.current = null
          stoppingRef.current = false
          onDrained?.()
        })
      // MQA-285: keep the hot engine. Idle-unloading here forced a cold start on the next Listen and
      // on the post-meeting recap. Unmount still tears the worker down.
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
  }, [closeChannel, disarmNetworkRetry, applySpeakerMapping])

  const clear = useCallback((): void => {
    setLines([])
    provisionalRef.current = null // wiping the transcript also drops any still-showing placeholder
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

  // MQA-285: prewarm at app ready so Listen click finds ASR already running. No 4s delay, no
  // requestIdleCallback, no idle-unload of a hot engine — those three were why Tony's click sat
  // behind a cold model load. Apple has nothing to construct ahead of time. Parakeet (if that's
  // the configured engine) is warmed via parakeetEnsure, which now also constructs the recognizer.
  // Whisper (default / unknown) still loads the worker + weights here.
  //
  // MQA-270 (B7) still holds for engine gating: a parakeet/apple install must not pay ~100 MB of
  // whisper worker + ORT wasm at boot. The idle-release half of B7 is superseded by MQA-285.
  useEffect(() => {
    if (asrEngine === 'apple') return
    let warmed = false
    const warm = async (): Promise<void> => {
      if (warmed) return
      warmed = true
      try {
        if (asrEngine === 'parakeet') {
          await window.toto.parakeetEnsure()
          return
        }
        if (workerRef.current) return
        const bundled = await getAsrBundled()
        // Prewarm carries no language: the setting is only known per-session at start(), whose init
        // message updates the (already warm) worker's language before the first audio window.
        // Quality matches the Settings request (default Best) so first Listen is not a cold Best load.
        const warmQuality = asrQuality === 'fast' ? 'fast' : 'best'
        ensureWorker().postMessage({ type: 'init', quality: warmQuality, bundled })
        loadedQualityRef.current = warmQuality
      } catch {
        /* best-effort prewarm */
      }
    }
    void warm()
  }, [ensureWorker, getAsrBundled, asrEngine, asrQuality])

  // Mid-session spoken-language change (Settings → Audio while listening). The ref update covers every
  // engine's future reads; only a live Whisper worker needs an explicit nudge — a warm re-init whose
  // language lands before the worker's already-loaded early return (see whisper.worker.ts).
  const setLanguage = useCallback(
    async (language: string): Promise<void> => {
      if (asrLanguageRef.current === language) return
      asrLanguageRef.current = language
      // A real language change abandons any in-progress Parakeet probe/pin from the previous setting —
      // mirrors whisper-import.ts's applyInitLanguage delta-reset (and whisper.worker.ts's own
      // resetLanguageFollow, triggered below by the 'init' message reaching an unchanged-quality warm
      // worker through its delta path). Applies whether the OLD or the NEW value was 'auto': a real
      // language change either way must never inherit a stale pin.
      probePinnedRef.current = false
      pinnedLangRef.current = null
      probeWindowCountRef.current = 0
      probeSwitchRunRef.current = null
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
    () => ({
      ...state,
      lines,
      start,
      stop,
      pause,
      resume,
      clear,
      text,
      setLanguage,
      remapSpeakerNames,
      applySpeakerMapping
    }),
    [state, lines, start, stop, pause, resume, clear, text, setLanguage, remapSpeakerNames, applySpeakerMapping]
  )
}
