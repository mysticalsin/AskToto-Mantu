import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BaseSettingsSchema } from '@shared/ipc'

/**
 * managed-config-example.contract.test.ts
 *
 * build/managed-config.example.json is what IT copies to deploy policy, so it is documentation that
 * gets executed by a fleet. Documentation drifts; a policy file that names a key the app no longer
 * reads fails silently — the fleet keeps running unmanaged with no error, which is the worst shape a
 * configuration mistake can take.
 *
 * So every settings key in the sample is checked against the real schema, in both directions: the key
 * must exist, and its example value must parse. Governance keys are not user settings and are listed
 * explicitly rather than skipped by pattern, so adding a new one is a deliberate act.
 */
const GOVERNANCE_KEYS = new Set([
  'locked',
  // Each of these is read straight out of the managed config by a specific module, never through the
  // settings store, so it is correct for them to be absent from BaseSettingsSchema. Cited so that a
  // future addition here has to be justified the same way rather than waved through.
  'allowedProviders', //   store.ts / net/egress-policy.ts
  'egressAllowlist', //    net/egress-policy.ts
  'updateFeedUrl', //      updater.ts
  'disableAutoUpdate', //  updater.ts (admin/machine policy only)
  'requireAuth', //        listening-state-ipc.ts, screen-preprocess.ts
  'escrowPubKey', //       transcript escrow
  'licenseServerUrl'
])
function sample(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, '..', '..', 'build', name), 'utf8'))
}

describe('the managed-config samples only name keys the app actually reads', () => {
  for (const file of ['managed-config.example.json', 'managed-config.enterprise.example.json']) {
    it(`${file}: every settings key exists in the schema and its value parses`, () => {
      const cfg = sample(file)
      const shape = BaseSettingsSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>
      for (const [key, value] of Object.entries(cfg)) {
        if (key.startsWith('_') || GOVERNANCE_KEYS.has(key)) continue
        expect(shape[key], `${file} presets "${key}", which is not a settings key`).toBeDefined()
        expect(
          shape[key].safeParse(value).success,
          `${file} presets ${key}=${JSON.stringify(value)}, which the schema rejects`
        ).toBe(true)
      }
    })

    it(`${file}: every locked key is a real settings key`, () => {
      const cfg = sample(file)
      const locked = (cfg.locked as string[] | undefined) ?? []
      const shape = BaseSettingsSchema.shape as Record<string, unknown>
      for (const key of locked) {
        expect(shape[key], `${file} locks "${key}", which is not a settings key`).toBeDefined()
      }
    })
  }
})

describe('the dock is discoverable to whoever deploys policy', () => {
  it('the sample names the overlay keys, since a lockable key nobody knows about is not deployable', () => {
    const cfg = sample('managed-config.example.json')
    expect(cfg.overlayPlacement).toBeDefined()
    expect(cfg.overlayLayout).toBeDefined()
    expect(cfg.dockRest).toBeDefined()
  })

  it('and explains the one combination that cannot be built', () => {
    // A full bar is an 880-wide horizontal strip; "bar on the right edge" is not a placement.
    const cfg = sample('managed-config.example.json')
    expect(String(cfg._comment_overlay)).toMatch(/right edge/i)
    expect(String(cfg._comment_overlay)).toMatch(/never with 'bar'/)
  })
})
