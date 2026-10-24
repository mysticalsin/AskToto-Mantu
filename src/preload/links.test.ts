import { describe, expect, it, vi } from 'vitest'
import { LINK_IPC } from '../shared/links'
import { createLinksPreloadApi } from './links'

describe('links preload bridge (G55)', () => {
  it('subscribes to the failure push, calls the listener without any payload, and unsubscribes', () => {
    const on = vi.fn()
    const removeListener = vi.fn()
    const listener = vi.fn()
    const off = createLinksPreloadApi({ on, removeListener }).onLinkOpenFailed(listener)
    expect(on.mock.calls[0][0]).toBe(LINK_IPC.openFailed)
    on.mock.calls[0][1]({}, 'https://secret.example/token')
    expect(listener).toHaveBeenCalledWith()
    off()
    expect(removeListener).toHaveBeenCalledWith(LINK_IPC.openFailed, on.mock.calls[0][1])
  })
})
