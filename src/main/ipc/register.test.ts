import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import { UNAUTHENTICATED_RESULT } from '@shared/ipc-auth'
import { PUBLIC_IPC_HANDLERS } from './security'
import { registerHandler } from './register'
import { registerScreenPermissionIpc } from './screen-permission-ipc'
import { registerWriteupIpc } from './writeup'

vi.mock('electron')
vi.mock('../auth', () => ({ requireAuth: () => true }))
vi.mock('../logger', () => ({ auditLog: vi.fn() }))
vi.mock('../llm/local', () => ({ appleEngineStatus: async () => 'unlicensed' }))
vi.mock('../permission-repair', () => ({ repairScreenPermission: vi.fn() }))
vi.mock('../infra/process/exec-file', () => ({ execFileNoShell: vi.fn() }))
vi.mock('../capture-permissions/screen-permission-runtime', () => ({
  APP_BUNDLE_ID: 'com.mantu.asktoto',
  screenPermission: () => ({
    noteRepairStarted: vi.fn(),
    noteRepairFailed: vi.fn(),
    attest: vi.fn(),
    diagnose: () => ({ duplicates: [] })
  })
}))

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

    function compileOnly(): void {
      // @ts-expect-error M2-0249: omitting auth must not compile for new handlers.
      registerHandler({
        channel: IPC.writeupSpan,
        isAuthenticated: () => true,
        args: z.tuple([]),
        assertSender: () => undefined
      }, () => undefined)
    }
    void compileOnly

    expect(ipcMain.handle).toHaveBeenCalledTimes(1)
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
    function compileOnly(): void {
      // @ts-expect-error M2-0249: public handlers must first be reviewed into PUBLIC_IPC_HANDLERS.
      registerHandler({
        channel: IPC.writeupSpan,
        auth: 'public',
        args: z.tuple([]),
        assertSender: () => undefined
      }, () => undefined)
    }
    void compileOnly

    expect(() => registerHandler({
      channel: IPC.writeupSpan,
      auth: 'public',
      args: z.tuple([]),
      assertSender: () => undefined
    } as never, () => undefined)).toThrow(/allowlist/)
  })

  it('fails closed when JavaScript or a cast passes an unknown auth policy', () => {
    expect(() => registerHandler({
      channel: IPC.localAppleEngineStatus,
      auth: 'unknown',
      args: z.tuple([]),
      assertSender: () => undefined
    } as never, () => undefined)).toThrow(/Unknown IPC auth policy/)
    expect(ipcMain.handle).not.toHaveBeenCalled()
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

  it('lists every migrated public handler in the reviewed allowlist', () => {
    const registered = handlers()

    registerWriteupIpc(() => undefined)
    registerScreenPermissionIpc(() => undefined)

    expect([...registered.keys()].sort()).toEqual([
      IPC.localAppleEngineStatus,
      IPC.permissionsAttestScreen,
      IPC.permissionsOpenSettings,
      IPC.permissionsRepairScreen,
      IPC.permissionsRevealCopy,
      IPC.writeupSpan
    ].sort())
    expect([...PUBLIC_IPC_HANDLERS].sort()).toEqual([
      IPC.localAppleEngineStatus,
      IPC.permissionsAttestScreen,
      IPC.permissionsOpenSettings,
      IPC.permissionsRepairScreen,
      IPC.permissionsRevealCopy
    ].sort())
  })
})
