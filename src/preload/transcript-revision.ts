import type { IpcRenderer } from 'electron'
import {
  TRANSCRIPT_REVISION_IPC,
  TRANSCRIPT_REVISION_MAX_SUBSCRIPTIONS,
  TranscriptRevisionDeltaSchema,
  type TranscriptRevisionDelta
} from '../shared/transcript-revision-ipc'

const MAX_TRACKED_MEETINGS = 16

export function createTranscriptRevisionPreloadApi(ipc: Pick<IpcRenderer, 'on' | 'removeListener'>): {
  onTranscriptRevision(cb: (delta: TranscriptRevisionDelta) => void): () => void
} {
  let active = 0
  return {
    onTranscriptRevision(cb) {
      if (active >= TRANSCRIPT_REVISION_MAX_SUBSCRIPTIONS) return () => {}
      const lastSeen = new Map<number, number>()
      const listener = (_event: unknown, payload: unknown): void => {
        const parsed = TranscriptRevisionDeltaSchema.safeParse(payload)
        if (!parsed.success) return
        const delta = parsed.data
        const prev = lastSeen.get(delta.meetingStartedAt)
        if (prev !== undefined && delta.revision <= prev) return
        lastSeen.delete(delta.meetingStartedAt)
        lastSeen.set(delta.meetingStartedAt, delta.revision)
        if (lastSeen.size > MAX_TRACKED_MEETINGS) {
          const oldest = lastSeen.keys().next()
          if (!oldest.done) lastSeen.delete(oldest.value)
        }
        try {
          cb(delta)
        } catch {
          // A throwing subscriber must not break the bridge.
        }
      }
      ipc.on(TRANSCRIPT_REVISION_IPC.revision, listener)
      active += 1
      let done = false
      return () => {
        if (done) return
        done = true
        ipc.removeListener(TRANSCRIPT_REVISION_IPC.revision, listener)
        active -= 1
      }
    }
  }
}
