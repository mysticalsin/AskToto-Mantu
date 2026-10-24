import { describe, expect, it, vi } from 'vitest'
import { createAttachmentsPreloadApi } from './attachments'

describe('attachments preload API (G54)', () => {
  it('sends intents only, with OS drop paths and no contents', async () => {
    const invoke = vi.fn(async () => ({ ok: true }))
    const api = createAttachmentsPreloadApi({ invoke } as never, (f) => `/drop/${f.name}`)
    await api.attachDroppedFiles('c1', [{ name: 'a.txt' } as File, { name: 'b.md' } as File])
    await api.attachFromPicker('c1')
    await api.attachFromClipboard('c1')
    await api.removeAttachment('abcdefgh')
    await api.listAttachments('c1')
    expect(invoke.mock.calls).toEqual([
      ['attachments:add', { source: 'drop', conversationKey: 'c1', paths: ['/drop/a.txt', '/drop/b.md'] }],
      ['attachments:add', { source: 'picker', conversationKey: 'c1' }],
      ['attachments:add', { source: 'paste', conversationKey: 'c1' }],
      ['attachments:remove', { id: 'abcdefgh' }],
      ['attachments:list', { conversationKey: 'c1' }]
    ])
  })
  it('exposes no content or arbitrary-path entry point', () => {
    expect(Object.keys(createAttachmentsPreloadApi({ invoke: vi.fn() } as never, () => '')).sort()).toEqual([
      'attachDroppedFiles',
      'attachFromClipboard',
      'attachFromPicker',
      'listAttachments',
      'removeAttachment'
    ])
  })
})
