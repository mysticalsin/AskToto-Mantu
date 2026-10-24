import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  MEETING_RECORD_IPC,
  MeetingRecordEditSchema,
  MeetingRecordGetSchema,
  UNAVAILABLE_RECORD,
  type MeetingRecord,
  type MeetingRecordAck
} from '@shared/meeting-record'
import type { MeetingRecordService } from '../features/meeting-record'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface MeetingRecordAuditRecord {
  action: 'get' | 'set' | 'delete' | 'add'
  ok: boolean
  items?: number
}

export interface MeetingRecordIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  record: MeetingRecordService
  /** Counts only. Never text, an owner, a file name or a line. */
  audit?(record: MeetingRecordAuditRecord): void
}

const REFUSED: MeetingRecordAck = { ok: false }

/**
 * The renderer's seam to the structured meeting record (G78): read the derived record of one saved meeting and apply the
 * owner's edits to it. Both channels sit behind the main-window top-frame gate and a signed-in check, validate strictly
 * and answer with a content-free fallback. The renderer names a meeting by file name only; main resolves the folder.
 */
export function registerMeetingRecordIpc(deps: MeetingRecordIpcDependencies): void {
  const guard = (event: IpcMainInvokeEvent, surface: string): boolean => {
    deps.authorizeSender(event as unknown as SenderEventLike, {
      surface: `meeting.record.${surface}`,
      requireOwner: false,
      allowedFrames: 'main-window-top'
    })
    return deps.requireAuth()
  }
  const audit = (record: MeetingRecordAuditRecord): void => {
    try {
      deps.audit?.(record)
    } catch {
      /* audit is best effort */
    }
  }

  deps.ipcMain.handle(MEETING_RECORD_IPC.get, async (event, raw): Promise<MeetingRecord> => {
    const signedIn = guard(event, 'get')
    const parsed = MeetingRecordGetSchema.safeParse(raw)
    if (!signedIn || !parsed.success) return UNAVAILABLE_RECORD
    try {
      const record = await deps.record.get(parsed.data.file)
      audit({ action: 'get', ok: record.status !== 'unavailable', items: record.items.length })
      return record
    } catch {
      audit({ action: 'get', ok: false })
      return UNAVAILABLE_RECORD
    }
  })
  deps.ipcMain.handle(MEETING_RECORD_IPC.edit, async (event, raw): Promise<MeetingRecordAck> => {
    const signedIn = guard(event, 'edit')
    const parsed = MeetingRecordEditSchema.safeParse(raw)
    if (!signedIn || !parsed.success) return REFUSED
    let ok = false
    try {
      ok = await deps.record.edit(parsed.data.file, parsed.data)
    } catch {
      ok = false
    }
    audit({ action: parsed.data.op, ok })
    return { ok }
  })
}
