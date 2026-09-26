// Runs the REAL app-builder-lib config loader/validator (not a reimplementation) against overlays
// built by buildWindowsSigningOverlay, proving what integration-design.md §2.2 claims from a one-off
// local run: the overlay resolves, and apart from the signing keys it adds, the resolved config is
// identical to loading electron-builder.win.yml directly — so the base `files` allow-list, targets,
// publish repo, etc. are never disturbed by a signing-mode change.
//
// scripts/lib/windows-signing-mode.mjs (lane 1) now exists in this worktree, so this imports it
// directly rather than a local fixture overlay.
import { createRequire } from 'node:module'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildWindowsSigningOverlay, resolveWindowsSigningMode } from './lib/windows-signing-mode.mjs'

const ROOT = resolve(__dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))
const { Lazy } = require('lazy-val')
const { DebugLogger } = require('builder-util')
const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
const { readPackageJson } = require('app-builder-lib/out/util/packageMetadata.js')

const BASE_CONFIG_PATH = join(ROOT, 'electron-builder.win.yml')
const SIGN_HOOK_PATH = join(ROOT, 'scripts', 'azure-sign-hook.cjs')

const overlayFiles: string[] = []
afterEach(() => {
  for (const file of overlayFiles.splice(0)) rmSync(file, { force: true })
})

async function resolveOverlayConfig(overlay: unknown) {
  const overlayPath = join(tmpdir(), `windows-signing-contract-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  overlayFiles.push(overlayPath)
  writeFileSync(overlayPath, JSON.stringify(overlay))
  const devMetadata = await readPackageJson(join(ROOT, 'package.json'))
  const config = await getConfig(ROOT, overlayPath, null, new Lazy(() => Promise.resolve(devMetadata)))
  await validateConfiguration(config, new DebugLogger(false))
  return config as Record<string, any>
}

async function resolveBaseConfig() {
  const devMetadata = await readPackageJson(join(ROOT, 'package.json'))
  const config = await getConfig(ROOT, BASE_CONFIG_PATH, null, new Lazy(() => Promise.resolve(devMetadata)))
  await validateConfiguration(config, new DebugLogger(false))
  return config as Record<string, any>
}

const AZURE_ENV = {
  GH_TOKEN: 'test-token',
  WIN_SIGNING_MODE: 'azure',
  WIN_AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
  WIN_AZURE_SIGNING_ACCOUNT: 'test-account',
  WIN_AZURE_CERT_PROFILE: 'test-profile',
  WIN_AZURE_PUBLISHER_NAME: 'MANTU GROUP SA',
  WIN_CSC_EXPECTED_SUBJECT: 'MANTU GROUP SA'
}

const PFX_ENV = {
  GH_TOKEN: 'test-token',
  WIN_SIGNING_MODE: 'pfx',
  WIN_CSC_LINK: 'synthetic-base64-fixture==',
  WIN_CSC_KEY_PASSWORD: 'synthetic-password',
  WIN_CSC_EXPECTED_SUBJECT: 'CN=Mantu'
}

describe('windows-signing-config.contract: azure mode overlay', () => {
  it('resolves to a VALID electron-builder config, identical to electron-builder.win.yml apart from the signing keys it adds', async () => {
    const resolved = resolveWindowsSigningMode(AZURE_ENV)
    expect(resolved.ok).toBe(true)
    const overlay = buildWindowsSigningOverlay(resolved, { baseConfigPath: BASE_CONFIG_PATH, signHookPath: SIGN_HOOK_PATH })
    expect(overlay).toMatchObject({
      extends: BASE_CONFIG_PATH,
      forceCodeSigning: true,
      win: { signtoolOptions: { sign: SIGN_HOOK_PATH, signingHashAlgorithms: ['sha256'], publisherName: ['MANTU GROUP SA'] } },
      publish: { publisherName: ['MANTU GROUP SA'] }
    })

    const [overlayConfig, baseConfig] = await Promise.all([resolveOverlayConfig(overlay), resolveBaseConfig()])

    expect(overlayConfig.forceCodeSigning).toBe(true)
    expect(overlayConfig.win.signtoolOptions).toEqual({
      sign: SIGN_HOOK_PATH, signingHashAlgorithms: ['sha256'], publisherName: ['MANTU GROUP SA']
    })
    expect(overlayConfig.publish).toMatchObject({ publisherName: ['MANTU GROUP SA'] })
    expect(overlayConfig.win.azureSignOptions).toBeUndefined()

    // Strip exactly the keys the overlay is documented to add, then the rest must be untouched: same
    // productName, executableName, files allow-list, targets, publish repo/owner. `extends` is also
    // expected to differ — it is the loader's own provenance of the immediate parent file (the
    // overlay's parent is electron-builder.win.yml itself; win.yml's own parent is electron-builder.yml)
    // — not a signing key, and not something either config resolution "carries" from the app.
    const { forceCodeSigning, extends: overlayExtends, win: overlayWin, publish: overlayPublish, ...overlayRest } = overlayConfig
    const { extends: baseExtends, win: baseWin, publish: basePublish, ...baseRest } = baseConfig
    const { signtoolOptions, ...overlayWinRest } = overlayWin
    const { publisherName, ...overlayPublishRest } = overlayPublish
    expect(overlayWinRest).toEqual(baseWin)
    expect(overlayPublishRest).toEqual(basePublish)
    expect(overlayRest).toEqual(baseRest)
  })
})

describe('windows-signing-config.contract: pfx mode overlay', () => {
  it('resolves to a VALID config with no signtoolOptions.sign hook, and no publish.publisherName by default', async () => {
    const resolved = resolveWindowsSigningMode(PFX_ENV)
    expect(resolved.ok).toBe(true)
    const overlay = buildWindowsSigningOverlay(resolved, { baseConfigPath: BASE_CONFIG_PATH, signHookPath: SIGN_HOOK_PATH })
    expect(overlay).toEqual({ extends: BASE_CONFIG_PATH, forceCodeSigning: true, win: {} })

    const [overlayConfig, baseConfig] = await Promise.all([resolveOverlayConfig(overlay), resolveBaseConfig()])
    expect(overlayConfig.forceCodeSigning).toBe(true)
    expect(overlayConfig.win.signtoolOptions).toBeUndefined()
    expect(overlayConfig.win.azureSignOptions).toBeUndefined()
    expect(overlayConfig.publish).toEqual(baseConfig.publish)

    // `extends` is expected to differ (see the azure-mode test above for why); it names the immediate
    // parent file, not an app setting.
    const { forceCodeSigning, extends: overlayExtends, ...overlayRest } = overlayConfig
    const { extends: baseExtends, ...baseRest } = baseConfig
    expect(overlayRest).toEqual(baseRest)
  })

  it('adds the transitional publish.publisherName list only when WIN_UPDATE_PUBLISHER_NAMES is set, unioned with the base', async () => {
    const env = { ...PFX_ENV, WIN_UPDATE_PUBLISHER_NAMES: JSON.stringify(['Mantu', 'MANTU GROUP SA']) }
    const resolved = resolveWindowsSigningMode(env)
    expect(resolved.ok).toBe(true)
    const overlay = buildWindowsSigningOverlay(resolved, { baseConfigPath: BASE_CONFIG_PATH, signHookPath: SIGN_HOOK_PATH })
    expect(overlay.publish).toEqual({ publisherName: ['Mantu', 'MANTU GROUP SA'] })

    const overlayConfig = await resolveOverlayConfig(overlay)
    expect(overlayConfig.publish).toMatchObject({ publisherName: ['Mantu', 'MANTU GROUP SA'] })
    expect(overlayConfig.win.signtoolOptions).toBeUndefined()
  })
})

describe('windows-signing-config.contract: why the pin routes through signtoolOptions/publish, not azureSignOptions', () => {
  it('rejects azureSignOptions.publisherName as an array (schema allows only a single string there)', async () => {
    await expect(
      resolveOverlayConfig({
        extends: BASE_CONFIG_PATH,
        win: {
          azureSignOptions: {
            endpoint: 'https://weu.codesigning.azure.net',
            codeSigningAccountName: 'acct',
            certificateProfileName: 'profile',
            publisherName: ['MANTU GROUP SA', 'Mantu']
          }
        }
      })
    ).rejects.toThrow()
  })

  it('rejects a literal win.publisherName (removed from the schema; the CN is derived from the signer)', async () => {
    await expect(
      resolveOverlayConfig({ extends: BASE_CONFIG_PATH, win: { publisherName: 'CN=Mantu' } })
    ).rejects.toThrow()
  })

  it('accepts win.signtoolOptions.publisherName as an array, and publish.publisherName as an array', async () => {
    const config = await resolveOverlayConfig({
      extends: BASE_CONFIG_PATH,
      win: { signtoolOptions: { sign: SIGN_HOOK_PATH, publisherName: ['MANTU GROUP SA', 'Mantu'] } },
      publish: { publisherName: ['MANTU GROUP SA', 'Mantu'] }
    })
    expect(config.win.signtoolOptions.publisherName).toEqual(['MANTU GROUP SA', 'Mantu'])
  })
})

describe('windows-signing-config.contract: no identity or Azure native-option literal in the checked-in config', () => {
  it.each(['electron-builder.yml', 'electron-builder.win.yml', 'electron-builder.cahe.win.yml'])(
    '%s never hardcodes azureSignOptions or a publisherName literal',
    (file) => {
      const source = readFileSync(join(ROOT, file), 'utf8')
      expect(source).not.toMatch(/azureSignOptions\s*:/)
      expect(source).not.toMatch(/publisherName\s*:/)
      expect(source).not.toContain('MANTU GROUP SA')
    }
  )
})
