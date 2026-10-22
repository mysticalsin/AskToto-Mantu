import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { createOsPermissionSeam, OS_REQUIREMENTS } from './os-permission-seam'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic title' } }
const OPEN_X: DesktopActionRequest = { id: 'desktop.open_x', args: {} }
const SHUTTER: DesktopActionRequest = { id: 'desktop.photo_booth_capture', args: {} }

function probes(overrides: { automation?: 'granted' | 'denied' | 'unknown'; accessibility?: boolean } = {}) {
  return {
    automationStatus: vi.fn(async () => overrides.automation ?? 'granted'),
    accessibilityTrusted: vi.fn(() => overrides.accessibility ?? true)
  }
}

describe('OS permission seam (G10 probes)', () => {
  it('names the OS permission each adapter needs, and none for plain opens', () => {
    expect(OS_REQUIREMENTS['desktop.create_note']).toEqual([{ kind: 'automation', bundleId: 'com.apple.Notes' }])
    expect(OS_REQUIREMENTS['desktop.photo_booth_capture']).toEqual([
      { kind: 'accessibility' },
      { kind: 'automation', bundleId: 'com.apple.systemevents' }
    ])
    expect(OS_REQUIREMENTS['desktop.open_x']).toBeUndefined()
  })

  it('reads the Notes Automation consent through the read-only probe and reports granted', async () => {
    const p = probes()
    const seam = createOsPermissionSeam({ platform: 'darwin', ...p })
    expect(await seam.check(NOTE)).toEqual({ status: 'granted' })
    expect(p.automationStatus).toHaveBeenCalledWith('com.apple.Notes')
  })

  it('a denied consent names the permission, never opens a prompt', async () => {
    const seam = createOsPermissionSeam({ platform: 'darwin', ...probes({ automation: 'denied' }) })
    expect(await seam.check(NOTE)).toEqual({ status: 'denied', permission: 'automation', target: 'Notes' })
  })

  it('an unreadable consent is unknown, never granted', async () => {
    const seam = createOsPermissionSeam({ platform: 'darwin', ...probes({ automation: 'unknown' }) })
    expect(await seam.check(NOTE)).toEqual({ status: 'unknown', permission: 'automation' })
  })

  it('a probe that throws or a missing probe reads as unknown', async () => {
    const throwing = createOsPermissionSeam({
      platform: 'darwin',
      automationStatus: async () => {
        throw new Error('helper crashed')
      },
      accessibilityTrusted: () => true
    })
    expect(await throwing.check(NOTE)).toEqual({ status: 'unknown', permission: 'automation' })
    const missing = createOsPermissionSeam({ platform: 'darwin' })
    expect(await missing.check(NOTE)).toEqual({ status: 'unknown', permission: 'automation' })
  })

  it('the camera shutter needs Accessibility first, then System Events Automation', async () => {
    const noAx = createOsPermissionSeam({ platform: 'darwin', ...probes({ accessibility: false }) })
    expect(await noAx.check(SHUTTER)).toEqual({
      status: 'denied',
      permission: 'accessibility',
      target: 'Accessibility'
    })
    const ok = createOsPermissionSeam({ platform: 'darwin', ...probes() })
    expect(await ok.check(SHUTTER)).toEqual({ status: 'granted' })
  })

  it('an action with no OS requirement is granted without probing', async () => {
    const p = probes({ automation: 'denied' })
    const seam = createOsPermissionSeam({ platform: 'darwin', ...p })
    expect(await seam.check(OPEN_X)).toEqual({ status: 'granted' })
    expect(p.automationStatus).not.toHaveBeenCalled()
  })

  it('Windows and Linux have no per-app consent: not required, no probe', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const p = probes({ automation: 'denied', accessibility: false })
      const seam = createOsPermissionSeam({ platform, ...p })
      expect(await seam.check(NOTE)).toEqual({ status: 'not-required' })
      expect(await seam.check(SHUTTER)).toEqual({ status: 'not-required' })
      expect(p.automationStatus).not.toHaveBeenCalled()
      expect(p.accessibilityTrusted).not.toHaveBeenCalled()
    }
  })
})
