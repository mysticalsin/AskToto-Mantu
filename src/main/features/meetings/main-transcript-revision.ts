import type { CloudSpeechEvent } from '@shared/cloud-speech'
import { auditLog } from '../../logger'
import { createRelayRevisionTap, type RevisionTapDeps, type RevisionTapOwner } from './relay-revision-adapter'
import { createTranscriptRevisionStore, type TranscriptRevisionStore } from './transcript-revision-store'

export function createMainTranscriptRevision(resolveOwner: RevisionTapDeps['resolveOwner']): {
  store: TranscriptRevisionStore
  onSegmentDelivered: (owner: RevisionTapOwner, event: CloudSpeechEvent) => void
} {
  const store = createTranscriptRevisionStore({ audit: (event, detail) => auditLog(event, detail) })
  const onSegmentDelivered = createRelayRevisionTap({ store, ...(resolveOwner ? { resolveOwner } : {}) })
  return { store, onSegmentDelivered }
}
