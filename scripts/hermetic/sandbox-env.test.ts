import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_CREDENTIAL_KEYS,
  createHermeticSandbox,
  hermeticEnv,
  hermeticWranglerEnv,
  mergedEnv
} from './sandbox-env.mjs'

// W0-HERMETIC (M2-0190) — this module is what every non-vitest test runner (license-server's
// `node --test`, the scripts/qa harnesses, operator's wrangler-local-sandbox test) builds its own
// sandbox from, since none of them has a config-level env hook the way vitest.config.ts's `test.env`
// gives every vitest worker. These assertions are the single source of truth all of those consumers
// share — a regression here would silently reopen the sandbox everywhere at once.
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
  it('matches vitest.config.ts hermeticHomeEnv field-for-field', () => {
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
  it('strips every real Cloudflare credential key', () => {
    const env = hermeticWranglerEnv(createHermeticSandbox())
    for (const key of CLOUDFLARE_CREDENTIAL_KEYS) {
      expect(env[key]).toBeUndefined()
    }
  })

  it('sandboxes wrangler’s own config directory and turns off its telemetry call', () => {
    const sandbox = createHermeticSandbox()
    const env = hermeticWranglerEnv(sandbox)
    expect(env.XDG_CONFIG_HOME).toBe(join(sandbox.home, '.config'))
    expect(env.WRANGLER_SEND_METRICS).toBe('false')
    // Still gets the plain hermeticEnv fields — wrangler-specific isolation is additive, not a
    // separate, uncoordinated sandbox.
    expect(env.HOME).toBe(sandbox.home)
  })
})

describe('mergedEnv', () => {
  it('deletes a key from process.env when the override sets it to undefined', () => {
    const merged = mergedEnv({ CLOUDFLARE_API_TOKEN: undefined, HOME: '/sandbox' })
    expect(merged.HOME).toBe('/sandbox')
    expect('CLOUDFLARE_API_TOKEN' in merged).toBe(false)
  })

  it('never leaks the string "undefined" into the child env', () => {
    const merged = mergedEnv({ CLOUDFLARE_API_TOKEN: undefined })
    expect(merged.CLOUDFLARE_API_TOKEN).not.toBe('undefined')
  })
})
