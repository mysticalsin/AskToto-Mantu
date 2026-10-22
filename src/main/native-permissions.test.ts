import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' }, systemPreferences: {} }))
vi.mock('./logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

import { AUTOMATION_TARGET } from '@shared/permission-helper'
import {
  createElectronNativeDeps,
  isNativeKind,
  nativeHelperStatus,
  nativePermissionStatus,
  type NativePermissionDeps
} from './native-permissions'

function deps(over: Partial<NativePermissionDeps> = {}): NativePermissionDeps {
  return {
    platform: 'darwin',
    isAccessibilityTrusted: vi.fn(() => false),
    helperStatus: vi.fn(async () => 'denied' as const),
    ...over
  }
}

/** G10 — Accessibility, Input Monitoring and Automation: read-only probes that can never raise a TCC prompt. */
describe('isNativeKind', () => {
  it('accepts exactly the three native kinds', () => {
    for (const kind of ['accessibility', 'inputMonitoring', 'automation']) expect(isNativeKind(kind)).toBe(true)
    for (const kind of ['microphone', 'screenRecording', 'camera', '', undefined, null, 3]) {
      expect(isNativeKind(kind)).toBe(false)
    }
  })
})

describe('nativePermissionStatus', () => {
  it('Accessibility reads the in-process trust flag: granted or denied', async () => {
    const trusted = deps({ isAccessibilityTrusted: () => true })
    await expect(nativePermissionStatus('accessibility', trusted)).resolves.toBe('granted')
    await expect(nativePermissionStatus('accessibility', deps())).resolves.toBe('denied')
  })

  it('Input Monitoring asks the helper for the listen-event preflight; no helper reads as unknown', async () => {
    const granted = deps({ helperStatus: vi.fn(async () => 'granted' as const) })
    await expect(nativePermissionStatus('inputMonitoring', granted)).resolves.toBe('granted')
    expect(granted.helperStatus).toHaveBeenCalledWith('listen-event')
    await expect(nativePermissionStatus('inputMonitoring', deps({ helperStatus: async () => null }))).resolves.toBe(
      'unknown'
    )
  })

  it('Automation probes the one allowlisted target (System Events) and keeps unknown as unknown', async () => {
    const d = deps({ helperStatus: vi.fn(async () => 'unknown' as const) })
    await expect(nativePermissionStatus('automation', d)).resolves.toBe('unknown')
    expect(d.helperStatus).toHaveBeenCalledWith('automation', AUTOMATION_TARGET.bundleId)
    expect(AUTOMATION_TARGET.bundleId).toBe('com.apple.systemevents')
  })

  it('a probe that throws reads as unknown, never as granted', async () => {
    const boom = deps({
      helperStatus: async () => {
        throw new Error('helper gone')
      },
      isAccessibilityTrusted: () => {
        throw new Error('not macOS')
      }
    })
    for (const kind of ['accessibility', 'inputMonitoring', 'automation'] as const) {
      await expect(nativePermissionStatus(kind, boom)).resolves.toBe('unknown')
    }
  })

  it('Windows and Linux have no such consent: not-required, and no probe runs', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const d = deps({ platform })
      for (const kind of ['accessibility', 'inputMonitoring', 'automation'] as const) {
        await expect(nativePermissionStatus(kind, d)).resolves.toBe('not-required')
      }
      expect(d.isAccessibilityTrusted).not.toHaveBeenCalled()
      expect(d.helperStatus).not.toHaveBeenCalled()
    }
  })
})

describe('nativeHelperStatus — the restart edge', () => {
  it('Accessibility and Automation apply live once granted; Input Monitoring applies to the next launch', async () => {
    const granted = deps({ isAccessibilityTrusted: () => true, helperStatus: async () => 'granted' })
    await expect(nativeHelperStatus('accessibility', granted)).resolves.toEqual({ granted: true, needsRelaunch: false })
    await expect(nativeHelperStatus('automation', granted)).resolves.toEqual({ granted: true, needsRelaunch: false })
    await expect(nativeHelperStatus('inputMonitoring', granted)).resolves.toEqual({
      granted: true,
      needsRelaunch: true
    })
  })

  it('not granted is never a grant, whatever the relaunch edge', async () => {
    for (const kind of ['accessibility', 'inputMonitoring', 'automation'] as const) {
      expect((await nativeHelperStatus(kind, deps())).granted).toBe(false)
    }
  })
})

describe('createElectronNativeDeps — probing must never raise a system prompt', () => {
  it('calls isTrustedAccessibilityClient with the prompt flag false, on macOS only', () => {
    const isTrustedAccessibilityClient = vi.fn(() => true)
    const d = createElectronNativeDeps('darwin', { isTrustedAccessibilityClient })
    expect(d.isAccessibilityTrusted()).toBe(true)
    expect(isTrustedAccessibilityClient).toHaveBeenCalledTimes(1)
    expect(isTrustedAccessibilityClient).toHaveBeenCalledWith(false)
    expect(d.platform).toBe('darwin')
  })
})
