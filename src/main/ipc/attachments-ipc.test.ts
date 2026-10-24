import { describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_IPC } from '@shared/attachments'
import { registerAttachmentsIpc } from './attachments-ipc'
import type { AttachmentService } from '../features/attachments/service'

function setup(over: { auth?: boolean; gate?: () => void } = {}) {
  const handlers = new Map<string, (e: unknown, raw?: unknown) => unknown>()
  const service = {
    add: vi.fn(async () => ({ ok: true, attachments: [], rejected: [] })),
    list: vi.fn(() => []),
    remove: vi.fn(() => true),
    consume: vi.fn(),
    clear: vi.fn()
  } as unknown as AttachmentService
  registerAttachmentsIpc({
    ipcMain: { handle: (c, fn) => void handlers.set(c, fn as never) },
    assertMainWindow: over.gate ?? (() => undefined),
    requireAuth: () => over.auth ?? true,
    service
  })
  return { handlers, service }
}

describe('attachments IPC (G54)', () => {
  it('every channel asserts the main window first', async () => {
    const gate = vi.fn(() => {
      throw new Error('not main window')
    })
    const { handlers, service } = setup({ gate })
    for (const channel of Object.values(ATTACHMENT_IPC)) {
      const call = async (): Promise<unknown> => handlers.get(channel)?.({}, {})
      await expect(call()).rejects.toThrow('not main window')
    }
    expect(service.add).not.toHaveBeenCalled()
  })

  it('signed out: nothing reaches the service', async () => {
    const { handlers, service } = setup({ auth: false })
    const r = (await handlers.get(ATTACHMENT_IPC.add)?.({}, { source: 'picker', conversationKey: 'c' })) as {
      ok: boolean
      rejected: { reason: string }[]
    }
    expect(r.ok).toBe(false)
    expect(r.rejected[0]?.reason).toBe('signed-out')
    expect(handlers.get(ATTACHMENT_IPC.remove)?.({}, { id: 'abcdefgh' })).toEqual({ ok: false })
    expect(handlers.get(ATTACHMENT_IPC.list)?.({}, { conversationKey: 'c' })).toEqual({ attachments: [] })
    expect(service.add).not.toHaveBeenCalled()
  })

  it('strict zod: contents, stray fields and bad ids never reach the service', async () => {
    const { handlers, service } = setup()
    const bad = [
      { source: 'paste', conversationKey: 'c', data: 'AAAA' },
      { source: 'picker', conversationKey: 'c', paths: ['/etc/passwd'] },
      { source: 'drop', conversationKey: 'c' },
      { source: 'other', conversationKey: 'c' },
      null
    ]
    for (const raw of bad) {
      const r = (await handlers.get(ATTACHMENT_IPC.add)?.({}, raw)) as { rejected: { reason: string }[] }
      expect(r.rejected[0]?.reason).toBe('invalid')
    }
    expect(service.add).not.toHaveBeenCalled()
    expect(handlers.get(ATTACHMENT_IPC.remove)?.({}, { id: '../x' })).toEqual({ ok: false })
    expect(service.remove).not.toHaveBeenCalled()
  })

  it('a valid intent is forwarded unchanged', async () => {
    const { handlers, service } = setup()
    const intent = { source: 'drop', conversationKey: 'c', paths: ['/a/b.txt'] }
    await handlers.get(ATTACHMENT_IPC.add)?.({}, intent)
    expect(service.add).toHaveBeenCalledWith(intent)
  })
})
