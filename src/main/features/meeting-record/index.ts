/** Public surface of the structured meeting record (G78). Other modules reach it only through this file. */
import { join } from 'node:path'
import { UNAVAILABLE_RECORD, type MeetingRecord, type MeetingRecordEdit } from '@shared/meeting-record'
import type { TranscriptLine } from '@shared/transcript-line'
import { safeMeetingBasename } from '../../meeting-path'
import { buildMeetingRecord } from './build-record'
import { applyRecordEdit, readRecordEdits, removeRecordEdits, type RecordEditsDeps } from './record-edits-store'

export { buildMeetingRecord, emptyRecordEdits, type RecordEdits } from './build-record'
export { removeRecordEdits, type RecordEditsDeps } from './record-edits-store'

export interface MeetingRecordSource {
  ok: boolean
  recap?: string
  lines?: TranscriptLine[]
  startedAt?: number
}

export interface MeetingRecordServiceDeps {
  /** The one meeting reader (`recallRead`): no new file parsing happens here. */
  readMeeting(file: string): Promise<MeetingRecordSource>
  folder(): string
  encrypt(): boolean
  store: RecordEditsDeps
  /** Serialises read-modify-write per meeting (`withMeetingMutation`). */
  serialize<T>(path: string, work: () => Promise<T>): Promise<T>
}

export interface MeetingRecordService {
  get(file: string): Promise<MeetingRecord>
  edit(file: string, op: MeetingRecordEdit): Promise<boolean>
}

export function createMeetingRecordService(deps: MeetingRecordServiceDeps): MeetingRecordService {
  return {
    async get(file) {
      const safeName = safeMeetingBasename(file)
      if (!safeName) return UNAVAILABLE_RECORD
      const meeting = await deps.readMeeting(safeName)
      if (!meeting.ok) return UNAVAILABLE_RECORD
      const edits = await readRecordEdits(deps.store, deps.folder(), safeName)
      return buildMeetingRecord(meeting.recap ?? '', meeting.lines ?? [], edits, meeting.startedAt ?? null)
    },
    async edit(file, op) {
      const safeName = safeMeetingBasename(file)
      if (!safeName) return false
      const folder = deps.folder()
      // An edit for a meeting that cannot be read would leave an orphan sidecar behind.
      const meeting = await deps.readMeeting(safeName)
      if (!meeting.ok) return false
      return deps.serialize(join(folder, safeName), () =>
        applyRecordEdit(deps.store, folder, safeName, op, deps.encrypt())
      )
    }
  }
}

/** Delete the sidecar of a removed meeting. Never throws: the meeting delete is authoritative. */
export async function removeMeetingRecordEdits(deps: RecordEditsDeps, folder: string, safeName: string): Promise<void> {
  try {
    await removeRecordEdits(deps, folder, safeName)
  } catch {
    /* a leftover sidecar holds only the owner's own edits, under a hashed name */
  }
}
