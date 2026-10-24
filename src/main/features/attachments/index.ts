/** Public surface of the composer-attachments feature (G54). Other modules reach it only through this file. */
export {
  createAttachmentService,
  type AttachmentService,
  type AttachmentServiceDeps,
  type ClipboardPayload
} from './service'
export { pathsFromClipboardFormats } from './clipboard-paths'
