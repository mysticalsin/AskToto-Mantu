import type { CloudSpeechEvent } from '@shared/cloud-speech'
import { webFrameMain } from 'electron'
import { registerTranscriptRevisionPush } from '../../ipc/register-transcript-revision'
import { auditLog } from '../../logger'
import { createRelayRevisionTap, type RevisionTapDeps, type RevisionTapOwner } from './relay-revision-adapter'
import { writeTranscriptCheckpoint } from './transcript-checkpoint-main'
import { createTranscriptRevisionStore, type TranscriptRevisionStore } from './transcript-revision-store'

export function createMainTranscriptRevision(
  resolveOwner: RevisionTapDeps['resolveOwner'],
  authGeneration?: () => number
): {
  store: TranscriptRevisionStore
  onSegmentDelivered: (owner: RevisionTapOwner, event: CloudSpeechEvent) => void
} {
  const store = createTranscriptRevisionStore({
    audit: (event, detail) => auditLog(event, detail),
    checkpointWriter: writeTranscriptCheckpoint,
    ...(authGeneration ? { authGeneration } : {})
  })
  registerTranscriptRevisionPush({
    store,
    frameFor: (processId, routingId) => webFrameMain.fromId(processId, routingId) ?? null
  })
  const onSegmentDelivered = createRelayRevisionTap({ store, ...(resolveOwner ? { resolveOwner } : {}) })
  return { store, onSegmentDelivered }
}
