import type { IpcMain } from 'electron'
import {
  ATTACHMENT_IPC,
  AttachmentIntentSchema,
  AttachmentListSchema,
  AttachmentRemoveSchema,
  attachmentRefusalCopy,
  type AttachmentAddResult,
  type AttachmentListResult
} from '@shared/attachments'
import type { AttachmentService } from '../features/attachments/service'

export interface AttachmentsIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Throws for any sender that is not the main window's top frame. */
  assertMainWindow(event: never): void
  requireAuth(): boolean
  service: AttachmentService
}

const refused = (reason: 'signed-out' | 'invalid'): AttachmentAddResult => ({
  ok: false,
  attachments: [],
  rejected: [{ name: '', reason, message: attachmentRefusalCopy(reason) }]
})

/**
 * The renderer's side of composer attachments (G54): add (drop paths the OS gave, or ask main to open its picker or read
 * the clipboard), remove, and list what is held for the visible conversation. Every channel is gated to the main
 * window and a signed-in owner and strictly parsed; replies carry ids, names, sizes and refusal copy, never contents.
 */
export function registerAttachmentsIpc(deps: AttachmentsIpcDeps): void {
  const gate = (event: unknown): void => deps.assertMainWindow(event as never)

  deps.ipcMain.handle(ATTACHMENT_IPC.add, async (event, raw): Promise<AttachmentAddResult> => {
    gate(event)
    if (!deps.requireAuth()) return refused('signed-out')
    const parsed = AttachmentIntentSchema.safeParse(raw)
    return parsed.success ? deps.service.add(parsed.data) : refused('invalid')
  })

  deps.ipcMain.handle(ATTACHMENT_IPC.remove, (event, raw): { ok: boolean } => {
    gate(event)
    if (!deps.requireAuth()) return { ok: false }
    const parsed = AttachmentRemoveSchema.safeParse(raw)
    return { ok: parsed.success && deps.service.remove(parsed.data.id) }
  })

  deps.ipcMain.handle(ATTACHMENT_IPC.list, (event, raw): AttachmentListResult => {
    gate(event)
    if (!deps.requireAuth()) return { attachments: [] }
    const parsed = AttachmentListSchema.safeParse(raw)
    return { attachments: parsed.success ? deps.service.list(parsed.data.conversationKey) : [] }
  })
}
