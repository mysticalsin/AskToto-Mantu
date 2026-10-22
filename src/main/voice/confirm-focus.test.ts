import { describe, expect, it, vi } from 'vitest'
import { createConfirmFocus, type ConfirmFocusDeps } from './confirm-focus'

const NOTES_APP = { pid: 4242, windowId: 'com.apple.Notes' }

function make(overrides: Partial<ConfirmFocusDeps> = {}) {
  const calls: string[] = []
  const deps: ConfirmFocusDeps = {
    platform: 'darwin',
    ownPid: 100,
    frontmost: () => NOTES_APP,
    showForConfirm: vi.fn(() => void calls.push('show')),
    activatePid: vi.fn(async (pid: number) => {
      calls.push(`activate:${pid}`)
      return true
    }),
    blurWindow: vi.fn(() => void calls.push('blur')),
    ...overrides
  }
  return { focus: createConfirmFocus(deps), deps, calls }
}

describe('confirmation focus exception (D-10: the card is the third exception to no-focus-steal)', () => {
  it('takes focus once when a card appears, remembering the app that was in front', () => {
    const { focus, calls } = make()
    focus.presented()
    focus.presented() // a replaced card does not capture the overlay itself as the "previous" app
    expect(calls).toEqual(['show', 'show'])
    expect(focus.previous()).toEqual(NOTES_APP)
  })

  it('does not remember Métis itself as the app to go back to', () => {
    const { focus } = make({ frontmost: () => ({ pid: 100, windowId: 'com.mantu.asktoto' }) })
    focus.presented()
    expect(focus.previous()).toBeNull()
  })

  it.each([
    'cancelled',
    'expired',
    'confirmed',
    'policy_denied',
    'preflight_failed'
  ])('gives focus back to the previous app on macOS after %s', async (reason) => {
    const { focus, calls } = make()
    focus.presented()
    await focus.release(reason)
    expect(calls).toEqual(['show', 'activate:4242'])
  })

  it('blurs the window on Windows instead of activating a pid', async () => {
    const { focus, calls, deps } = make({ platform: 'win32' })
    focus.presented()
    await focus.release('cancelled')
    expect(calls).toEqual(['show', 'blur'])
    expect(deps.activatePid).not.toHaveBeenCalled()
  })

  it.each([
    'window_blurred',
    'window_hidden',
    'screen_locked',
    'system_suspend',
    'runtime_proposal_replaced'
  ])('does not yank focus back after %s: the person already moved, or another card follows', async (reason) => {
    const { focus, calls } = make()
    focus.presented()
    await focus.release(reason)
    expect(calls).toEqual(['show'])
  })

  it('restores once per card, and never when no card took focus', async () => {
    const { focus, calls } = make()
    await focus.release('cancelled')
    expect(calls).toEqual([])
    focus.presented()
    await focus.release('cancelled')
    await focus.release('cancelled')
    expect(calls).toEqual(['show', 'activate:4242'])
  })

  it('stays safe when the helper fails or no previous app is known', async () => {
    const failing = make({ activatePid: vi.fn(async () => Promise.reject(new Error('helper missing'))) })
    failing.focus.presented()
    await expect(failing.focus.release('cancelled')).resolves.toBeUndefined()

    const unknown = make({ frontmost: () => null })
    unknown.focus.presented()
    await unknown.focus.release('cancelled')
    expect(unknown.calls).toEqual(['show'])
  })

  it('bounds the restore so a hung helper can never hold up the confirmed action', async () => {
    vi.useFakeTimers()
    try {
      const { focus } = make({ activatePid: () => new Promise<boolean>(() => {}) })
      focus.presented()
      const done = vi.fn()
      void focus.release('confirmed').then(done)
      await vi.advanceTimersByTimeAsync(1_600)
      expect(done).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
