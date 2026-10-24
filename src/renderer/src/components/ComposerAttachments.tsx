import { Paperclip, X } from 'lucide-react'
import {
  carriesFiles,
  composerAttachments,
  formatAttachmentSize,
  useComposerAttachments
} from '../lib/composer-attachments'

/** Drop handlers for the composer form: a file drop attaches; anything else (text, links) is left alone. */
export const composerDropProps = {
  onDragOver(event: React.DragEvent): void {
    if (carriesFiles(event.dataTransfer)) event.preventDefault()
  },
  onDrop(event: React.DragEvent): void {
    if (!carriesFiles(event.dataTransfer)) return
    event.preventDefault()
    void composerAttachments.attachDropped(Array.from(event.dataTransfer.files))
  }
}

/** Paste handler for the composer input: files and images attach; plain text paste is untouched. */
export function onComposerPaste(event: React.ClipboardEvent): void {
  if (!carriesFiles(event.clipboardData)) return
  event.preventDefault()
  void composerAttachments.paste()
}

/** The paperclip: main opens its own file dialog. */
export function AttachButton({ disabled }: { disabled?: boolean }): JSX.Element {
  const { busy } = useComposerAttachments()
  return (
    <button
      type="button"
      aria-label="Attach a file"
      className="right-edge-sidecar__attach no-drag focus-ring"
      disabled={disabled || busy}
      onClick={() => void composerAttachments.pick()}
    >
      <Paperclip size={16} strokeWidth={1.9} />
    </button>
  )
}

/** What is attached (name, size, remove) and, honestly, what was turned away and why. */
export function AttachmentChips(): JSX.Element | null {
  const { items, errors } = useComposerAttachments()
  if (items.length === 0 && errors.length === 0) return null
  return (
    <div className="right-edge-sidecar__attachments">
      {items.length > 0 && (
        <ul className="right-edge-sidecar__chips" aria-label="Attached files">
          {items.map((item) => (
            <li key={item.id} className="right-edge-sidecar__chip">
              <span className="right-edge-sidecar__chip-name" title={item.name}>
                {item.name}
              </span>
              <span className="right-edge-sidecar__chip-size">{formatAttachmentSize(item.bytes)}</span>
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                className="right-edge-sidecar__chip-remove no-drag focus-ring"
                onClick={() => void composerAttachments.remove(item.id)}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {errors.length > 0 && (
        <div role="alert" className="right-edge-sidecar__attach-error">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
          <button
            type="button"
            className="right-edge-sidecar__attach-dismiss no-drag focus-ring"
            onClick={() => composerAttachments.dismissErrors()}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}
