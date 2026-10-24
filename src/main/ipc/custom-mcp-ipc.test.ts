import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { CUSTOM_MCP_IPC } from '@shared/custom-mcp'
import { registerCustomMcpIpc } from './custom-mcp-ipc'

type Handler = (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>

function setup(over: { signedIn?: boolean; mainWindow?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const service = {
    list: vi.fn(async () => ({ ok: true, servers: [] })),
    draft: vi.fn(async () => ({ ok: true })),
    confirm: vi.fn(async () => ({ ok: true })),
    refresh: vi.fn(async () => ({ ok: true })),
    disable: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true })),
    proposeCall: vi.fn(async () => ({ ok: true })),
    confirmCall: vi.fn(async () => ({ ok: true }))
  }
  registerCustomMcpIpc(
    { handle: (channel, handler) => void handlers.set(channel, handler as Handler) },
    {
      assertMainWindow: () => {
        if (over.mainWindow === false) throw new Error('not main window')
      },
      requireAuth: () => over.signedIn !== false,
      service: service as never
    }
  )
  const call = (channel: string, raw?: unknown) => (handlers.get(channel) as Handler)({} as IpcMainInvokeEvent, raw)
  return { service, call, handlers }
}

const id = `cmcp-${'a'.repeat(24)}`

describe('custom MCP IPC', () => {
  it('registers every channel', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual(Object.values(CUSTOM_MCP_IPC).sort())
  })

  it('non-main window rejected before anything runs', async () => {
    const { call, service } = setup({ mainWindow: false })
    await expect(call(CUSTOM_MCP_IPC.list)).rejects.toThrow('not main window')
    expect(service.list).not.toHaveBeenCalled()
  })

  it('signed-out callers get auth_required', async () => {
    const { call, service } = setup({ signedIn: false })
    expect(await call(CUSTOM_MCP_IPC.list)).toEqual({ ok: false, error: 'auth_required' })
    expect(await call(CUSTOM_MCP_IPC.remove, { id })).toEqual({ ok: false, error: 'auth_required' })
    expect(service.list).not.toHaveBeenCalled()
  })

  it('strict payloads reject extra keys and bad ids', async () => {
    const { call, service } = setup()
    expect(await call(CUSTOM_MCP_IPC.remove, { id, extra: 1 })).toEqual({ ok: false, error: 'invalid_input' })
    expect(await call(CUSTOM_MCP_IPC.remove, { id: '../../x' })).toEqual({ ok: false, error: 'invalid_input' })
    expect(await call(CUSTOM_MCP_IPC.list, { x: 1 })).toEqual({ ok: false, error: 'invalid_input' })
    expect(
      await call(CUSTOM_MCP_IPC.draft, {
        label: 'x',
        transport: { kind: 'https', url: 'https://a.example', allow: true },
        auth: { type: 'none' }
      })
    ).toEqual({ ok: false, error: 'invalid_input' })
    expect(service.remove).not.toHaveBeenCalled()
    expect(service.draft).not.toHaveBeenCalled()
  })

  it('renderer-supplied approval is ignored: confirm-call takes a proposal id and nothing else', async () => {
    const { call, service } = setup()
    const proposalId = 'c'.repeat(32)
    expect(await call(CUSTOM_MCP_IPC.confirmCall, { proposalId, argsHash: 'f'.repeat(64), approval: true })).toEqual({
      ok: false,
      error: 'invalid_input'
    })
    expect(
      await call(CUSTOM_MCP_IPC.proposeCall, { id, tool: 'create_note', args: {}, approval: { proposalId } })
    ).toEqual({
      ok: false,
      error: 'invalid_input'
    })
    expect(service.confirmCall).not.toHaveBeenCalled()
    expect(service.proposeCall).not.toHaveBeenCalled()
    await call(CUSTOM_MCP_IPC.confirmCall, { proposalId })
    expect(service.confirmCall).toHaveBeenCalledWith({ proposalId })
  })

  it('a thrown service error is replaced by a generic code, never forwarded', async () => {
    const { call, service } = setup()
    service.list.mockRejectedValueOnce(new Error('https://secret.example/path?token=abc'))
    expect(await call(CUSTOM_MCP_IPC.list)).toEqual({ ok: false, error: 'call_failed' })
  })

  it('list returns what the service returns (views carry hasSecret only, by construction)', async () => {
    const { call, service } = setup()
    service.list.mockResolvedValueOnce({ ok: true, servers: [{ id, hasSecret: true }] } as never)
    expect(JSON.stringify(await call(CUSTOM_MCP_IPC.list))).not.toMatch(/secret"\s*:\s*"/)
  })
})
