import { describe, expect, it, vi } from 'vitest'
import { TASK_BROWSER_IPC } from '@shared/task-browser'
import { registerTaskBrowserIpc } from './task-browser-ipc'

function harness(assert: () => void = () => undefined) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const runtime = {
    status: vi.fn(() => ({
      disclosureAcknowledged: false,
      openWindows: 0,
      currentTab: { status: 'unavailable' as const, copy: 'x' }
    })),
    acknowledgeDisclosure: vi.fn(() => Promise.resolve()),
    clearProfile: vi.fn(() => Promise.resolve(true))
  }
  registerTaskBrowserIpc({ handle: (c, h) => void handlers.set(c, h as never) }, assert, runtime)
  return { handlers, runtime }
}

describe('task browser IPC', () => {
  it('serves status, acknowledge and clear behind the sender check', async () => {
    const { handlers, runtime } = harness()
    expect(((await handlers.get(TASK_BROWSER_IPC.status)?.({})) as { openWindows: number }).openWindows).toBe(0)
    expect(await handlers.get(TASK_BROWSER_IPC.acknowledge)?.({})).toEqual({ ok: true })
    expect(await handlers.get(TASK_BROWSER_IPC.clear)?.({}, 'https://evil.example')).toEqual({ ok: true })
    expect(runtime.clearProfile).toHaveBeenCalledWith()
  })
  it('refuses a sender the check rejects, before touching the runtime', async () => {
    const { handlers, runtime } = harness(() => {
      throw new Error('untrusted sender')
    })
    for (const channel of Object.values(TASK_BROWSER_IPC)) {
      await expect(Promise.resolve().then(() => handlers.get(channel)?.({}))).rejects.toThrow('untrusted sender')
    }
    expect(runtime.clearProfile).not.toHaveBeenCalled()
  })
  it('reports a failed clear as not ok', async () => {
    const { handlers, runtime } = harness()
    runtime.clearProfile.mockResolvedValueOnce(false)
    expect(await handlers.get(TASK_BROWSER_IPC.clear)?.({})).toEqual({ ok: false })
  })
})
