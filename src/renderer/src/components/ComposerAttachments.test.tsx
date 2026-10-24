import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { composerAttachments } from '../lib/composer-attachments'
import { AttachButton, AttachmentChips, composerDropProps, onComposerPaste } from './ComposerAttachments'

describe('composer attachment UI (G54)', () => {
  it('plain text paste is left to the input; a file paste is claimed and routed to main', () => {
    const paste = vi.spyOn(composerAttachments, 'paste').mockResolvedValue()
    const text = { preventDefault: vi.fn(), clipboardData: { files: [], types: ['text/plain'] } }
    onComposerPaste(text as never)
    expect(text.preventDefault).not.toHaveBeenCalled()
    expect(paste).not.toHaveBeenCalled()
    const file = { preventDefault: vi.fn(), clipboardData: { files: [{}], types: ['Files'] } }
    onComposerPaste(file as never)
    expect(file.preventDefault).toHaveBeenCalled()
    expect(paste).toHaveBeenCalledTimes(1)
    paste.mockRestore()
  })

  it('a file drop attaches; a text or link drop is ignored', () => {
    const drop = vi.spyOn(composerAttachments, 'attachDropped').mockResolvedValue()
    const link = { preventDefault: vi.fn(), dataTransfer: { files: [], types: ['text/uri-list'] } }
    composerDropProps.onDrop(link as never)
    expect(drop).not.toHaveBeenCalled()
    const f = { name: 'a.txt' }
    const files = { preventDefault: vi.fn(), dataTransfer: { files: [f], types: ['Files'] } }
    composerDropProps.onDragOver(files as never)
    composerDropProps.onDrop(files as never)
    expect(files.preventDefault).toHaveBeenCalledTimes(2)
    expect(drop).toHaveBeenCalledWith([f])
    drop.mockRestore()
  })

  it('renders the paperclip, and nothing when nothing is attached', () => {
    expect(renderToStaticMarkup(<AttachButton />)).toContain('aria-label="Attach a file"')
    expect(renderToStaticMarkup(<AttachmentChips />)).toBe('')
  })
})
