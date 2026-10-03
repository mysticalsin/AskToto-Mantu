import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { Settings } from '@shared/ipc'
import type { StorageGateway } from '../infra/storage/gateway'
import { createAppContext, type AppContextDeps } from './context'

function fakeWindow(destroyed = false): BrowserWindow {
  return { isDestroyed: () => destroyed } as unknown as BrowserWindow
}

function deps(overrides: Partial<AppContextDeps> = {}): AppContextDeps {
  return {
    mainWindow: () => null,
    settings: { get: () => ({}) as Settings, set: () => ({}) as Settings },
    audit: vi.fn(),
    supervisor: { stopAll: vi.fn() },
    gateway: () => ({}) as StorageGateway,
    scheduler: { runAsMaintenance: (work) => Promise.resolve(work()) },
    clock: { now: () => 0 },
    ...overrides
  }
}

describe('createAppContext', () => {
  it('reads the main window on every call, so a window created or replaced after construction is seen', () => {
    let win: BrowserWindow | null = null
    const ctx = createAppContext(deps({ mainWindow: () => win }))
    expect(ctx.mainWindow()).toBeNull()

    const first = fakeWindow()
    win = first
    expect(ctx.mainWindow()).toBe(first)

    const second = fakeWindow()
    win = second
    expect(ctx.mainWindow()).toBe(second)
  })

  it('liveMainWindow is null before creation and once the window is destroyed', () => {
    let win: BrowserWindow | null = null
    const ctx = createAppContext(deps({ mainWindow: () => win }))
    expect(ctx.liveMainWindow()).toBeNull()

    win = fakeWindow()
    expect(ctx.liveMainWindow()).toBe(win)

    win = fakeWindow(true)
    expect(ctx.liveMainWindow()).toBeNull()
  })

  it('routes settings, audit, supervisor, gateway, scheduler and clock to the services it was built with', async () => {
    const settings = { theme: 'dark' } as unknown as Settings
    const get = vi.fn(() => settings)
    const set = vi.fn(() => settings)
    const audit = vi.fn()
    const stopAll = vi.fn()
    const gateway = {} as StorageGateway
    let maintenanceRuns = 0
    const runAsMaintenance = async <T,>(work: () => T | Promise<T>): Promise<T> => {
      maintenanceRuns += 1
      return work()
    }
    const ctx = createAppContext(
      deps({
        settings: { get, set },
        audit,
        supervisor: { stopAll },
        gateway: () => gateway,
        scheduler: { runAsMaintenance },
        clock: { now: () => 1234 }
      })
    )

    expect(ctx.settings.get()).toBe(settings)
    ctx.settings.set({ onboarded: true } as Partial<Settings>)
    expect(set).toHaveBeenCalledWith({ onboarded: true })
    ctx.audit('security.ipc_denied', { reason: 'sender' })
    expect(audit).toHaveBeenCalledWith('security.ipc_denied', { reason: 'sender' })
    ctx.supervisor.stopAll()
    expect(stopAll).toHaveBeenCalledTimes(1)
    expect(ctx.gateway()).toBe(gateway)
    await expect(ctx.scheduler.runAsMaintenance(() => 7)).resolves.toBe(7)
    expect(maintenanceRuns).toBe(1)
    expect(ctx.clock.now()).toBe(1234)
  })

  it('is a plain frozen object: consumers cannot swap a service out from under each other', () => {
    const ctx = createAppContext(deps())
    expect(Object.isFrozen(ctx)).toBe(true)
    expect(Object.isFrozen(ctx.settings)).toBe(true)
    expect(Object.isFrozen(ctx.supervisor)).toBe(true)
    expect(Object.isFrozen(ctx.scheduler)).toBe(true)
    expect(Object.isFrozen(ctx.clock)).toBe(true)
  })
})
