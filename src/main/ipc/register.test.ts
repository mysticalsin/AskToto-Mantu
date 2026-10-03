import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC, UNAUTHENTICATED_RESULT } from '@shared/ipc'
import { PUBLIC_IPC_HANDLERS } from './security'
import { registerHandler } from './register'

vi.mock('electron')

type Handler = Parameters<typeof ipcMain.handle>[1]
const event = {} as Electron.IpcMainInvokeEvent

function handlers(): Map<string, Handler> {
  const registered = new Map<string, Handler>()
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, fn: Handler) => {
    registered.set(channel, fn)
  })
  return registered
}

describe('M2-0249 registerHandler authentication policy', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset()
  })

  it('requires every registration to declare required or public authentication', () => {
    registerHandler({
      channel: IPC.writeupSpan,
      auth: 'required',
      isAuthenticated: () => true,
      args: z.tuple([z.string()]),
      assertSender: () => undefined
    }, (_event, value) => value.toUpperCase())

    // @ts-expect-error M2-0249: omitting auth must not compile for new handlers.
    registerHandler({
      channel: IPC.writeupSpan,
      isAuthenticated: () => true,
      args: z.tuple([]),
      assertSender: () => undefined
    }, () => undefined)

    expect(ipcMain.handle).toHaveBeenCalledTimes(2)
  })

  it('returns the one typed unauthenticated result before the handler body runs', async () => {
    const registered = handlers()
    const body = vi.fn(() => ({ ok: true }))
    const assertSender = vi.fn()

    registerHandler({
      channel: IPC.writeupSpan,
      auth: 'required',
      isAuthenticated: () => false,
      args: z.tuple([z.object({ span: z.string() })]),
      assertSender
    }, body)

    await expect(registered.get(IPC.writeupSpan)!(event, { span: 'stop_to_recap_done' })).resolves.toEqual(UNAUTHENTICATED_RESULT)
    expect(assertSender).toHaveBeenCalledTimes(1)
    expect(body).not.toHaveBeenCalled()
  })

  it('validates arguments before auth so malformed payloads never reach a required handler', async () => {
    const registered = handlers()
    const isAuthenticated = vi.fn(() => true)
    const body = vi.fn()

    registerHandler({
      channel: IPC.writeupSpan,
      auth: 'required',
      isAuthenticated,
      args: z.tuple([z.object({ value: z.string() })]),
      assertSender: () => undefined
    }, body)

    await expect(registered.get(IPC.writeupSpan)!(event, { value: 1 })).rejects.toThrow()
    expect(isAuthenticated).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it('refuses a public handler that has not been reviewed into the allowlist', () => {
    expect(() => registerHandler({
      channel: IPC.writeupSpan,
      auth: 'public',
      args: z.tuple([]),
      assertSender: () => undefined
    }, () => undefined)).toThrow(/allowlist/)
  })

  it('keeps the reviewed public handler list explicit', () => {
    expect(PUBLIC_IPC_HANDLERS).toEqual([
      IPC.localAppleEngineStatus,
      IPC.permissionsOpenSettings,
      IPC.permissionsRepairScreen,
      IPC.permissionsAttestScreen,
      IPC.permissionsRevealCopy
    ])
  })
})
