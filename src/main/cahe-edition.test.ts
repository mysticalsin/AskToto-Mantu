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

  // MQA-168 — the env switch is a local test/build-harness affordance (see detectCaheEdition's doc
  // comment). Honored in a shipped build it would repoint userData, skip the rename migration, and —
  // permanently, while the variable is set — put the install on the blocked 'cahe' update channel, so a
  // user-writable `setx METIS_CAHE_EDITION 1` would silently end security updates.
  it('MQA-168 — ignores the METIS_CAHE_EDITION switch in a packaged build, which is identified by executable name', () => {
    expect(
      detectCaheEdition({
        platform: 'win32',
        packaged: true,
        executablePath: 'C:/Program Files/Metis/Metis.exe',
        environment: { METIS_CAHE_EDITION: '1' }
      })
    ).toBe(false)
    // The real shipped pilot is unaffected: it still identifies itself by executable name.
    expect(
      detectCaheEdition({
        platform: 'win32',
        packaged: true,
        executablePath: `C:/Program Files/${CAHE_APP_NAME}/${CAHE_EXECUTABLE_NAME}`,
        environment: { METIS_CAHE_EDITION: '1' }
      })
    ).toBe(true)
  })

  it('imposes no allowlist, locked keys, or managed defaults — same policy as a non-Cahê build', () => {
    // Kimi is still the out-of-box default (seeded once by cahe-embedded-key.ts's marker-gated first-run
    // seed via setSettings), but that is a plain user-layer default, not an edition-level lock: the pilot
    // user must be free to connect/switch to Claude Code CLI, Codex CLI, Dust, or any API-key provider,
    // and have that choice persist. A real IT-deployed managed-config.json is a separate mechanism
    // (validatedManaged()/getLockedKeys() in store.ts) and is untouched by this policy.
    expect(caheEditionPolicy(true)).toEqual({
      allowedProviders: null,
      lockedKeys: [],
      managedDefaults: {}
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
