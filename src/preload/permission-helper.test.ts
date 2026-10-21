import { describe, expect, it, vi } from 'vitest'
import { PERMISSION_HELPER_IPC } from '@shared/permission-helper'

const invoked: string[] = []
let exposed: Record<string, (...args: unknown[]) => unknown> = {}
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: typeof exposed) => (exposed = api) },
  ipcRenderer: {
    invoke: (channel: string) => {
      invoked.push(channel)
      return Promise.resolve(null)
    },
    send: (channel: string) => invoked.push(channel),
    on: (channel: string) => invoked.push(channel),
    removeListener: vi.fn()
  }
}))

/** The helper preload's literal channel names are the shared contract's (see the preload's note on chunks). */
describe('permission helper preload', () => {
  it('exposes only the helper actions, on the contract channels', async () => {
    await import('./permission-helper')
    expect(Object.keys(exposed).sort()).toEqual(['cancel', 'getState', 'onState', 'relaunch', 'reveal', 'startDrag'])
    await exposed.getState()
    exposed.onState(() => {})
    exposed.startDrag()
    await exposed.reveal()
    await exposed.cancel()
    await exposed.relaunch()
    const { open: _open, ...helperChannels } = PERMISSION_HELPER_IPC
    expect(invoked.sort()).toEqual(Object.values(helperChannels).sort())
  })
})
