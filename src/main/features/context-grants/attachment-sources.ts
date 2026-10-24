import { dialog, clipboard, BrowserWindow } from 'electron'
import { ATTACHMENT_IMAGE_EXTENSIONS, ATTACHMENT_TEXT_EXTENSIONS } from '@shared/attachments'
import { pathsFromClipboardFormats } from '../attachments'
import type { AttachmentServiceDeps, ClipboardPayload } from '../attachments'

/** The one place composer attachments touch Electron: main's own open dialog and its own clipboard read. */
export function createAttachmentSources(
  protectedRoots: () => string[]
): Pick<AttachmentServiceDeps, 'pickFiles' | 'readClipboard' | 'isProtectedPath'> {
  return {
    async pickFiles() {
      const options = {
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: [
          { name: 'Text and images', extensions: [...ATTACHMENT_TEXT_EXTENSIONS, ...ATTACHMENT_IMAGE_EXTENSIONS] }
        ]
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths
    },
    async readClipboard(): Promise<ClipboardPayload | null> {
      const paths = pathsFromClipboardFormats(process.platform, (format) => clipboard.readBuffer(format))
      if (paths.length > 0) return { paths }
      const image = clipboard.readImage()
      if (image.isEmpty()) return null
      return { image: { name: 'pasted-image.png', data: image.toPNG() } }
    },
    isProtectedPath: (path) =>
      protectedRoots().some((root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
  }
}
