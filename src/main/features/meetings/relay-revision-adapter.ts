import type { CloudSpeechEvent } from '@shared/cloud-speech'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import type { RevisionEvent } from '@shared/contracts/speech/transcript-revision'
import type { FrameOwner, TranscriptRevisionStore, TranscriptStoreBinding } from './transcript-revision-store'

export type DeliveredSegmentEvent = Extract<CloudSpeechEvent, { type: 'segment' }>

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
  return {
    kind: event.segment.final ? 'provider-final' : 'provider-partial',
    relaySessionId: `${event.captureId}/${event.captureGeneration.toString(36)}/${event.segment.stream.epoch.toString(36)}`,
    providerSeq: event.sequence,
    providerSegmentIndex: event.segment.index,
    channel: event.segment.stream.track === 'microphone' ? 'mic' : 'system',
    text: event.segment.text,
    language: event.languages?.[0] ?? fallbackLanguage,
    startMs: event.segment.startMs,
    endMs: event.segment.endMs
  }
}

export interface RevisionTapOwner {
  readonly captureId: string
  readonly generation: number
  readonly binding: { readonly processId: number; readonly routingId: number; readonly frame: object }
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
    return deps.store.open(binding).ok ? binding : null
  }

  return (owner, event) => {
    try {
      if (event.type !== 'segment') return
      if (owner.captureContext === null) return
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
