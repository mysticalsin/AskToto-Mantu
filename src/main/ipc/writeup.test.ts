import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { registerWriteupIpc } from './writeup'

vi.mock('electron')
const auth = vi.hoisted(() => ({ signedIn: true }))
vi.mock('../auth', () => ({ requireAuth: () => auth.signedIn }))
const auditLogMock = vi.hoisted(() => vi.fn())
vi.mock('../logger', () => ({ auditLog: auditLogMock }))
vi.mock('../llm/local', () => ({ appleEngineStatus: async () => 'unlicensed' }))

type Handler = Parameters<typeof ipcMain.handle>[1]
const event = { sender: 'main-window' } as unknown as Electron.IpcMainInvokeEvent

function register(assertMainWindow = vi.fn()): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, fn: Handler) => {
    handlers.set(channel, fn)
  })
  registerWriteupIpc(assertMainWindow)
  return handlers
}

describe('M2-0430: write-up IPC', () => {
  beforeEach(() => {
    auditLogMock.mockClear()
    auth.signedIn = true
  })

  it('audits a known span as its name and millisecond count only', () => {
    const handlers = register()
    handlers.get(IPC.writeupSpan)!(event, { span: 'stop_to_first_recap_token', ms: 4_200 })
    expect(auditLogMock).toHaveBeenCalledWith('writeup.span', { span: 'stop_to_first_recap_token', ms: 4_200 })
  })

  it('drops a span carrying anything else, an unknown span, or any span when signed out', () => {
    const handlers = register()
    const span = handlers.get(IPC.writeupSpan)!
    span(event, { span: 'stop_to_recap_done', ms: 10, text: 'Synthetic meeting line.' })
    span(event, { span: 'stop_to_lunch', ms: 10 })
    auth.signedIn = false
    span(event, { span: 'stop_to_recap_done', ms: 10 })
    expect(auditLogMock).not.toHaveBeenCalled()
  })

  it('rejects a sender that is not the main window before doing anything', async () => {
    const denied = vi.fn(() => { throw new Error('IPC denied') })
    const handlers = register(denied)
    expect(() => handlers.get(IPC.writeupSpan)!(event, { span: 'stop_to_recap_done', ms: 1 })).toThrow('IPC denied')
    expect(() => handlers.get(IPC.localAppleEngineStatus)!(event)).toThrow('IPC denied')
    expect(auditLogMock).not.toHaveBeenCalled()
    const allowed = register()
    await expect(allowed.get(IPC.localAppleEngineStatus)!(event)).resolves.toBe('unlicensed')
  })
})
