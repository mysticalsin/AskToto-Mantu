import { describe, expect, it, vi } from 'vitest'
import { reconcileLoginItem } from './login-item-reconcile'

describe('reconcileLoginItem — the OS is the authority on a login item', () => {
  it('never re-enables a login item the OS turned off while Settings says on', () => {
    const set = vi.fn()
    expect(reconcileLoginItem({ want: true, readOs: () => false, setOs: set })).toBe(true) // UI should refresh and show it off
    expect(set).not.toHaveBeenCalled()
  })

  it('turns the OS item off when Settings says off', () => {
    const set = vi.fn()
    expect(reconcileLoginItem({ want: false, readOs: () => true, setOs: set })).toBe(true)
    expect(set).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('does nothing when they agree or the OS cannot be read', () => {
    const set = vi.fn()
    expect(reconcileLoginItem({ want: true, readOs: () => true, setOs: set })).toBe(false)
    expect(reconcileLoginItem({ want: false, readOs: () => false, setOs: set })).toBe(false)
    expect(reconcileLoginItem({ want: true, readOs: () => null, setOs: set })).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })
})
