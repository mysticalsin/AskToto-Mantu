import type { CloudSpeechEvent } from '@shared/cloud-speech'
import type { SpeechStreamRef } from '@shared/contracts/speech'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import type { RevisionEvent } from '@shared/contracts/speech/transcript-revision'
import { bindRendererResetClosure, type RendererResetSource } from './session-closure'
import type { FrameOwner, TranscriptRevisionStore, TranscriptStoreBinding } from './transcript-revision-store'

export type DeliveredSegmentEvent = Extract<CloudSpeechEvent, { type: 'segment' }>

/** The one lineage format: per capture owner and stream epoch, because the event `sequence` frontier is per both. */
export function streamEndLineage(
  captureId: string,
  captureGeneration: number,
  track: SpeechStreamRef['track'],
  epoch: number
): { relaySessionId: string; channel: 'mic' | 'system' } {
  return {
    relaySessionId: `${captureId}/${captureGeneration.toString(36)}/${epoch.toString(36)}`,
    channel: track === 'microphone' ? 'mic' : 'system'
  }
}

/**
 * Maps a segment event that was already delivered to the renderer. Times are already rebased to capture time.
 * The lineage is per capture owner and stream epoch because the event `sequence` frontier is per track and epoch.
 * An untagged segment is 'multi' and inherits the meeting's current language in the reducer.
 */
export function segmentEventToRevisionEvent(
  event: DeliveredSegmentEvent
): Extract<RevisionEvent, { kind: 'provider-partial' | 'provider-final' }> {
  return segmentEventWithFallbackLanguage(event, 'multi')
}

/**
 * Same mapping, but an untagged segment takes `fallbackLanguage` (the pinned session language when there is one).
 * Kept separate so the one-argument mapper stays safe to pass to `Array.prototype.map`.
 */
export function segmentEventWithFallbackLanguage(
  event: DeliveredSegmentEvent,
  fallbackLanguage: string
): Extract<RevisionEvent, { kind: 'provider-partial' | 'provider-final' }> {
  const { relaySessionId, channel } = streamEndLineage(
    event.captureId,
    event.captureGeneration,
    event.segment.stream.track,
    event.segment.stream.epoch
  )
  return {
    kind: event.segment.final ? 'provider-final' : 'provider-partial',
    relaySessionId,
    providerSeq: event.sequence,
    providerSegmentIndex: event.segment.index,
    channel,
    text: event.segment.text,
    language: event.languages?.[0] ?? fallbackLanguage,
    startMs: event.segment.startMs,
    endMs: event.segment.endMs
  }
}

export interface RevisionTapOwner {
  readonly captureId: string
  readonly generation: number
  readonly binding: {
    readonly processId: number
    readonly routingId: number
    readonly frame: object
    /** The owning renderer; when present its reset closes the meetings bound through it. */
    readonly sender?: RendererResetSource
  }
  readonly captureContext: { readonly listenStartedAt: number } | null
  /** The live relay session, when one is current; its language labels untagged segments. */
  readonly session?: { readonly identity: { readonly language: string } } | null
}

export interface RevisionTapDeps {
  store: TranscriptRevisionStore
  resolveOwner?: (frame: { processId: number; routingId: number }) => OwnerSessionRef | null
}

interface TapState {
  binding: TranscriptStoreBinding | null
  sessionLanguage: string | null
}

function concrete(language: string | null): language is string {
  return typeof language === 'string' && language !== 'multi' && language !== 'und' && language !== 'auto'
}

export function createRelayRevisionTap(
  deps: RevisionTapDeps
): (owner: RevisionTapOwner, event: CloudSpeechEvent) => void {
  const states = new WeakMap<RevisionTapOwner, TapState>()
  const attached = new WeakSet<RendererResetSource>()
  const meetingsBySender = new WeakMap<RendererResetSource, Set<number>>()

  const watchRenderer = (sender: RendererResetSource, meetingStartedAt: number): void => {
    try {
      let meetings = meetingsBySender.get(sender)
      if (meetings === undefined) {
        meetings = new Set<number>()
        meetingsBySender.set(sender, meetings)
      }
      meetings.add(meetingStartedAt)
      if (attached.has(sender)) return
      attached.add(sender)
      const owned = meetings
      bindRendererResetClosure(sender, () => {
        const ids = [...owned]
        owned.clear()
        for (const id of ids) deps.store.close(id, 'renderer-reset')
      })
    } catch {
      // listener work is best effort
    }
  }

  const bind = (owner: RevisionTapOwner, listenStartedAt: number): TranscriptStoreBinding | null => {
    const { processId, routingId } = owner.binding
    let ref: OwnerSessionRef | null = null
    try {
      ref = deps.resolveOwner?.({ processId, routingId }) ?? null
    } catch {
      ref = null
    }
    const frameOwner: FrameOwner = `${processId}:${routingId}`
    const binding: TranscriptStoreBinding = { meetingStartedAt: listenStartedAt, frameOwner, owner: ref }
    if (!deps.store.open(binding).ok) return null
    if (owner.binding.sender) watchRenderer(owner.binding.sender, listenStartedAt)
    return binding
  }

  // Non-segment events only settle an already open meeting; they never bind one.
  const settleStreams = (owner: RevisionTapOwner, event: CloudSpeechEvent): void => {
    const binding = states.get(owner)?.binding
    if (!binding) return
    if (event.type === 'terminal') {
      const lineage = streamEndLineage(event.captureId, event.captureGeneration, event.stream.track, event.stream.epoch)
      deps.store.apply(binding, { kind: 'stream-end', ...lineage })
      return
    }
    // Only an opened transition settles: a closed one can still be refused and the old epoch then continues.
    if (event.type === 'epoch-transition' && event.stage === 'opened') {
      for (const stream of event.streams) {
        const lineage = streamEndLineage(event.captureId, event.captureGeneration, stream.track, stream.previousEpoch)
        deps.store.apply(binding, { kind: 'stream-end', ...lineage })
      }
    }
  }

  return (owner, event) => {
    try {
      if (owner.captureContext === null) return
      if (event.type !== 'segment') {
        settleStreams(owner, event)
        return
      }
      let state = states.get(owner)
      if (state === undefined) {
        state = { binding: bind(owner, owner.captureContext.listenStartedAt), sessionLanguage: null }
        states.set(owner, state)
      }
      if (state.binding === null) return
      const sessionLanguage = owner.session?.identity.language ?? null
      const previous = state.sessionLanguage
      if (previous !== null && previous !== sessionLanguage && concrete(sessionLanguage)) {
        deps.store.apply(state.binding, {
          kind: 'language-change',
          language: sessionLanguage,
          atMs: event.segment.startMs,
          origin: 'user'
        })
      }
      state.sessionLanguage = sessionLanguage
      // Refusals are dropped: the renderer already has the event and the store is a parallel canonical record.
      deps.store.apply(
        state.binding,
        segmentEventWithFallbackLanguage(event, concrete(sessionLanguage) ? sessionLanguage : 'multi')
      )
    } catch {
      // the tap never throws into the delivery path
    }
  }
}
