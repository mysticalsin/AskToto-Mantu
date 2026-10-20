import { TRANSCRIPT_REVISION_IPC, TranscriptRevisionDeltaSchema } from '@shared/transcript-revision-ipc'
import type { TranscriptRevisionStore } from '../features/meetings/transcript-revision-store'

export interface TranscriptRevisionPushFrame {
  readonly parent: unknown
  isDestroyed?(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface TranscriptRevisionPushDeps {
  store: Pick<TranscriptRevisionStore, 'onChange' | 'bindingOf'>
  frameFor(processId: number, routingId: number): TranscriptRevisionPushFrame | null | undefined
}

const DIGITS = /^\d+$/

function parseFrameOwner(frameOwner: string): { processId: number; routingId: number } | null {
  const parts = frameOwner.split(':')
  if (parts.length !== 2) return null
  const [p, r] = parts
  if (!DIGITS.test(p ?? '') || !DIGITS.test(r ?? '')) return null
  const processId = Number(p)
  const routingId = Number(r)
  if (!Number.isSafeInteger(processId) || !Number.isSafeInteger(routingId)) return null
  return { processId, routingId }
}

/**
 * Pushes transcript revision deltas only to the top frame bound to the meeting. Never broadcasts and never
 * looks up any frame other than the bound one. Content-free: nothing is logged.
 */
export function registerTranscriptRevisionPush(deps: TranscriptRevisionPushDeps): () => void {
  return deps.store.onChange((delta) => {
    try {
      const binding = deps.store.bindingOf(delta.meetingStartedAt)
      if (!binding) return
      const target = parseFrameOwner(binding.frameOwner)
      if (!target) return
      let frame: TranscriptRevisionPushFrame | null | undefined
      try {
        frame = deps.frameFor(target.processId, target.routingId)
      } catch {
        return
      }
      if (!frame) return
      if (frame.isDestroyed?.() === true) return
      if (frame.parent !== null && frame.parent !== undefined) return
      const parsed = TranscriptRevisionDeltaSchema.safeParse(delta)
      if (!parsed.success) return
      try {
        frame.send(TRANSCRIPT_REVISION_IPC.revision, parsed.data)
      } catch {
        // A dead or detached frame must never break the store.
      }
    } catch {
      // The listener never throws back into the store.
    }
  })
}
