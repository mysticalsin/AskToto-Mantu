import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { AppendMeetingJournalSchema, IPC, type AppendMeetingJournalResult } from '@shared/ipc'
import type { LiveMeetingJournal } from '../features/meetings/live-meeting-journal'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface MeetingJournalIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Audited main-window top-frame gate; throws a typed refusal for any other sender. */
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  journal: Pick<LiveMeetingJournal, 'append'>
}

const REFUSED: AppendMeetingJournalResult = { status: 'refused' }

/**
 * `transcript:journalAppend`: the renderer's write seam into the live meeting journal. The renderer supplies only the
 * committed cloud-final line and the meeting start; WHICH frame sent it comes from the IPC sender, and the journal
 * proves that frame is the one the transcript revision store bound to that meeting (the frame whose delivered speech
 * opened it). A renderer therefore cannot journal into a meeting it does not own, or one main has not seen deliver
 * speech. The reply is content-free: durable or refused, never why.
 */
export function registerMeetingJournalIpc(deps: MeetingJournalIpcDependencies): void {
  deps.ipcMain.handle(IPC.appendMeetingJournal, async (event, raw): Promise<AppendMeetingJournalResult> => {
    deps.authorizeSender(event as IpcMainInvokeEvent as SenderEventLike, {
      surface: 'transcript.journalAppend',
      requireOwner: false,
      allowedFrames: 'main-window-top'
    })
    if (!deps.requireAuth()) return REFUSED
    const parsed = AppendMeetingJournalSchema.safeParse(raw)
    if (!parsed.success) return REFUSED
    const frame = event.senderFrame
    if (!frame) return REFUSED
    const outcome = await deps.journal.append({
      startedAt: parsed.data.startedAt,
      frameOwner: `${frame.processId}:${frame.routingId}`,
      line: parsed.data.line
    })
    return outcome.status === 'durable' ? { status: 'durable' } : REFUSED
  })
}
