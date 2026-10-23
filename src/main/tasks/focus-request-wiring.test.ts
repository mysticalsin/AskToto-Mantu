import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ dialog: {}, globalShortcut: {} }))
vi.mock('../logger', () => ({ auditLog: vi.fn() }))

import { createFocusDecisionDialog, createGlobalShortcutEscapeSource } from './focus-request-wiring'

describe('Escape source on Electron globalShortcut (G40)', () => {
  it('registers Escape only while armed and releases it on disarm', () => {
    const registered = new Set<string>()
    const shortcuts = {
      isRegistered: (key: string) => registered.has(key),
      register: (key: string) => (registered.add(key), true),
      unregister: (key: string) => void registered.delete(key)
    }
    const disarm = createGlobalShortcutEscapeSource(shortcuts).arm(() => undefined)
    expect(registered.has('Escape')).toBe(true)
    disarm?.()
    expect(registered.has('Escape')).toBe(false)
  })

  it('does not take Escape from another owner, and a refused registration is not armed', () => {
    const taken = { isRegistered: () => true, register: vi.fn(() => true), unregister: vi.fn() }
    expect(createGlobalShortcutEscapeSource(taken).arm(() => undefined)).toBeNull()
    expect(taken.register).not.toHaveBeenCalled()
    const refused = { isRegistered: () => false, register: () => false, unregister: vi.fn() }
    expect(createGlobalShortcutEscapeSource(refused).arm(() => undefined)).toBeNull()
    const throws = {
      isRegistered: () => false,
      register: () => {
        throw new Error('no')
      },
      unregister: vi.fn()
    }
    expect(createGlobalShortcutEscapeSource(throws).arm(() => undefined)).toBeNull()
  })
})

describe('focus decision dialog (G40)', () => {
  const box = (response: number) => vi.fn(async () => ({ response }))
  const timers = { set: vi.fn(() => 1), clear: vi.fn() }

  it('names the app from a fixed label, defaults to not now, and only the explicit button grants', async () => {
    const showMessageBox = box(1)
    const decide = createFocusDecisionDialog({ showMessageBox, timers })
    expect(await decide({ actionId: 'desktop.photo_booth_capture' }, new AbortController().signal)).toBe('granted')
    const options = (showMessageBox.mock.calls[0] as unknown[])[0] as {
      message: string
      defaultId: number
      cancelId: number
    }
    expect(options.message).toContain('Photo Booth')
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
    expect(
      await createFocusDecisionDialog({ showMessageBox: box(0), timers })(
        { actionId: 'x' },
        new AbortController().signal
      )
    ).toBe('declined')
  })

  it('counts a Stop before or during the question as declined', async () => {
    const controller = new AbortController()
    controller.abort()
    const showMessageBox = box(1)
    expect(await createFocusDecisionDialog({ showMessageBox, timers })({ actionId: 'x' }, controller.signal)).toBe(
      'declined'
    )
    expect(showMessageBox).not.toHaveBeenCalled()

    const live = new AbortController()
    const pending = createFocusDecisionDialog({ showMessageBox: () => new Promise(() => undefined), timers })(
      { actionId: 'x' },
      live.signal
    )
    live.abort()
    expect(await pending).toBe('declined')
  })

  it('counts the time limit as declined', async () => {
    let fire: () => void = () => undefined
    const fakeTimers = { set: (cb: () => void) => ((fire = cb), 1), clear: vi.fn() }
    const pending = createFocusDecisionDialog({
      showMessageBox: () => new Promise(() => undefined),
      timers: fakeTimers
    })({ actionId: 'x' }, new AbortController().signal)
    fire()
    expect(await pending).toBe('declined')
  })
})
