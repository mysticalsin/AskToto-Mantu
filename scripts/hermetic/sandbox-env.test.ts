import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHermeticSandbox, hermeticEnv, hermeticWranglerEnv, mergedEnv } from './sandbox-env.mjs'

// W0-HERMETIC (M2-0190) — this module is what every non-vitest runner that builds its sandbox here
// (license-server's `node --test`, operator's wrangler-local-sandbox test) builds it FROM, since neither
// has a config-level env hook the way vitest.config.ts's `test.env` gives every vitest worker. (scripts/qa
// checks whether the ATTACHED app is sandboxed instead — scripts/qa/lib/sandbox-guard.mjs — and swift
// test builds its own sandbox directly in run-swift-tests.sh; neither imports this file.) These
// assertions are the single source of truth every consumer above shares — a regression here would
// silently reopen the sandbox everywhere at once.
describe('createHermeticSandbox', () => {
  it('creates a fresh, empty, uniquely-prefixed home with its own tmp subdirectory', () => {
    const a = createHermeticSandbox()
    const b = createHermeticSandbox()
    expect(basename(a.home)).toMatch(/^metis-test-home-/)
    expect(a.home).not.toBe(b.home)
    expect(a.tmp).toBe(join(a.home, 'tmp'))
    expect(existsSync(a.tmp)).toBe(true)
    expect(existsSync(join(a.home, 'Library', 'CloudStorage'))).toBe(false)
  })
})

describe('hermeticEnv', () => {
  it('produces the env vitest.config.ts builds its own hermeticHomeEnv from (the single shared implementation)', () => {
    const sandbox = createHermeticSandbox()
    const env = hermeticEnv(sandbox)
    expect(env.HOME).toBe(sandbox.home)
    expect(env.USERPROFILE).toBe(sandbox.home)
    expect(env.OneDrive).toBe('')
    expect(env.OneDriveCommercial).toBe('')
    expect(env.OneDriveConsumer).toBe('')
    expect(env.TMPDIR).toBe(sandbox.tmp)
    expect(env.TMP).toBe(sandbox.tmp)
    expect(env.TEMP).toBe(sandbox.tmp)
    expect(env.METIS_TEST_HOME).toBe(sandbox.home)
    expect(env.ASKTOTO_TEST_SANDBOX_ROOT).toBe(sandbox.home)
  })

  it('lets extra fields override the defaults', () => {
    const sandbox = createHermeticSandbox()
    const env = hermeticEnv(sandbox, { HOME: '/somewhere-else' })
    expect(env.HOME).toBe('/somewhere-else')
  })
})

describe('hermeticWranglerEnv', () => {
  // Covers wrangler 4.131.1's deprecated aliases (CF_API_TOKEN, CF_API_KEY, CF_EMAIL, CF_ACCOUNT_ID) and
  // WRANGLER_CF_AUTHORIZATION_TOKEN, not just the current CLOUDFLARE_* names — proving the strip is a
  // prefix match, not a name list that could miss the next one. Seeding a fake `inheritedEnv` (never the
  // real `process.env`) is what lets this prove the strip without mutating the actual process environment
  // other tests in this same worker run under.
  it('strips every inherited CLOUDFLARE_/CF_/WRANGLER_-prefixed credential, including the deprecated aliases', () => {
    const inheritedEnv = {
      CLOUDFLARE_API_TOKEN: 'real-token',
      CLOUDFLARE_ACCOUNT_ID: 'real-account',
      CF_API_TOKEN: 'real-legacy-token',
      CF_API_KEY: 'real-legacy-key',
      CF_EMAIL: 'real@example.com',
      CF_ACCOUNT_ID: 'real-legacy-account',
      WRANGLER_CF_AUTHORIZATION_TOKEN: 'real-authz'
    }
    const env = hermeticWranglerEnv(createHermeticSandbox(), inheritedEnv)
    for (const key of Object.keys(inheritedEnv)) {
      expect(env[key]).toBeUndefined()
    }
    // The seeded object itself must come back untouched — proves the function doesn't mutate its input,
    // which a caller passing its own live `process.env` copy would otherwise rely on.
    expect(inheritedEnv.CLOUDFLARE_API_TOKEN).toBe('real-token')
  })

  it('keeps the OAuth keyring off even when the inherited env opts in', () => {
    const env = hermeticWranglerEnv(createHermeticSandbox(), { CLOUDFLARE_AUTH_USE_KEYRING: 'true' })
    expect(env.CLOUDFLARE_AUTH_USE_KEYRING).toBe('false')
  })

  it('keeps its own metrics/banner/keyring choices even when the inherited env sets them under a stripped prefix', () => {
    const env = hermeticWranglerEnv(createHermeticSandbox(), {
      WRANGLER_SEND_METRICS: 'true',
      WRANGLER_HIDE_BANNER: 'false'
    })
    expect(env.WRANGLER_SEND_METRICS).toBe('false')
    expect(env.WRANGLER_HIDE_BANNER).toBe('true')
  })

  it('sandboxes wrangler’s own config directory and turns off its telemetry call and update check', () => {
    const sandbox = createHermeticSandbox()
    const env = hermeticWranglerEnv(sandbox, {})
    expect(env.XDG_CONFIG_HOME).toBe(join(sandbox.home, '.config'))
    expect(env.WRANGLER_SEND_METRICS).toBe('false')
    // Without this, every wrangler command's printWranglerBanner() awaits an npm-registry GET for the
    // latest version before --local's own work starts — a real non-loopback connect(), not a telemetry
    // side effect WRANGLER_SEND_METRICS covers.
    expect(env.WRANGLER_HIDE_BANNER).toBe('true')
    // Still gets the plain hermeticEnv fields — wrangler-specific isolation is additive, not a
    // separate, uncoordinated sandbox.
    expect(env.HOME).toBe(sandbox.home)
  })

  describe('default inheritedEnv (process.env)', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('strips a real credential from process.env when the caller passes no inheritedEnv', () => {
      vi.stubEnv('CF_API_TOKEN', 'real-token-from-the-actual-shell')
      const sandbox = createHermeticSandbox()
      const env = hermeticWranglerEnv(sandbox)
      expect(env.HOME).toBe(sandbox.home)
      expect(env.CF_API_TOKEN).toBeUndefined()
    })
  })
})

describe('mergedEnv', () => {
  it('deletes a key from process.env when the override sets it to undefined, never as the literal string "undefined"', () => {
    const merged = mergedEnv({ CLOUDFLARE_API_TOKEN: undefined, HOME: '/sandbox' })
    expect(merged.HOME).toBe('/sandbox')
    expect('CLOUDFLARE_API_TOKEN' in merged).toBe(false)
  })
})
