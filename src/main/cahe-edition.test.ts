import { describe, expect, it, vi } from 'vitest'

vi.mock('electron')

import {
  CAHE_APP_NAME,
  CAHE_EXECUTABLE_NAME,
  caheEditionPolicy,
  detectCaheEdition,
  shouldDisableAutoUpdate
} from './cahe-edition'

describe('Cahê Windows edition', () => {
  it('activates only for the explicit test flag or the packaged Cahê executable', () => {
    expect(
      detectCaheEdition({
        platform: 'win32',
        packaged: true,
        executablePath: `C:\\Program Files\\${CAHE_APP_NAME}\\${CAHE_EXECUTABLE_NAME}`,
        environment: {}
      })
    ).toBe(true)
    expect(
      detectCaheEdition({
        platform: 'darwin',
        packaged: true,
        executablePath: `/Applications/${CAHE_APP_NAME}.app/Contents/MacOS/Metis`,
        environment: {}
      })
    ).toBe(false)
    expect(
      detectCaheEdition({
        platform: 'win32',
        packaged: false,
        executablePath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
        environment: {}
      })
    ).toBe(false)
    expect(
      detectCaheEdition({
        platform: 'darwin',
        packaged: false,
        executablePath: '/tmp/electron',
        environment: { METIS_CAHE_EDITION: '1' }
      })
    ).toBe(true)
  })

  it('keeps Kimi active while allowing the Dust connection workflow', () => {
    expect(caheEditionPolicy(true)).toEqual({
      allowedProviders: ['kimi', 'dust'],
      lockedKeys: ['provider', 'providerPriority'],
      managedDefaults: { provider: 'kimi', providerPriority: 'api' }
    })
    expect(caheEditionPolicy(false)).toEqual({
      allowedProviders: null,
      lockedKeys: [],
      managedDefaults: {}
    })
  })

  it('disables the shared updater only for Cahê', () => {
    expect(shouldDisableAutoUpdate(true)).toBe(true)
    expect(shouldDisableAutoUpdate(false)).toBe(false)
  })
})
