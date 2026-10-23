/**
 * spoken-replies-service.ts — the playback core of spoken replies (G27, CAP-18).
 *
 * One place decides whether an answer is spoken, which voice speaks it, and when it must stop:
 *
 *  - Generation. Every user input (a typed ask beginning, a voice or dictation hold, a stop, a preview, a meeting
 *    starting) raises one counter. A reply remembers the generation it was asked in, and is spoken only if that is
 *    still the current one when its text is complete. Raising the counter cancels whatever is playing: the adapter's
 *    child gets SIGTERM at once (and SIGKILL after a fixed bound, see TTS_FORCE_KILL_AFTER_MS), and the state reads
 *    idle in the same call, so a late event from the old voice can change nothing.
 *  - Muted and unavailable are quiet states, not errors. The answer is on screen either way; this module never
 *    touches the ask stream, the clipboard or the window. It only listens.
 *  - Approved voices. Only installed system voices that pass approved-voices.ts are ever used; an absent or stale
 *    saved id falls back to the first approved installed voice. Nothing is downloaded or delegated to an unchecked
 *    system default.
 *  - Scope. Only the assistant's answer to a typed or spoken question (modes `answer` and `vision`) is read. Live
 *    suggestions, summaries and recaps are not, and a recording meeting mutes speech so the speaker is not captured.
 *
 * No timers live here; the one bounded timer is in the process host. The clock and every port are injected.
 */
import { IPC } from '@shared/ipc'
import {
  SPOKEN_REPLIES_PREVIEW_TEXT,
  type PreviewRequest,
  type SpokenRepliesState,
  type TtsVoice
} from '@shared/spoken-replies'
import {
  clampSpeechRate,
  DEFAULT_SPOKEN_REPLIES_SETTINGS,
  type SpokenRepliesSettings
} from '@shared/spoken-replies-settings'
import { approveVoices, resolveVoiceChoice } from './approved-voices'
import { toSpokenText } from './speech-text'
import type { TtsAdapter, TtsPlayback } from './tts-adapter'

/** How long an installed-voice list is trusted before it is read again. */
export const VOICE_LIST_TTL_MS = 60_000
/** Asks being collected at once. A flood of asks cannot grow this without bound. */
export const MAX_PENDING_REPLIES = 8
/** An answer longer than this is not collected further (the voice reads far less than this anyway). */
export const MAX_COLLECTED_CHARS = 100_000

/** The asks whose answer is the assistant replying to the person. Everything else is never read aloud. */
const SPOKEN_ASK_MODES: ReadonlySet<string> = new Set(['answer', 'vision'])

export type BargeInReason = 'typed-ask' | 'voice-hold' | 'stop' | 'meeting' | 'hard-stop' | 'preview' | 'quit'

export type SpokenRepliesAudit =
  | { readonly phase: 'started' }
  | { readonly phase: 'ended'; readonly reason: 'finished' | 'interrupted' }
  | { readonly phase: 'cancelled'; readonly reason: BargeInReason | 'replaced' | 'disabled' }
  | { readonly phase: 'dropped'; readonly reason: 'stale' }
  | { readonly phase: 'failed'; readonly reason: 'no_voice' | 'engine' | 'spawn' }

/** What the ask path tells this module. It carries the ask's id, mode and stream events, never anything else. */
export type AskObservation =
  | { readonly type: 'begin'; readonly id: string; readonly mode: string }
  | { readonly type: 'event'; readonly id: string; readonly channel: string; readonly payload: unknown }
  | { readonly type: 'cancel'; readonly id: string }

export type SpeakOutcome = 'spoken' | 'stale' | 'off' | 'unavailable' | 'meeting' | 'empty'
export type PreviewOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unavailable' | 'meeting' | 'interrupted' }

export interface SpokenRepliesDeps {
  /** The platform engine, or null where there is none (Linux, or the macOS helper is not installed). */
  readonly adapter: TtsAdapter | null
  readonly platform?: NodeJS.Platform
  getSettings(): { spokenReplies?: SpokenRepliesSettings }
  /** A meeting is being recorded: the speaker would be captured, so nothing is spoken. */
  meetingLive(): boolean
  now?(): number
  onState?(state: SpokenRepliesState): void
  audit?(event: SpokenRepliesAudit): void
}

export interface SpokenReplies {
  /** Raise the generation and stop whatever is playing. Returns the new generation. */
  bargeIn(reason: BargeInReason): number
  /** The ask path's events: the begin of an ask, its stream events, and a cancel. */
  observeAsk(event: AskObservation): void
  /** Speak a completed answer if its generation is still current. Exposed for the ask observer and for tests. */
  speakReply(text: string, generation: number): Promise<SpeakOutcome>
  preview(request: PreviewRequest): Promise<PreviewOutcome>
  stop(): void
  listVoices(): Promise<TtsVoice[]>
  snapshot(): SpokenRepliesState
  /** Settings changed (or a poll): silence replies that are now off; a failed engine gets another chance on a real change. */
  refresh(): void
  dispose(): void
}

interface ActivePlayback {
  readonly kind: 'reply' | 'preview'
  playback: TtsPlayback | null
}

export function createSpokenReplies(deps: SpokenRepliesDeps): SpokenReplies {
  const platform = deps.platform ?? process.platform
  const now = deps.now ?? Date.now
  const audit = (event: SpokenRepliesAudit): void => {
    try {
      deps.audit?.(event)
    } catch {
      // Auditing is best effort and never changes playback.
    }
  }

  let generation = 0
  let previewGeneration = 0
  let revision = 0
  let engineFailed = false
  let disposed = false
  let active: ActivePlayback | null = null
  let currentReplyAskId: string | null = null
  const pending = new Map<string, { generation: number; text: string }>()
  let voiceCache: { at: number; voices: TtsVoice[] } | null = null
  let voiceLoad: Promise<TtsVoice[]> | null = null

  const settings = (): SpokenRepliesSettings => deps.getSettings().spokenReplies ?? DEFAULT_SPOKEN_REPLIES_SETTINGS
  let repliesEnabled = settings().speakReplies
  const available = (): boolean => deps.adapter !== null && !engineFailed
  let settingsKey = JSON.stringify(settings())

  const mutedReason = (): SpokenRepliesState['muted'] => {
    if (!settings().speakReplies) return 'off'
    if (!available()) return 'unavailable'
    if (deps.meetingLive()) return 'meeting'
    return null
  }
  const stateKey = (): string => `${available()}|${active?.kind ?? 'idle'}|${mutedReason()}`
  let lastKey = stateKey()

  const snapshot = (): SpokenRepliesState => ({
    revision,
    available: available(),
    playback: active?.kind ?? 'idle',
    muted: mutedReason(),
    generation
  })

  const emit = (): void => {
    const key = stateKey()
    if (key === lastKey) return
    lastKey = key
    revision += 1
    try {
      deps.onState?.(snapshot())
    } catch {
      // A broken listener must not stop playback control.
    }
  }

  const cancelActive = (reason: BargeInReason | 'replaced' | 'disabled'): void => {
    const was = active
    if (!was) return
    active = null
    try {
      was.playback?.cancel()
    } catch {
      // The child is already gone.
    }
    audit({ phase: 'cancelled', reason })
  }

  const bargeIn = (reason: BargeInReason): number => {
    generation += 1
    previewGeneration += 1
    currentReplyAskId = null
    cancelActive(reason)
    emit()
    return generation
  }

  const approvedVoices = (): Promise<TtsVoice[]> => {
    const adapter = deps.adapter
    if (!adapter) return Promise.resolve([])
    if (voiceCache && now() - voiceCache.at < VOICE_LIST_TTL_MS) return Promise.resolve(voiceCache.voices)
    if (voiceLoad) return voiceLoad
    voiceLoad = adapter
      .listVoices()
      .then((raw) => {
        if (raw === null) {
          engineFailed = true
          voiceCache = null
          emit()
          return []
        }
        const voices = approveVoices(platform, raw)
        voiceCache = { at: now(), voices }
        if (voices.length === 0) {
          engineFailed = true
          emit()
        }
        return voices
      })
      .catch(() => {
        engineFailed = true
        emit()
        return []
      })
      .finally(() => {
        voiceLoad = null
      })
    return voiceLoad
  }

  const begin = (kind: 'reply' | 'preview', text: string, voiceId: string, rate: number): void => {
    const adapter = deps.adapter
    if (!adapter) return
    cancelActive('replaced')
    const entry: ActivePlayback = { kind, playback: null }
    active = entry
    entry.playback = adapter.speak(
      { text, voiceId, rate },
      {
        onStarted() {
          if (active === entry) audit({ phase: 'started' })
        },
        onEnded(reason) {
          if (active !== entry) return
          active = null
          audit({ phase: 'ended', reason })
          emit()
        },
        onFailed(code) {
          if (active !== entry) return
          active = null
          if (code !== 'no_voice') engineFailed = true
          audit({ phase: 'failed', reason: code })
          emit()
        }
      }
    )
    emit()
  }

  const speakReply = async (text: string, replyGeneration: number): Promise<SpeakOutcome> => {
    if (disposed) return 'unavailable'
    if (replyGeneration !== generation) {
      audit({ phase: 'dropped', reason: 'stale' })
      return 'stale'
    }
    const chosen = settings()
    if (!chosen.speakReplies) return 'off'
    if (!available()) return 'unavailable'
    if (deps.meetingLive()) return 'meeting'
    const spoken = toSpokenText(text)
    if (!spoken) return 'empty'
    const voices = await approvedVoices()
    if (disposed || replyGeneration !== generation) {
      audit({ phase: 'dropped', reason: 'stale' })
      return 'stale'
    }
    if (!settings().speakReplies) return 'off'
    if (!available() || deps.meetingLive()) return available() ? 'meeting' : 'unavailable'
    const voiceId = resolveVoiceChoice(voices, chosen.voiceId)
    if (voiceId === null) {
      audit({ phase: 'failed', reason: 'no_voice' })
      return 'unavailable'
    }
    begin('reply', spoken, voiceId, clampSpeechRate(chosen.rate))
    return 'spoken'
  }

  const objectText = (payload: unknown): string | null => {
    if (payload === null || typeof payload !== 'object') return null
    const text = (payload as { text?: unknown }).text
    return typeof text === 'string' ? text : null
  }

  const observeAsk = (event: AskObservation): void => {
    if (disposed) return
    if (event.type === 'begin') {
      if (!SPOKEN_ASK_MODES.has(event.mode)) return
      const replyGeneration = bargeIn('typed-ask')
      currentReplyAskId = event.id
      pending.set(event.id, { generation: replyGeneration, text: '' })
      for (const oldest of pending.keys()) {
        if (pending.size <= MAX_PENDING_REPLIES) break
        pending.delete(oldest)
      }
      return
    }
    if (event.type === 'cancel') {
      pending.delete(event.id)
      if (currentReplyAskId === event.id) bargeIn('stop')
      return
    }
    const entry = pending.get(event.id)
    if (!entry) return
    if (event.channel === IPC.streamDelta) {
      const text = objectText(event.payload)
      if (text !== null && entry.text.length < MAX_COLLECTED_CHARS) entry.text += text
    } else if (event.channel === IPC.streamError) {
      pending.delete(event.id)
      if (currentReplyAskId === event.id) currentReplyAskId = null
    } else if (event.channel === IPC.streamDone) {
      pending.delete(event.id)
      void speakReply(entry.text, entry.generation).catch(() => undefined)
    }
  }

  return {
    bargeIn,
    observeAsk,
    speakReply,
    async preview(request) {
      if (disposed || !available()) return { ok: false, reason: 'unavailable' }
      bargeIn('preview')
      const previewFence = previewGeneration
      if (deps.meetingLive()) return { ok: false, reason: 'meeting' }
      const chosen = settings()
      const wanted = request.voiceId === undefined ? chosen.voiceId : request.voiceId
      const voices = await approvedVoices()
      if (disposed || previewFence !== previewGeneration) return { ok: false, reason: 'interrupted' }
      if (!available()) return { ok: false, reason: 'unavailable' }
      if (deps.meetingLive()) return { ok: false, reason: 'meeting' }
      const voiceId = resolveVoiceChoice(voices, wanted)
      if (voiceId === null) return { ok: false, reason: 'unavailable' }
      begin('preview', SPOKEN_REPLIES_PREVIEW_TEXT, voiceId, clampSpeechRate(request.rate ?? chosen.rate))
      return { ok: true }
    },
    stop() {
      bargeIn('stop')
    },
    listVoices: approvedVoices,
    snapshot,
    refresh() {
      // Polls call this often. A failed engine gets another chance only when the person changes the settings.
      const key = JSON.stringify(settings())
      if (key !== settingsKey) {
        const enabled = settings().speakReplies
        engineFailed = false
        voiceCache = null
        settingsKey = key
        if (repliesEnabled && !enabled) {
          generation += 1
          if (active?.kind === 'reply') cancelActive('disabled')
        }
        repliesEnabled = enabled
      }
      emit()
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      currentReplyAskId = null
      pending.clear()
      cancelActive('quit')
      emit()
    }
  }
}
