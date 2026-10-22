import type { TranscriptLine } from '@shared/ipc'
import type { RecapPersistTarget } from './transcript'

/**
 * A meeting that is being left while Stop's drain may still be committing windows to it. Reset and New
 * meeting advance the live owner at once, so the deferred save must carry the old owner's identity, recap
 * target and a way to read what the drain committed, none of which the live refs hold any more.
 */
export interface RetiringMeeting {
  started: number
  target: RecapPersistTarget | null
  readLines: () => TranscriptLine[]
}

/**
 * What the retiring meeting saves once its drain has ended: the live read, but never fewer spoken lines than
 * were on screen when the user left. A fresh start may already have cleared the live read; the drain only
 * ever adds, so the click-time snapshot is the floor.
 */
export function drainedLines(floor: TranscriptLine[], live: TranscriptLine[]): TranscriptLine[] {
  const spoken = (lines: TranscriptLine[]): TranscriptLine[] => lines.filter((line) => !line.provisional)
  const read = spoken(live)
  const before = spoken(floor)
  return read.length >= before.length ? read : before
}

export function retiringMeeting(
  started: number,
  target: RecapPersistTarget | null,
  floor: TranscriptLine[],
  readLive: () => TranscriptLine[]
): RetiringMeeting {
  return { started, target, readLines: () => drainedLines(floor, readLive()) }
}
