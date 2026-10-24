import type { IpcRenderer } from 'electron'
import {
  MEETING_RECORD_IPC,
  MeetingRecordAckSchema,
  MeetingRecordSchema,
  UNAVAILABLE_RECORD,
  type MeetingRecord,
  type MeetingRecordAck,
  type MeetingRecordEdit
} from '../shared/meeting-record'

const REFUSED: MeetingRecordAck = { ok: false }

/** The structured meeting record bridge (G78). Every reply is validated here; a malformed one becomes a content-free fallback. */
export function createMeetingRecordPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  meetingRecord: {
    get(file: string): Promise<MeetingRecord>
    edit(op: MeetingRecordEdit): Promise<MeetingRecordAck>
  }
} {
  return {
    meetingRecord: {
      async get(file) {
        try {
          const parsed = MeetingRecordSchema.safeParse(await ipc.invoke(MEETING_RECORD_IPC.get, { file }))
          return parsed.success ? parsed.data : UNAVAILABLE_RECORD
        } catch {
          return UNAVAILABLE_RECORD
        }
      },
      async edit(op) {
        try {
          const parsed = MeetingRecordAckSchema.safeParse(await ipc.invoke(MEETING_RECORD_IPC.edit, op))
          return parsed.success ? parsed.data : REFUSED
        } catch {
          return REFUSED
        }
      }
    }
  }
}
