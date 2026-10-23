import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForegroundInfo, ForegroundWatcher } from '../foreground-watcher'

/** D-19 (G47): the voice-action foreground watcher stops when idle, restarts on the next proposal, and a restarted
 *  watcher reports unknown (null) until it observes, never a stale app. */
const state = vi.hoisted(() => ({
  generation: 1,
  serialized: null as string | null,
  execute: vi.fn(),
  frontmost: (() => null) as () => unknown
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/isolated/asktoto-userdata', isAccessibilitySupportEnabled: () => false }
}))
vi.mock('../foreground-watcher', () => ({ startForegroundWatcher: vi.fn() }))
vi.mock('../desktop-permission-probes', () => ({ createDesktopPermissionProbes: () => ({}) }))
vi.mock('../mac-helper', () => ({ activatePid: vi.fn() }))
vi.mock('../logger', () => ({ mainLog: { warn: vi.fn(), error: vi.fn() }, auditLog: vi.fn() }))
vi.mock('./command-preflight', () => ({ createCommandPreflight: () => async () => ({ ok: true }) }))
vi.mock('./confirm-focus', () => ({
  createConfirmFocus: (deps: { frontmost: () => unknown }) => {
    state.frontmost = deps.frontmost
    return { presented: vi.fn(), release: vi.fn() }
  }
}))
vi.mock('./gesture-binding', () => ({
  createGestureBindings: () => ({ current: () => null, clear: vi.fn(), begin: vi.fn() })
}))
vi.mock('../desktop-adapter-deps', () => ({ createProductionDesktopAdapterDeps: () => ({}) }))
vi.mock('../desktop-adapters', () => ({
  executeDesktopAction: (...args: unknown[]) => state.execute(...args)
}))
vi.mock('../auth', () => ({ authSessionGeneration: () => state.generation }))
vi.mock('../qa-identity', () => ({ QA_IDENTITY_BUILD: false }))
vi.mock('../qa-voice-hooks', () => ({ qaDesktopSinkEnabled: vi.fn(() => false), createQaDesktopSink: vi.fn() }))
vi.mock('../secrets', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }))
vi.mock('../infra/storage/atomic-saved-write', () => ({ atomicSavedWrite: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, mkdir: vi.fn(async () => undefined), readFile: vi.fn(async () => '') }
})
vi.mock('../tasks/encrypted-task-file-store', () => ({
  createEncryptedTaskFileStore: () => ({
    read: async () =>
      state.serialized === null ? { kind: 'not-found' } : { kind: 'found', serialized: state.serialized },
    write: async (serialized: string) => {
      state.serialized = serialized
    },
    quarantine: async () => {
      state.serialized = null
    }
  })
}))

const IDLE = 60_000

function harness() {
  let clock = 1_000_000
  const watchers: { stop: ReturnType<typeof vi.fn>; info: ForegroundInfo | null }[] = []
  const startWatcher = vi.fn(() => {
    const w = { stop: vi.fn(), info: null as ForegroundInfo | null }
    watchers.push(w)
    const handle: ForegroundWatcher = { stop: w.stop, current: () => w.info, healthy: () => true }
    return handle
  })
  return {
    watchers,
    startWatcher,
    advance: (ms: number) => {
      clock += ms
      vi.advanceTimersByTime(ms)
    },
    options: {
      isAuthenticated: () => true,
      isRecordingMeeting: () => false,
      showForConfirm: vi.fn(),
      blurWindow: vi.fn(),
      startWatcher: startWatcher as never,
      now: () => clock,
      idleMs: IDLE
    }
  }
}

const REQUEST = { id: 'desktop.create_note', args: { title: 't' } } as never

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
})
afterEach(() => vi.useRealTimers())

describe('voice-action foreground watcher idles out (D-19)', () => {
  it('starts nothing until a proposal, stops after the idle period, and restarts on the next proposal', async () => {
    const h = harness()
    const { createCommandConfirmRuntime } = await import('./command-confirm-runtime')
    const runtime = createCommandConfirmRuntime(h.options)
    expect(h.startWatcher).not.toHaveBeenCalled()

    await runtime.deps.preflight?.(REQUEST, 'propose' as never)
    expect(h.startWatcher).toHaveBeenCalledTimes(1)

    h.advance(IDLE - 1)
    expect(h.watchers[0].stop).not.toHaveBeenCalled()
    h.advance(1)
    expect(h.watchers[0].stop).toHaveBeenCalledTimes(1)

    await runtime.deps.preflight?.(REQUEST, 'propose' as never)
    expect(h.startWatcher).toHaveBeenCalledTimes(2)
    runtime.dispose()
    expect(h.watchers[1].stop).toHaveBeenCalledTimes(1)
  })

  it('a new proposal inside the period keeps the same watcher alive', async () => {
    const h = harness()
    const { createCommandConfirmRuntime } = await import('./command-confirm-runtime')
    const runtime = createCommandConfirmRuntime(h.options)
    await runtime.deps.preflight?.(REQUEST, 'propose' as never)
    h.advance(IDLE - 10)
    await runtime.deps.preflight?.(REQUEST, 'propose' as never)
    h.advance(IDLE - 10)
    expect(h.startWatcher).toHaveBeenCalledTimes(1)
    expect(h.watchers[0].stop).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('after the idle stop, the focus read is unknown (null), never the last app seen', async () => {
    const h = harness()
    const { createCommandConfirmRuntime } = await import('./command-confirm-runtime')
    const runtime = createCommandConfirmRuntime(h.options)
    await runtime.deps.preflight?.(REQUEST, 'propose' as never)
    h.watchers[0].info = { windowId: 'com.example.old', pid: 5, title: 'Old' }
    expect(state.frontmost()).toEqual(h.watchers[0].info)
    h.advance(IDLE)
    expect(state.frontmost()).toBeNull() // a fresh watcher with no observation yet
    expect(h.startWatcher).toHaveBeenCalledTimes(2)
    runtime.dispose()
  })
})
