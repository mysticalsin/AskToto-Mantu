/**
 * translation-channel.ts — the per-meeting live translation state machine (Métis 2.12 G73).
 *
 * A translation is bound to `(utteranceId, revision)`. The channel translates each applied final once, pushes the result
 * only if that revision is still the latest final when the model answers, withdraws a delivered translation when its
 * line is corrected or retracted, and never touches the original transcript. Pure: the model call, the settings read and
 * the pushes are injected. Logs are codes only; meeting text never reaches `log`.
 */
import type {
  LiveTranslationTarget,
  TranslationReset,
  TranslationRetract,
  TranslationSegment,
  TranslationStatus
} from '@shared/live-translation'

export const TRANSLATION_MAX_PENDING = 32
const MAX_TRACKED_UTTERANCES = 4_096

export type TranslationLogCode = 'translation.unavailable' | 'translation.failed' | 'translation.stale_dropped'

export interface TranslationFrame {
  readonly processId: number
  readonly routingId: number
}

export interface TranslationScope {
  readonly tenantId: string
  readonly userId: string
  readonly sessionId: string
}

export interface TranslationUtterance {
  scope: TranslationScope
  utteranceId: string
  revision: number
  state: 'final' | 'retracted'
  text: string
  lang?: string
}

export type ActiveTranslationTarget = Exclude<LiveTranslationTarget, 'off'>

export interface TranslateRequest {
  utteranceId: string
  revision: number
  text: string
  lang?: string
  target: ActiveTranslationTarget
}

export type TranslateOutcome =
  | { kind: 'ok'; text: string; lowConfidence: boolean }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed' }

export interface TranslationPush {
  segment(frame: TranslationFrame, payload: TranslationSegment): void
  retract(frame: TranslationFrame, payload: TranslationRetract): void
  reset(frame: TranslationFrame, payload: TranslationReset): void
  status(frame: TranslationFrame, payload: TranslationStatus): void
}

export interface TranslationChannelDeps {
  /** The user's chosen target, read on every event so a change takes effect on the next final. */
  readTarget(): LiveTranslationTarget
  translate(request: TranslateRequest, signal: AbortSignal): Promise<TranslateOutcome>
  push: TranslationPush
  /** A code only. Never source text, translated text, prompts or model output. */
  log(code: TranslationLogCode): void
}

export interface TranslationChannels {
  onUtterance(frame: TranslationFrame, meetingStartedAt: number, utterance: TranslationUtterance): void
  closeMeeting(meetingStartedAt: number): void
  closeFrame(frameOwner: string): void
  closeAll(): void
}

interface Job {
  utteranceId: string
  revision: number
  text: string
  lang?: string
  epoch: number
}

interface Channel {
  readonly frame: TranslationFrame
  readonly startedAt: number
  readonly scope: TranslationScope
  target: LiveTranslationTarget
  epoch: number
  closed: boolean
  unavailableNotified: boolean
  readonly latest: Map<string, { revision: number; state: 'final' | 'retracted' }>
  readonly delivered: Map<string, number>
  readonly pending: Map<string, Job>
  inFlight: AbortController | null
}

const sameScope = (a: TranslationScope, b: TranslationScope): boolean =>
  a.tenantId === b.tenantId && a.userId === b.userId && a.sessionId === b.sessionId

function bound<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_TRACKED_UTTERANCES) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

export function createTranslationChannels(deps: TranslationChannelDeps): TranslationChannels {
  const channels = new Map<number, Channel>()

  const safe = (fn: () => void): void => {
    try {
      fn()
    } catch {
      // a dead window or a throwing sink never reaches the transcript path
    }
  }

  const close = (channel: Channel): void => {
    if (channel.closed) return
    channel.closed = true
    channel.inFlight?.abort()
    channel.inFlight = null
    channel.pending.clear()
    channel.latest.clear()
    channel.delivered.clear()
    if (channels.get(channel.startedAt) === channel) channels.delete(channel.startedAt)
  }

  const withdraw = (channel: Channel, utteranceId: string): void => {
    if (!channel.delivered.has(utteranceId)) return
    channel.delivered.delete(utteranceId)
    safe(() => deps.push.retract(channel.frame, { meetingStartedAt: channel.startedAt, utteranceIds: [utteranceId] }))
  }

  const accept = (channel: Channel, job: Job, outcome: TranslateOutcome): void => {
    if (channel.closed) return
    const latest = channel.latest.get(job.utteranceId)
    if (job.epoch !== channel.epoch || latest?.revision !== job.revision || latest.state !== 'final') {
      deps.log('translation.stale_dropped')
      return
    }
    if (outcome.kind === 'ok') {
      const target = channel.target
      if (target === 'off') return
      bound(channel.delivered, job.utteranceId, job.revision)
      safe(() =>
        deps.push.segment(channel.frame, {
          meetingStartedAt: channel.startedAt,
          utteranceId: job.utteranceId,
          revision: job.revision,
          target,
          text: outcome.text,
          lowConfidence: outcome.lowConfidence
        })
      )
      return
    }
    if (outcome.kind === 'unavailable') {
      deps.log('translation.unavailable')
      if (channel.unavailableNotified) return
      channel.unavailableNotified = true
      safe(() =>
        deps.push.status(channel.frame, {
          meetingStartedAt: channel.startedAt,
          state: 'unavailable',
          message: outcome.message.slice(0, 300)
        })
      )
      return
    }
    deps.log('translation.failed')
  }

  const pump = (channel: Channel): void => {
    if (channel.closed || channel.inFlight || channel.target === 'off') return
    const next = channel.pending.entries().next()
    if (next.done) return
    const [id, job] = next.value
    channel.pending.delete(id)
    if (job.epoch !== channel.epoch) {
      pump(channel)
      return
    }
    const controller = new AbortController()
    channel.inFlight = controller
    const target = channel.target
    let call: Promise<TranslateOutcome>
    try {
      call = deps.translate(
        { utteranceId: job.utteranceId, revision: job.revision, text: job.text, lang: job.lang, target },
        controller.signal
      )
    } catch {
      call = Promise.resolve({ kind: 'failed' })
    }
    void call
      .catch((): TranslateOutcome => ({ kind: 'failed' }))
      .then((outcome) => {
        if (channel.inFlight === controller) channel.inFlight = null
        accept(channel, job, outcome)
        pump(channel)
      })
  }

  const syncTarget = (channel: Channel, target: LiveTranslationTarget): void => {
    if (channel.target === target) return
    channel.target = target
    channel.epoch += 1
    channel.unavailableNotified = false
    channel.inFlight?.abort()
    channel.inFlight = null
    channel.pending.clear()
    channel.delivered.clear()
    safe(() => deps.push.reset(channel.frame, { meetingStartedAt: channel.startedAt, target }))
  }

  return {
    onUtterance(frame, meetingStartedAt, utterance) {
      const target = deps.readTarget()
      let channel = channels.get(meetingStartedAt)
      if (!channel) {
        if (target === 'off') return
        channel = {
          frame: { processId: frame.processId, routingId: frame.routingId },
          startedAt: meetingStartedAt,
          scope: utterance.scope,
          target,
          epoch: 1,
          closed: false,
          unavailableNotified: false,
          latest: new Map(),
          delivered: new Map(),
          pending: new Map(),
          inFlight: null
        }
        channels.set(meetingStartedAt, channel)
      } else if (!sameScope(channel.scope, utterance.scope)) {
        return
      }
      syncTarget(channel, target)
      const id = utterance.utteranceId
      const known = channel.latest.get(id)
      if (utterance.state === 'final') {
        if (known && known.revision >= utterance.revision) return
        bound(channel.latest, id, { revision: utterance.revision, state: 'final' })
        withdraw(channel, id)
        if (channel.target === 'off') return
        channel.pending.delete(id)
        channel.pending.set(id, {
          utteranceId: id,
          revision: utterance.revision,
          text: utterance.text,
          lang: utterance.lang,
          epoch: channel.epoch
        })
        while (channel.pending.size > TRANSLATION_MAX_PENDING) {
          const oldest = channel.pending.keys().next()
          if (oldest.done) break
          channel.pending.delete(oldest.value)
        }
        pump(channel)
        return
      }
      if (known && known.revision >= utterance.revision && known.state === 'retracted') return
      bound(channel.latest, id, { revision: utterance.revision, state: 'retracted' })
      channel.pending.delete(id)
      withdraw(channel, id)
    },

    closeMeeting(meetingStartedAt) {
      const channel = channels.get(meetingStartedAt)
      if (channel) close(channel)
    },

    closeFrame(frameOwner) {
      for (const channel of [...channels.values()]) {
        if (`${channel.frame.processId}:${channel.frame.routingId}` === frameOwner) close(channel)
      }
    },

    closeAll() {
      for (const channel of [...channels.values()]) close(channel)
    }
  }
}
