import { describe, expect, it, vi } from 'vitest'
import { OWNER_SESSION_IPC } from '@shared/contracts/owner-session'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/user-data', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  webContents: {},
  webFrameMain: { fromId: vi.fn(() => null) }
}))
vi.mock('../auth', () => ({ authStatus: vi.fn(() => ({ signedIn: false })), authSessionGeneration: vi.fn(() => 1) }))
vi.mock('../logger', () => ({ auditLog: vi.fn() }))

import { createOwnerSessionWiring } from './owner-session-wiring'

function wire() {
  const ipcMain = { handle: vi.fn() }
  const wiring = createOwnerSessionWiring({
    ipcMain,
    assertMainWindow: vi.fn(),
    currentInputSessionContext: () => ({ authSessionGeneration: 1, contextRevision: 3 })
  })
  return { ipcMain, wiring }
}

describe('owner session wiring', () => {
  it('registers only the owner-session status channel', () => {
    const { ipcMain } = wire()
    expect(ipcMain.handle.mock.calls.map((call) => call[0])).toEqual([OWNER_SESSION_IPC.status])
  })

  it('hands input capture the same authority and authorizer it exposes', () => {
    const { wiring } = wire()
    expect(wiring.inputCapture.ownerSession).toBe(wiring.ownerSession)
    expect(wiring.inputCapture.authorizeSender).toBe(wiring.authorizeSender)
    expect(typeof wiring.authorizeSender).toBe('function')
  })

  it('feeds delivered speech to the transcript store without throwing on unrelated events', () => {
    const { wiring } = wire()
    const onSegmentDelivered = wiring.speechHooks.onSegmentDelivered
    expect(typeof onSegmentDelivered).toBe('function')
    const owner = {
      captureId: 'b8ff8685-725b-40e0-a8ef-f343bb10b64f',
      generation: 7,
      binding: { processId: 11, routingId: 2, frame: {} },
      captureContext: null
    }
    expect(() => onSegmentDelivered?.(owner as never, { type: 'terminal' } as never)).not.toThrow()
  })
})
