/**
 * managed-config-docs.test.ts — M2-0459.
 *
 * The two public managed-config examples and the docs under docs/ may only present controls the app
 * enforces. Each check is a pure function over text, so a fixture per branch proves the check fires; the
 * real examples and docs are then run through the same functions.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/ipc'

const REPO = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')

/**
 * Top-level managed-config keys that are read straight from the policy file and are NOT Settings keys.
 * Every entry names the code that reads it.
 */
const GOVERNANCE_KEYS: Record<string, string> = {
  locked: 'src/main/store.ts (getLockedKeys: `obj.locked ?? obj.lockedKeys`)',
  requireAuth: 'src/main/auth.ts (authEnforced: `requireAuth === true`)',
  allowedProviders: 'src/main/store.ts (allowedProvidersFromText)',
  escrowPubKey: 'src/main/transcripts.ts (escrow key parse from managed-config text)',
  disableAutoUpdate: 'src/main/updater.ts (`disableAutoUpdate === true`)',
  updateFeedUrl: 'src/main/updater.ts (admin-policy feed override)',
  egressAllowlist: 'src/main/net/egress-policy.ts (`egressAllowlist` host list)'
}

const EXAMPLES = ['build/managed-config.example.json', 'build/managed-config.enterprise.example.json']

/**
 * Device licensing is compiled off (LICENSE_ENFORCEMENT and LICENSE_UI_ENABLED). The licensing drift
 * contract test reads those constants and fails when they change, so the tickets that re-enable
 * enforcement flip this value together with the examples and docs.
 */
const enforcementCompiledOff = true

/** `_comment*` keys are prose, not policy. */
const policyKeys = (json: string): string[] =>
  Object.keys(JSON.parse(json) as Record<string, unknown>).filter((k) => !k.startsWith('_comment'))

/** Keys that are neither Settings keys nor listed governance keys. */
function unknownKeys(json: string, settingsKeys: readonly string[], governance: readonly string[]): string[] {
  return policyKeys(json).filter((k) => !settingsKeys.includes(k) && !governance.includes(k))
}

/** Does the example set (or lock) licenseGateEnabled? */
function setsLicenseGate(json: string): boolean {
  const obj = JSON.parse(json) as { locked?: unknown }
  const locked = Array.isArray(obj.locked) ? obj.locked : []
  return policyKeys(json).includes('licenseGateEnabled') || locked.includes('licenseGateEnabled')
}

/** Lines of a doc that present the license gate as an enabled/lockable/enforced control. */
function licenseGateClaims(md: string): string[] {
  return md.split('\n').filter((line) => {
    if (!/license gate/i.test(line)) return false
    if (/compiled off/i.test(line)) return false
    const bareBullet = /^\s*[-*]\s*license gate\.?\s*$/i.test(line)
    const listedAsControl = /managed[- ]config|policy controls|\block/i.test(line)
    return bareBullet || listedAsControl
  })
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return markdownFiles(full)
    return name.endsWith('.md') ? [full] : []
  })
}

const settingsKeys = Object.keys(DEFAULT_SETTINGS)
const governanceKeys = Object.keys(GOVERNANCE_KEYS)

describe('managed-config check functions fire on a bad fixture', () => {
  it('flags a key that is neither a Settings key nor a governance key', () => {
    const fixture = JSON.stringify({ provider: 'dust', notARealKey: true, _comment: 'x' })
    expect(unknownKeys(fixture, settingsKeys, governanceKeys)).toEqual(['notARealKey'])
  })

  it('accepts a governance key only through the explicit list', () => {
    const fixture = JSON.stringify({ egressAllowlist: [] })
    expect(unknownKeys(fixture, settingsKeys, [])).toEqual(['egressAllowlist'])
    expect(unknownKeys(fixture, settingsKeys, governanceKeys)).toEqual([])
  })

  it('flags licenseGateEnabled whether set or only locked', () => {
    expect(setsLicenseGate(JSON.stringify({ licenseGateEnabled: true }))).toBe(true)
    expect(setsLicenseGate(JSON.stringify({ locked: ['licenseGateEnabled'] }))).toBe(true)
    expect(setsLicenseGate(JSON.stringify({ locked: ['provider'], _comment_license: 'licenseGateEnabled' }))).toBe(false)
  })

  it('flags a doc that lists the license gate as an enforced control', () => {
    expect(licenseGateClaims('It enables and locks:\n\n- Azure SSO.\n- License gate.\n')).toHaveLength(1)
    expect(licenseGateClaims('Managed config can lock SSO, license gate, and retention.')).toHaveLength(1)
    expect(licenseGateClaims('The license gate is compiled off until the licensing tickets land.')).toHaveLength(0)
  })

  it('the governance list documents where every key is read', () => {
    for (const [key, ref] of Object.entries(GOVERNANCE_KEYS)) expect(ref, key).toMatch(/^src\//)
  })
})

describe('the shipped examples and docs list only enforced controls', () => {
  for (const rel of EXAMPLES) {
    it(`${rel} sets only Settings keys or listed governance keys`, () => {
      expect(unknownKeys(read(rel), settingsKeys, governanceKeys)).toEqual([])
    })

    it(`${rel} does not set licenseGateEnabled while enforcement is compiled off`, () => {
      if (enforcementCompiledOff) expect(setsLicenseGate(read(rel))).toBe(false)
    })

    it(`${rel} locks only keys it can enforce`, () => {
      const locked = (JSON.parse(read(rel)) as { locked?: string[] }).locked ?? []
      const known = [...settingsKeys, ...governanceKeys]
      expect(locked.filter((k) => !known.includes(k))).toEqual([])
    })

    it(`${rel} names only the single Windows admin path`, () => {
      expect(read(rel)).not.toMatch(/ProgramData%?\\+AskToto/i)
    })
  }

  it('the enterprise example uses a reserved example domain and placeholder tenant ids', () => {
    const policy = JSON.parse(read('build/managed-config.enterprise.example.json')) as Record<string, string>
    expect(policy.azureAllowedDomain).toMatch(/(^|\.)example\.(com|org|net)$/)
    expect(policy.azureTenantId).toMatch(/^REPLACE-WITH-/)
    expect(policy.azureClientId).toMatch(/^REPLACE-WITH-/)
  })

  it('the managed-config docs name the accented Métis path and never a supported AskToto path', () => {
    for (const rel of ['docs/SIGNING.md', 'docs/ENTERPRISE_RELEASE.md', 'docs/ENTERPRISE-DEPLOY-WINDOWS.md']) {
      expect(read(rel), rel).toContain('%ProgramData%\\Métis\\managed-config.json')
    }
    for (const rel of ['docs/SIGNING.md', 'docs/ENTERPRISE_RELEASE.md']) {
      expect(read(rel), rel).not.toMatch(/%ProgramData%\\AskToto/)
    }
  })

  it('no doc under docs/ lists the license gate as an enforced control while it is compiled off', () => {
    if (!enforcementCompiledOff) return
    const offenders = markdownFiles(join(REPO, 'docs')).flatMap((file) =>
      licenseGateClaims(readFileSync(file, 'utf8')).map((line) => `${relative(REPO, file)}: ${line.trim()}`)
    )
    expect(offenders).toEqual([])
  })
})
