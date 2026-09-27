import { describe, expect, it, vi } from 'vitest'
import { createRevealController, type PresenterState, type RevealControllerDeps, type RevealWindow } from './reveal'

function windowStub(visible = true) {
  return {
    isDestroyed: () => false,
    isVisible: () => visible,
    show: vi.fn(),
    showInactive: vi.fn(),
    focus: vi.fn()
  } satisfies RevealWindow
}

function deps(overrides: Partial<RevealControllerDeps> = {}) {
  const w = windowStub()
  let state: PresenterState = { kind: 'PARKED', layout: 'hide' }
  const base: RevealControllerDeps = {
    ensureWindow: vi.fn(() => w),
    legacyRevealEnabled: vi.fn(() => false),
    legacyReveal: vi.fn(),
    presenterState: vi.fn(() => state),
    cancelPendingRepark: vi.fn(),
    restoreInteractiveLayout: vi.fn(() => { state = { kind: 'REVEALED' } }),
    repairOffscreenBounds: vi.fn(),
    disableClickThrough: vi.fn()
  }
  return { w, deps: { ...base, ...overrides } }
}

describe('M2-0036 reveal controller', () => {
  it('keeps boot-phase activate parked so first launch does not open Settings', () => {
    const { deps: d } = deps()
    const reveal = createRevealController(d)

    expect(reveal.reveal('activate', { focus: true })).toEqual({
      state: { kind: 'PARKED', layout: 'hide' },
      action: 'ignored-boot'
    })
    expect(d.ensureWindow).not.toHaveBeenCalled()
    expect(d.restoreInteractiveLayout).not.toHaveBeenCalled()
  })

  it('queues second-instance before boot completes and flushes it through the same reveal path', () => {
    const { w, deps: d } = deps()
    const reveal = createRevealController(d)

    expect(reveal.reveal('second-instance', { focus: true }).action).toBe('pending')
    expect(reveal.hasPendingReveal()).toBe(true)
    expect(d.ensureWindow).not.toHaveBeenCalled()

    expect(reveal.markBootComplete()).toEqual({ state: { kind: 'REVEALED' }, action: 'revealed' })
    expect(reveal.hasPendingReveal()).toBe(false)
    expect(d.cancelPendingRepark).toHaveBeenCalledTimes(1)
    expect(d.restoreInteractiveLayout).toHaveBeenCalledTimes(1)
    expect(d.repairOffscreenBounds).toHaveBeenCalledTimes(1)
    expect(d.disableClickThrough).toHaveBeenCalledTimes(1)
    expect(w.show).toHaveBeenCalledTimes(1)
    expect(w.focus).toHaveBeenCalledTimes(1)
  })

  it('explicit reveal leaves parked hide by restoring layout, repairing bounds, disabling click-through, then focusing', () => {
    const { w, deps: d } = deps()
    const reveal = createRevealController(d)
    reveal.markBootComplete()

    expect(reveal.reveal('tray', { focus: true })).toEqual({ state: { kind: 'REVEALED' }, action: 'revealed' })
    expect(d.cancelPendingRepark).toHaveBeenCalledTimes(1)
    expect(d.restoreInteractiveLayout).toHaveBeenCalledTimes(1)
    expect(d.repairOffscreenBounds).toHaveBeenCalledTimes(1)
    expect(d.disableClickThrough).toHaveBeenCalledTimes(1)
    expect(w.show).toHaveBeenCalledTimes(1)
    expect(w.focus).toHaveBeenCalledTimes(1)
    expect(w.showInactive).not.toHaveBeenCalled()
  })

  it('notification click uses the same reveal path without stealing focus', () => {
    const w = windowStub(false)
    const { deps: d } = deps({ ensureWindow: vi.fn(() => w) })
    const reveal = createRevealController(d)
    reveal.markBootComplete()

    expect(reveal.reveal('notification-click', { focus: false }).action).toBe('revealed')
    expect(d.restoreInteractiveLayout).toHaveBeenCalledTimes(1)
    expect(w.showInactive).toHaveBeenCalledTimes(1)
    expect(w.show).not.toHaveBeenCalled()
    expect(w.focus).not.toHaveBeenCalled()
  })

  it('reveal.legacy restores the previous branch instead of the new unpark sequence', () => {
    const legacyReveal = vi.fn()
    const { deps: d } = deps({
      legacyRevealEnabled: vi.fn(() => true),
      legacyReveal
    })
    const reveal = createRevealController(d)
    reveal.markBootComplete()

    expect(reveal.reveal('hotkey', { focus: true }).action).toBe('legacy')
    expect(legacyReveal).toHaveBeenCalledWith('hotkey', { focus: true })
    expect(d.restoreInteractiveLayout).not.toHaveBeenCalled()
    expect(d.disableClickThrough).not.toHaveBeenCalled()
  })
})
