import { describe, expect, it, vi } from 'vitest'
import type { AttachmentAddResult, AttachmentView } from '@shared/attachments'
import {
  carriesFiles,
  createComposerAttachments,
  formatAttachmentSize,
  type ComposerAttachmentsApi
} from './composer-attachments'

const view = (id: string, key = 'dock'): AttachmentView => ({
  id,
  name: `${id}.txt`,
  kind: 'text',
  bytes: 2048,
  conversationKey: key,
  addedAt: 1
})
const ok = (...a: AttachmentView[]): AttachmentAddResult => ({ ok: true, attachments: a, rejected: [] })

function setup(over: Partial<ComposerAttachmentsApi> = {}) {
  const api: ComposerAttachmentsApi = {
    attachDroppedFiles: vi.fn(async () => ok(view('aaaaaaaa'))),
    attachFromPicker: vi.fn(async () => ok(view('bbbbbbbb'))),
    attachFromClipboard: vi.fn(async () => ok(view('cccccccc'))),
    removeAttachment: vi.fn(async () => ({ ok: true })),
    listAttachments: vi.fn(async () => ({ attachments: [] })),
    ...over
  }
  return { api, store: createComposerAttachments(() => api) }
}

describe('composer attachments store (G54)', () => {
  it('adds from drop, picker and paste under the visible conversation key', async () => {
    const { api, store } = setup()
    await store.attachDropped([{ name: 'a.txt' } as File])
    await store.pick()
    await store.paste()
    expect(api.attachDroppedFiles).toHaveBeenCalledWith('dock', [{ name: 'a.txt' }])
    expect(api.attachFromPicker).toHaveBeenCalledWith('dock')
    expect(api.attachFromClipboard).toHaveBeenCalledWith('dock')
    expect(store.getSnapshot().items.map((i) => i.id)).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'])
  })

  it('shows per-file refusal copy honestly and keeps the accepted ones', async () => {
    const { store } = setup({
      attachDroppedFiles: async () => ({
        ok: true,
        attachments: [view('aaaaaaaa')],
        rejected: [{ name: 'x.pdf', reason: 'unsupported-type', message: '"x.pdf" is a type Métis cannot read yet.' }]
      })
    })
    await store.attachDropped([])
    expect(store.getSnapshot().items).toHaveLength(1)
    expect(store.getSnapshot().errors).toEqual(['"x.pdf" is a type Métis cannot read yet.'])
  })

  it('a cancelled picker shows no error; a thrown IPC says so', async () => {
    const a = setup({
      attachFromPicker: async () => ({
        ok: false,
        attachments: [],
        rejected: [{ name: '', reason: 'cancelled', message: 'No file was chosen.' }]
      })
    })
    await a.store.pick()
    expect(a.store.getSnapshot().errors).toEqual([])
    const b = setup({
      attachFromPicker: async () => {
        throw new Error('ipc')
      }
    })
    await b.store.pick()
    expect(b.store.getSnapshot().errors).toEqual(['That file could not be attached.'])
    expect(b.store.getSnapshot().busy).toBe(false)
  })

  it('remove drops the chip at once and tells main', async () => {
    const { api, store } = setup()
    await store.pick()
    await store.remove('bbbbbbbb')
    expect(store.getSnapshot().items).toEqual([])
    expect(api.removeAttachment).toHaveBeenCalledWith('bbbbbbbb')
  })

  it('takeForSend hands over ids with the conversation key once, then the composer is empty', async () => {
    const { store } = setup()
    expect(store.takeForSend()).toEqual({})
    await store.pick()
    expect(store.takeForSend()).toEqual({ attachmentIds: ['bbbbbbbb'], attachmentConversationKey: 'dock' })
    expect(store.getSnapshot().items).toEqual([])
    expect(store.takeForSend()).toEqual({})
  })

  it('switching conversation clears the chips and ignores a late result for the old one', async () => {
    let release: (r: AttachmentAddResult) => void = () => undefined
    const { store } = setup({ attachFromPicker: () => new Promise((res) => (release = res)) })
    const pending = store.pick()
    store.setConversation('other')
    release(ok(view('dddddddd')))
    await pending
    expect(store.getSnapshot().items).toEqual([])
    expect(store.conversationKey()).toBe('other')
  })

  it('refresh adopts what main still holds', async () => {
    const { store } = setup({ listAttachments: async () => ({ attachments: [view('eeeeeeee')] }) })
    await store.refresh()
    expect(store.getSnapshot().items.map((i) => i.id)).toEqual(['eeeeeeee'])
  })

  it('plain text paste stays text; files and images are attachments', () => {
    expect(carriesFiles({ files: [] as never, types: ['text/plain'] })).toBe(false)
    expect(carriesFiles({ files: [{}] as never, types: ['Files'] })).toBe(true)
    expect(carriesFiles({ files: [] as never, types: ['Files'] })).toBe(true)
    expect(carriesFiles(null)).toBe(false)
  })

  it('formats sizes', () => {
    expect(formatAttachmentSize(10)).toBe('10 B')
    expect(formatAttachmentSize(2048)).toBe('2 KB')
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
