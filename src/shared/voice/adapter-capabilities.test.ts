import { describe, expect, it } from 'vitest'
import { DESKTOP_ADAPTER_IDS } from '../desktop-actions'
import { classifyDesktopRequest } from './catalog'
import {
  ADAPTER_CAPABILITIES,
  adapterNeedsForeground,
  capabilityFor,
  validateAdapterCapabilities,
  type AdapterCapability
} from './adapter-capabilities'

describe('adapter capability declarations (G40)', () => {
  it('declares every catalog adapter id and nothing else, and passes the startup validation', () => {
    expect(Object.keys(ADAPTER_CAPABILITIES).sort()).toEqual([...DESKTOP_ADAPTER_IDS].sort())
    expect(validateAdapterCapabilities()).toEqual([])
  })

  it('supports exactly the platforms the catalog can run the action on', () => {
    for (const id of DESKTOP_ADAPTER_IDS) {
      for (const platform of ['darwin', 'win32'] as const) {
        const runnable = classifyDesktopRequest({ id, args: {} } as never, platform) !== null
        expect(capabilityFor(id, platform) !== null, `${id} on ${platform}`).toBe(runnable)
      }
    }
  })

  it('marks only an action that synthesizes input into another app as foreground-only', () => {
    expect(adapterNeedsForeground('desktop.photo_booth_capture', 'darwin')).toBe(true)
    expect(capabilityFor('desktop.photo_booth_capture', 'darwin')?.permissions).toContain('accessibility')
    for (const id of DESKTOP_ADAPTER_IDS) {
      if (id === 'desktop.photo_booth_capture') continue
      expect(adapterNeedsForeground(id, 'darwin'), id).toBe(false)
    }
    // Windows only opens Camera: nothing is driven.
    expect(adapterNeedsForeground('desktop.photo_booth_capture', 'win32')).toBe(false)
  })

  it('fails closed for an id without a declaration', () => {
    expect(adapterNeedsForeground('desktop.not_declared' as never, 'darwin')).toBe(true)
  })

  it('reports a missing, extra or inconsistent declaration', () => {
    const missing = { ...ADAPTER_CAPABILITIES } as Record<string, AdapterCapability>
    delete missing['desktop.open_x']
    expect(validateAdapterCapabilities(DESKTOP_ADAPTER_IDS, missing as never).join('\n')).toContain('desktop.open_x')

    const extra = { ...ADAPTER_CAPABILITIES, 'desktop.ghost': ADAPTER_CAPABILITIES['desktop.open_x'] }
    expect(validateAdapterCapabilities(DESKTOP_ADAPTER_IDS, extra as never).join('\n')).toContain('desktop.ghost')

    const noInputPermission: Record<string, AdapterCapability> = {
      ...ADAPTER_CAPABILITIES,
      'desktop.photo_booth_capture': {
        resources: ['app:photo-booth'],
        platforms: { darwin: { mode: 'foreground-only', permissions: [] } }
      }
    }
    expect(validateAdapterCapabilities(DESKTOP_ADAPTER_IDS, noInputPermission as never).join('\n')).toMatch(
      /photo_booth_capture.*accessibility/
    )
  })
})
