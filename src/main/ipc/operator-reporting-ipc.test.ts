import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ENTITLEMENT_IPC } from '@shared/entitlement-ipc'
import { registerOperatorReportingIpc, SIGNED_OUT_PLAN } from './operator-reporting-ipc'

type Handler = (event: unknown) => unknown

function register(over: { requireAuth?: () => boolean; assertMainWindow?: () => void } = {}) {
  const handlers = new Map<string, Handler>()
  const livePlan = { ...SIGNED_OUT_PLAN, state: 'checking' as const }
  const assertMainWindow = vi.fn(over.assertMainWindow ?? (() => undefined))
  registerOperatorReportingIpc({
    ipcMain: { handle: (channel: string, fn: Handler) => void handlers.set(channel, fn) } as never,
    assertMainWindow,
    snapshot: () => ({ status: 'off', origin: null, state: 'off' }),
    requireAuth: over.requireAuth ?? (() => true),
    planSnapshot: () => livePlan
  })
  return { handlers, assertMainWindow, livePlan }
}

describe('operator plan IPC (G79)', () => {
  it('plan channel asserts the main window', () => {
    const { handlers, assertMainWindow } = register({
      assertMainWindow: () => {
        throw new Error('not main window')
      }
    })
    expect(() => handlers.get(ENTITLEMENT_IPC.planGet)?.({})).toThrow('not main window')
    expect(assertMainWindow).toHaveBeenCalledTimes(1)
  })
  it('plan channel returns the plan for a signed-in window', () => {
    const { handlers, livePlan } = register()
    expect(handlers.get(ENTITLEMENT_IPC.planGet)?.({})).toBe(livePlan)
  })
  it('plan channel returns the signed-out plan when requireAuth is false', () => {
    const { handlers } = register({ requireAuth: () => false })
    expect(handlers.get(ENTITLEMENT_IPC.planGet)?.({})).toEqual({
      state: 'unmanaged',
      tier: null,
      lastKnownTier: null,
      entitlements: null,
      managedAi: false,
      meters: []
    })
  })
})

describe('capture independence (G79)', () => {
  it('no capture or listen module imports operator-meters', () => {
    const root = join(__dirname, '..', '..', '..')
    const dirs = ['src/main/cloud-stt', 'src/main/ipc', 'src/renderer/src/lib']
    const offenders: string[] = []
    for (const dir of dirs) {
      let names: string[] = []
      try {
        names = readdirSync(join(root, dir))
      } catch {
        continue
      }
      for (const name of names) {
        const isCapture = /^(cloud-speech|listen|capture)/.test(name) || dir.endsWith('cloud-stt')
        if (!isCapture || !/\.tsx?$/.test(name) || /\.test\./.test(name)) continue
        const text = readFileSync(join(root, dir, name), 'utf8')
        if (/operator-(meters|plan)/.test(text)) offenders.push(join(dir, name))
      }
    }
    expect(offenders).toEqual([])
  })
})
