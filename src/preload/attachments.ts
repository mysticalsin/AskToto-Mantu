import { webUtils, type IpcRenderer } from 'electron'
import { ATTACHMENT_IPC, type AttachmentAddResult, type AttachmentListResult } from '../shared/attachments'

/**
 * The renderer's side of composer attachments (G54). It sends an intent and gets back ids, names, sizes and refusal
 * copy. The only path it ever handles is the one the OS gave a drop event, resolved here with `webUtils` (a File object
 * has no path in a sandboxed renderer); file contents never cross this bridge in either direction.
 */
export function createAttachmentsPreloadApi(
  ipc: Pick<IpcRenderer, 'invoke'>,
  pathForFile: (file: File) => string = (file) => webUtils.getPathForFile(file)
): {
  attachDroppedFiles(conversationKey: string, files: File[]): Promise<AttachmentAddResult>
  attachFromPicker(conversationKey: string): Promise<AttachmentAddResult>
  attachFromClipboard(conversationKey: string): Promise<AttachmentAddResult>
  removeAttachment(id: string): Promise<{ ok: boolean }>
  listAttachments(conversationKey: string): Promise<AttachmentListResult>
} {
  return {
    attachDroppedFiles: (conversationKey, files) => {
      const paths = files.map((file) => pathForFile(file)).filter((p) => p.length > 0)
      return ipc.invoke(ATTACHMENT_IPC.add, { source: 'drop', conversationKey, paths })
    },
    attachFromPicker: (conversationKey) => ipc.invoke(ATTACHMENT_IPC.add, { source: 'picker', conversationKey }),
    attachFromClipboard: (conversationKey) => ipc.invoke(ATTACHMENT_IPC.add, { source: 'paste', conversationKey }),
    removeAttachment: (id) => ipc.invoke(ATTACHMENT_IPC.remove, { id }),
    listAttachments: (conversationKey) => ipc.invoke(ATTACHMENT_IPC.list, { conversationKey })
  }
}
