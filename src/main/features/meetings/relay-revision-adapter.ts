import type { CloudSpeechEvent } from '@shared/cloud-speech'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import type { RevisionEvent } from '@shared/contracts/speech/transcript-revision'
import type { FrameOwner, TranscriptRevisionStore, TranscriptStoreBinding } from './transcript-revision-store'

export type DeliveredSegmentEvent = Extract<CloudSpeechEvent, { type: 'segment' }>

/**
 * Maps a segment event that was already delivered to the renderer. Times are already rebased to capture time.
 * The lineage is per capture owner and stream epoch because the event `sequence` frontier is per track and epoch.
 */
export function segmentEventToRevisionEvent(
  event: DeliveredSegmentEvent
): Extract<RevisionEvent, { kind: 'provider-partial' | 'provider-final' }> {
  return {
    kind: event.segment.final ? 'provider-final' : 'provider-partial',
    relaySessionId: `${event.captureId}/${event.captureGeneration.toString(36)}/${event.segment.stream.epoch.toString(36)}`,
    providerSeq: event.sequence,
    channel: event.segment.stream.track === 'microphone' ? 'mic' : 'system',
    text: event.segment.text,
    language: event.languages?.[0] ?? 'multi',
    startMs: event.segment.startMs,
    endMs: event.segment.endMs
  }
}

export interface RevisionTapOwner {
  readonly captureId: string
  readonly generation: number
  readonly binding: { readonly processId: number; readonly routingId: number; readonly frame: object }
  readonly captureContext: { readonly listenStartedAt: number } | null
}

export interface RevisionTapDeps {
  store: TranscriptRevisionStore
  resolveOwner?: (frame: { processId: number; routingId: number }) => OwnerSessionRef | null
}

export function createRelayRevisionTap(
  deps: RevisionTapDeps
): (owner: RevisionTapOwner, event: CloudSpeechEvent) => void {
  const bindings = new WeakMap<RevisionTapOwner, TranscriptStoreBinding | null>()

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
      let binding = bindings.get(owner)
      if (binding === undefined) {
        binding = bind(owner, owner.captureContext.listenStartedAt)
        bindings.set(owner, binding)
      }
      if (binding === null) return
      // Refusals are dropped: the renderer already has the event and the store is a parallel canonical record.
      deps.store.apply(binding, segmentEventToRevisionEvent(event))
    } catch {
      // the tap never throws into the delivery path
    }
  }
}
