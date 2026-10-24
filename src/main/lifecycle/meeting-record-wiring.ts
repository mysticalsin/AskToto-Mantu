import type { IpcMain } from 'electron'
import { createMeetingRecordService, type MeetingRecordService } from '../features/meeting-record'
import { defaultRecordEditsDeps } from '../features/meeting-record/default-deps'
import { withMeetingMutation } from '../infra/storage/meeting-mutation-lane'
import { registerMeetingRecordIpc, type MeetingRecordAuditRecord } from '../ipc/meeting-record-ipc'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { recallRead } from '../recall'
import { getSettings } from '../store'
import { resolveMeetingsFolder } from '../transcripts'

export interface MeetingRecordWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  audit(record: MeetingRecordAuditRecord): void
}

/**
 * Builds the structured meeting record (G78) over the one meeting reader and the sealed sidecar, and registers its IPC
 * behind the shared sender authorizer. Hangs off `createOwnerSessionWiring`, so index.ts gains no lines.
 */
export function bootstrapMeetingRecord(deps: MeetingRecordWiringDeps): MeetingRecordService {
  const record = createMeetingRecordService({
    readMeeting: (file) => recallRead(file),
    folder: () => resolveMeetingsFolder(getSettings()),
    encrypt: () => !!getSettings().encryptTranscripts,
    store: defaultRecordEditsDeps,
    serialize: withMeetingMutation
  })
  registerMeetingRecordIpc({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    record,
    audit: deps.audit
  })
  return record
}
