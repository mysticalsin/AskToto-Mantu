import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { UNAUTHENTICATED_RESULT } from '@shared/ipc-auth'
import { registerHistoryTraceIpc } from './history-trace-ipc'

vi.mock('electron')

type Handler = Parameters<typeof ipcMain.handle>[1]
const event = {} as Electron.IpcMainInvokeEvent

function register(requireAuth = vi.fn(() => true)): {
  handlers: Map<string, Handler>
  history: { traceList: ReturnType<typeof vi.fn>, settle: ReturnType<typeof vi.fn>, transition: ReturnType<typeof vi.fn> }
} {
  const handlers = new Map<string, Handler>()
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, fn: Handler) => {
    handlers.set(channel, fn)
  })
  const history = { traceList: vi.fn(), settle: vi.fn(), transition: vi.fn() }
  registerHistoryTraceIpc(() => undefined, requireAuth, history)
  return { handlers, history }
}

describe('M2-0249: History IPC registerHandler auth policy', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset()
  })

  it('returns the shared unauthenticated result without settling History telemetry', async () => {
    const { handlers, history } = register(vi.fn(() => false))

    await expect(handlers.get(IPC.historySettled)!(event, { id: 'synthetic' })).resolves.toEqual(UNAUTHENTICATED_RESULT)

    expect(history.settle).not.toHaveBeenCalled()
  })

  it('lets authenticated History telemetry reach the tracer', async () => {
    const { handlers, history } = register()

    await handlers.get(IPC.historyTransition)!(event, { from: 'review', to: 'history' })

    expect(history.transition).toHaveBeenCalledWith({ from: 'review', to: 'history' })
  })
})
