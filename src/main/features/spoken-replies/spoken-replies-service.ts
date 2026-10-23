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
export type ReplyLifecycleOutcome =
  | 'finished'
  | 'off'
  | 'unavailable'
  | 'meeting'
  | 'empty'
  | 'failed'
  | 'cancelled'
  | 'superseded'
export type ReplyLifecycleEvent =
  | { readonly phase: 'pending' | 'started'; readonly askId: string; readonly generation: number }
  | {
      readonly phase: 'settled'
      readonly askId: string
      readonly generation: number
      readonly outcome: ReplyLifecycleOutcome
    }
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
  /** Main-process observer used to bind playback to the Ask and conversation that produced it. */
  onReplyLifecycle?(event: ReplyLifecycleEvent): void
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
  cancelRequested: boolean
  started: boolean
  readonly reply: ReplyRecord | null
}

interface ReplyRecord {
  readonly askId: string
  readonly generation: number
  text: string
  stage: 'collecting' | 'preparing' | 'playing'
  settled: boolean
  started: boolean
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
  let currentReply: ReplyRecord | null = null
  const pending = new Map<string, ReplyRecord>()
  const lifecycleQueue: ReplyLifecycleEvent[] = []
  let lifecycleBatchDepth = 0
  let drainingLifecycle = false
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

  const drainLifecycle = (): void => {
    if (drainingLifecycle || lifecycleBatchDepth > 0) return
    drainingLifecycle = true
    try {
      while (lifecycleQueue.length > 0) {
        const event = lifecycleQueue.shift()
        if (!event) continue
        try {
          deps.onReplyLifecycle?.(event)
        } catch {
          // Lifecycle observers cannot change Ask delivery or playback.
        }
      }
    } finally {
      drainingLifecycle = false
    }
  }

  const notifyLifecycle = (event: ReplyLifecycleEvent): void => {
    lifecycleQueue.push(event)
    drainLifecycle()
  }

  const withLifecycleBatch = (operation: () => void): void => {
    lifecycleBatchDepth += 1
    try {
      operation()
    } finally {
      lifecycleBatchDepth -= 1
      drainLifecycle()
    }
  }

  const detachReply = (reply: ReplyRecord, outcome: ReplyLifecycleOutcome): boolean => {
    if (reply.settled) return false
    reply.settled = true
    if (pending.get(reply.askId) === reply) pending.delete(reply.askId)
    if (currentReply === reply) currentReply = null
    notifyLifecycle({ phase: 'settled', askId: reply.askId, generation: reply.generation, outcome })
    return true
  }

  const settleAllReplies = (outcome: ReplyLifecycleOutcome): ReplyRecord[] => {
    const records = [...pending.values()]
    for (const reply of records) {
      reply.settled = true
      if (pending.get(reply.askId) === reply) pending.delete(reply.askId)
      if (currentReply === reply) currentReply = null
      notifyLifecycle({ phase: 'settled', askId: reply.askId, generation: reply.generation, outcome })
    }
    currentReply = null
    return records
  }

  const cancelActive = (reason: BargeInReason | 'replaced' | 'disabled'): void => {
    const was = active
    if (!was) return
    active = null
    was.cancelRequested = true
    try {
      was.playback?.cancel()
    } catch {
      // The child is already gone.
    }
    audit({ phase: 'cancelled', reason })
  }

  const bargeIn = (reason: BargeInReason): number => {
    withLifecycleBatch(() => {
      generation += 1
      previewGeneration += 1
      const settled = settleAllReplies('cancelled')
      cancelActive(reason)
      for (const reply of settled) {
        if (reply.stage !== 'playing') audit({ phase: 'dropped', reason: 'stale' })
      }
      emit()
    })
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

  const begin = (
    kind: 'reply' | 'preview',
    text: string,
    voiceId: string,
    rate: number,
    reply: ReplyRecord | null = null,
    previewFence: number | null = null
  ): boolean => {
    const adapter = deps.adapter
    if (!adapter) return false
    if (kind === 'preview' && (disposed || previewFence !== previewGeneration)) return false
    cancelActive('replaced')
    if (kind === 'preview' && (disposed || previewFence !== previewGeneration)) return false
    if (reply && (reply.settled || pending.get(reply.askId) !== reply || generation !== reply.generation)) return false
    const entry: ActivePlayback = { kind, playback: null, cancelRequested: false, started: false, reply }
    active = entry
    if (reply) reply.stage = 'playing'
    let playback: TtsPlayback
    try {
      playback = adapter.speak(
        { text, voiceId, rate },
        {
          onStarted() {
            if (active !== entry || entry.started) return
            entry.started = true
            if (reply && !reply.settled && !reply.started) {
              reply.started = true
              notifyLifecycle({ phase: 'started', askId: reply.askId, generation: reply.generation })
            }
            audit({ phase: 'started' })
          },
          onEnded(reason) {
            if (active !== entry) return
            active = null
            if (reply) detachReply(reply, reason === 'finished' ? 'finished' : 'cancelled')
            audit({ phase: 'ended', reason })
            emit()
          },
          onFailed(code) {
            if (active !== entry) return
            active = null
            if (code !== 'no_voice') engineFailed = true
            if (reply) detachReply(reply, code === 'no_voice' ? 'unavailable' : 'failed')
            audit({ phase: 'failed', reason: code })
            emit()
          }
        }
      )
    } catch {
      if (active === entry) {
        active = null
        engineFailed = true
        if (reply) detachReply(reply, 'failed')
        audit({ phase: 'failed', reason: 'spawn' })
        emit()
      }
      return false
    }
    if (entry.cancelRequested) {
      try {
        playback.cancel()
      } catch {
        // The child is already gone.
      }
    } else if (active === entry) {
      entry.playback = playback
    }
    emit()
    return true
  }

  const speakReply = async (
    text: string,
    replyGeneration: number,
    reply: ReplyRecord | null = null
  ): Promise<SpeakOutcome> => {
    const settleOutcome = (outcome: SpeakOutcome): void => {
      if (!reply) return
      if (outcome === 'stale') detachReply(reply, 'cancelled')
      else if (outcome !== 'spoken') detachReply(reply, outcome)
    }
    const current = (): boolean => !reply || (!reply.settled && pending.get(reply.askId) === reply)
    if (disposed) return 'unavailable'
    if (!current()) {
      settleOutcome('stale')
      return 'stale'
    }
    if (replyGeneration !== generation) {
      audit({ phase: 'dropped', reason: 'stale' })
      settleOutcome('stale')
      return 'stale'
    }
    const chosen = settings()
    if (!chosen.speakReplies) {
      settleOutcome('off')
      return 'off'
    }
    if (!available()) {
      settleOutcome('unavailable')
      return 'unavailable'
    }
    if (deps.meetingLive()) {
      settleOutcome('meeting')
      return 'meeting'
    }
    const spoken = toSpokenText(text)
    if (!spoken) {
      settleOutcome('empty')
      return 'empty'
    }
    const voices = await approvedVoices()
    if (disposed || replyGeneration !== generation || !current()) {
      audit({ phase: 'dropped', reason: 'stale' })
      settleOutcome('stale')
      return 'stale'
    }
    if (!settings().speakReplies) {
      settleOutcome('off')
      return 'off'
    }
    if (!available() || deps.meetingLive()) {
      const outcome = available() ? 'meeting' : 'unavailable'
      settleOutcome(outcome)
      return outcome
    }
    const voiceId = resolveVoiceChoice(voices, chosen.voiceId)
    if (voiceId === null) {
      audit({ phase: 'failed', reason: 'no_voice' })
      settleOutcome('unavailable')
      return 'unavailable'
    }
    begin('reply', spoken, voiceId, clampSpeechRate(chosen.rate), reply)
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
      withLifecycleBatch(() => {
        generation += 1
        previewGeneration += 1
        const superseded = settleAllReplies('superseded')
        const reply: ReplyRecord = {
          askId: event.id,
          generation,
          text: '',
          stage: 'collecting',
          settled: false,
          started: false
        }
        pending.set(event.id, reply)
        currentReply = reply
        notifyLifecycle({ phase: 'pending', askId: reply.askId, generation: reply.generation })
        for (const previous of superseded) {
          if (previous.stage !== 'playing') audit({ phase: 'dropped', reason: 'stale' })
        }
        cancelActive('typed-ask')
        emit()
      })
      return
    }
    if (event.type === 'cancel') {
      const reply = pending.get(event.id)
      if (reply && currentReply === reply) bargeIn('stop')
      else if (reply) detachReply(reply, 'cancelled')
      return
    }
    const entry = pending.get(event.id)
    if (!entry || entry.stage !== 'collecting') return
    if (event.channel === IPC.streamDelta) {
      const text = objectText(event.payload)
      if (text !== null && entry.text.length < MAX_COLLECTED_CHARS) entry.text += text
    } else if (event.channel === IPC.streamError) {
      detachReply(entry, 'failed')
    } else if (event.channel === IPC.streamDone) {
      entry.stage = 'preparing'
      void speakReply(entry.text, entry.generation, entry).catch(() => detachReply(entry, 'failed'))
    }
  }

  return {
    bargeIn,
    observeAsk,
    speakReply,
    async preview(request) {
      if (disposed || !available()) return { ok: false, reason: 'unavailable' }
      const previewFence = previewGeneration + 1
      bargeIn('preview')
      if (disposed || previewFence !== previewGeneration) return { ok: false, reason: 'interrupted' }
      if (deps.meetingLive()) return { ok: false, reason: 'meeting' }
      const chosen = settings()
      const wanted = request.voiceId === undefined ? chosen.voiceId : request.voiceId
      const voices = await approvedVoices()
      if (disposed || previewFence !== previewGeneration) return { ok: false, reason: 'interrupted' }
      if (!available()) return { ok: false, reason: 'unavailable' }
      if (deps.meetingLive()) return { ok: false, reason: 'meeting' }
      const voiceId = resolveVoiceChoice(voices, wanted)
      if (voiceId === null) return { ok: false, reason: 'unavailable' }
      if (disposed || previewFence !== previewGeneration) return { ok: false, reason: 'interrupted' }
      if (
        !begin(
          'preview',
          SPOKEN_REPLIES_PREVIEW_TEXT,
          voiceId,
          clampSpeechRate(request.rate ?? chosen.rate),
          null,
          previewFence
        )
      ) {
        return { ok: false, reason: 'interrupted' }
      }
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
        const wasEnabled = repliesEnabled
        engineFailed = false
        voiceCache = null
        settingsKey = key
        repliesEnabled = enabled
        if (wasEnabled && !enabled) {
          withLifecycleBatch(() => {
            generation += 1
            settleAllReplies('off')
            if (active?.kind === 'reply') cancelActive('disabled')
            emit()
          })
        }
      }
      emit()
    },
    dispose() {
      if (disposed) return
      withLifecycleBatch(() => {
        disposed = true
        generation += 1
        previewGeneration += 1
        settleAllReplies('cancelled')
        cancelActive('quit')
        emit()
      })
    }
  }
}
