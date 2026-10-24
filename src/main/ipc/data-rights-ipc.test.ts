import { describe, expect, it } from 'vitest'
import { DATA_RIGHTS_IPC } from '@shared/data-rights'
import type { DataRightsService } from '../features/data-rights'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'
import { registerDataRightsIpc } from './data-rights-ipc'

function setup(options: { signedIn?: boolean; allowSender?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  const calls: string[] = []
  const service: DataRightsService = {
    preview: async () => (calls.push('preview'), { ok: false, reason: 'signed-out' }),
    confirm: async () => (calls.push('confirm'), { ok: false, reason: 'unknown-proposal' }),
    lastReceipt: async () => (calls.push('last'), { ok: true, receipt: null }),
    exportData: async () => (calls.push('export'), { ok: true, records: 0, skipped: 0 }),
    onOwnerChange: () => undefined
  }
  const gates: unknown[] = []
  registerDataRightsIpc({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender: ((_event: unknown, opts: unknown) => {
      gates.push(opts)
      if (options.allowSender === false) throw new SenderRefusal('wrong-window', 'dataRights')
      return null
    }) as unknown as AuthorizeSender,
    requireAuth: () => options.signedIn !== false,
    service
  })
  return { handlers, calls, gates, call: (c: string, raw?: unknown) => handlers.get(c)!({}, raw) }
}

describe('data rights IPC (G82)', () => {
  it('registers exactly the contract channels behind the main-window owner gate', async () => {
    const t = setup()
    expect([...t.handlers.keys()].sort()).toEqual(Object.values(DATA_RIGHTS_IPC).sort())
    await t.call(DATA_RIGHTS_IPC.preview)
    expect(t.gates[0]).toMatchObject({ requireOwner: true, allowedFrames: 'main-window-top' })
  })

  it('non-main-window refused', async () => {
    const t = setup({ allowSender: false })
    await expect(
      t.call(DATA_RIGHTS_IPC.confirm, { proposalId: 'a'.repeat(32), previewHash: 'b'.repeat(64) })
    ).rejects.toThrow()
    expect(t.calls).toEqual([])
  })

  it('unknown key invalid', async () => {
    const t = setup()
    expect(
      await t.call(DATA_RIGHTS_IPC.confirm, { proposalId: 'a'.repeat(32), previewHash: 'b'.repeat(64), ownerKey: 'x' })
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(await t.call(DATA_RIGHTS_IPC.preview, { stores: ['meetings'] })).toEqual({ ok: false, reason: 'invalid' })
    expect(await t.call(DATA_RIGHTS_IPC.export, { path: '/tmp/x' })).toEqual({ ok: false, reason: 'invalid' })
    expect(t.calls).toEqual([])
  })

  it('signed out refused', async () => {
    const t = setup({ signedIn: false })
    for (const channel of Object.values(DATA_RIGHTS_IPC)) {
      expect(await t.call(channel, undefined)).toEqual({ ok: false, reason: 'signed-out' })
    }
    expect(t.calls).toEqual([])
  })

  it('a valid confirm reaches the service', async () => {
    const t = setup()
    await t.call(DATA_RIGHTS_IPC.confirm, { proposalId: 'a'.repeat(32), previewHash: 'b'.repeat(64) })
    expect(t.calls).toEqual(['confirm'])
  })
})
