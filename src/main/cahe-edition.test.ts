import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron')

import { app } from 'electron'
import {
  CAHE_APP_NAME,
  CAHE_DISPLAY_NAME,
  CAHE_EXECUTABLE_NAME,
  caheEditionPolicy,
  detectCaheEdition,
  initializeCaheEditionIdentity,
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

  // Regression coverage for the asr-model:// / "every fetch fails" root cause: Electron derives its
  // auto-generated default User-Agent from app.getName(), and the accented CAHE_DISPLAY_NAME corrupts
  // that auto-generation deep inside Electron's own protocol.handle request bridge (see
  // initializeCaheEditionIdentity's doc comment). The fix must read+rewrite userAgentFallback BEFORE
  // calling setName, so the frozen value is captured while app.getName() is still ASCII.
  describe('initializeCaheEditionIdentity — User-Agent freeze ordering', () => {
    afterEach(() => {
      delete process.env.METIS_CAHE_EDITION
      delete (app as { userAgentFallback?: string }).userAgentFallback
      vi.restoreAllMocks()
    })

    it('reads and rewrites userAgentFallback before renaming the app to the accented display name', () => {
      process.env.METIS_CAHE_EDITION = '1'
      const calls: string[] = []
      let ua = 'Mozilla/5.0 asktoto/1.0.6' // stand-in for Electron's ASCII, pre-rename default
      Object.defineProperty(app, 'userAgentFallback', {
        configurable: true,
        get() {
          calls.push(`get-ua:${ua}`)
          return ua
        },
        set(value: string) {
          calls.push(`set-ua:${value}`)
          ua = value
        }
      })
      app.setName = ((name: string) => { calls.push(`setName:${name}`) }) as typeof app.setName
      app.getPath = (() => 'C:\\Users\\qa\\AppData\\Roaming') as typeof app.getPath
      app.setPath = (() => { calls.push('setPath') }) as typeof app.setPath

      initializeCaheEditionIdentity()

      // The freeze must happen strictly before the rename: get-ua and set-ua (with the SAME,
      // still-ASCII value — a true freeze, not a new value) both precede setName.
      expect(calls).toEqual(['get-ua:Mozilla/5.0 asktoto/1.0.6', 'set-ua:Mozilla/5.0 asktoto/1.0.6', `setName:${CAHE_DISPLAY_NAME}`, 'setPath'])
    })
  })
})
