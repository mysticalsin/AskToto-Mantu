/**
 * managed-config-docs.test.ts — M2-0459.
 *
 * The two public managed-config examples and the docs under docs/ may only present controls the app
 * enforces. Each check is a pure function over text, so a fixture per branch proves the check fires; the
 * real examples and docs are then run through the same functions.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/ipc'
import { ManagedPolicyAuthority } from '../../src/main/fresh-lean-speech-defaults'

const REPO = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')

/**
 * Top-level managed-config keys that are read straight from the policy file and are NOT Settings keys.
 * Every entry names the file and the identifier in it that reads the key; a self-check below verifies both.
 */
const GOVERNANCE_KEYS: Record<string, { file: string; symbol: string }> = {
  locked: { file: 'src/main/store.ts', symbol: 'managedPolicyAuthority.parseLocked' },
  requireAuth: { file: 'src/main/auth.ts', symbol: 'authEnforced' },
  allowedProviders: { file: 'src/main/store.ts', symbol: 'managedPolicyAuthority.parseAllowed' },
  escrowPubKey: { file: 'src/main/transcripts.ts', symbol: 'escrowPubKey' },
  disableAutoUpdate: { file: 'src/main/updater.ts', symbol: 'disableAutoUpdate' },
  updateFeedUrl: { file: 'src/main/updater.ts', symbol: 'updateFeedUrl' },
  egressAllowlist: { file: 'src/main/net/egress-policy.ts', symbol: 'egressAllowlist' }
}

const EXAMPLES = ['build/managed-config.example.json', 'build/managed-config.enterprise.example.json']

/**
 * Device licensing is compiled off when both constants are false, derived from source the way the licensing
 * drift contract test does; the tickets that re-enable enforcement flip the constants and the docs together.
 */
const enforcementCompiledOff =
  /const LICENSE_ENFORCEMENT = false/.test(read('src/renderer/src/App.tsx')) &&
  /const LICENSE_UI_ENABLED: boolean = false/.test(read('src/renderer/src/components/Settings.tsx'))

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

function parseTypeScript(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function visit(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = []
  const walk = (current: ts.Node): void => {
    if (predicate(current)) found.push(current)
    current.forEachChild(walk)
  }
  walk(node)
  return found
}

function hasNamedImport(source: ts.SourceFile, moduleName: string, importedName: string): boolean {
  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName ||
      statement.importClause?.isTypeOnly
    )
      return false
    const bindings = statement.importClause?.namedBindings
    return (
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          (element.propertyName?.text ?? element.name.text) === importedName &&
          element.name.text === importedName
      )
    )
  })
}

function authorityCalls(source: ts.SourceFile, method: 'parseLocked' | 'parseAllowed'): ts.CallExpression[] {
  return visit(
    source,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'managedPolicyAuthority' &&
      node.expression.name.text === method
  ) as ts.CallExpression[]
}

const settingsKeys = Object.keys(DEFAULT_SETTINGS)
const governanceKeys = Object.keys(GOVERNANCE_KEYS)

describe('managed-config check functions fire on a bad fixture', () => {
  it('requires a runtime governance import under the actual constructor name', () => {
    for (const binding of [
      'type { ManagedPolicyAuthority }',
      '{ type ManagedPolicyAuthority }',
      '{ ManagedPolicyAuthority as OtherAuthority }'
    ]) {
      const fixture = ts.createSourceFile(
        '<inline>',
        `import ${binding} from './fresh-lean-speech-defaults'`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      )
      expect(hasNamedImport(fixture, './fresh-lean-speech-defaults', 'ManagedPolicyAuthority'), binding).toBe(false)
    }
  })

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
    expect(setsLicenseGate(JSON.stringify({ locked: ['provider'], _comment_license: 'licenseGateEnabled' }))).toBe(
      false
    )
  })

  it('flags a doc that lists the license gate as an enforced control', () => {
    expect(licenseGateClaims('It enables and locks:\n\n- Azure SSO.\n- License gate.\n')).toHaveLength(1)
    expect(licenseGateClaims('Managed config can lock SSO, license gate, and retention.')).toHaveLength(1)
    expect(licenseGateClaims('The license gate is compiled off until the licensing tickets land.')).toHaveLength(0)
  })

  it('the governance list documents where every key is read', () => {
    for (const [key, { file, symbol }] of Object.entries(GOVERNANCE_KEYS)) {
      expect(read(file), `${key}: ${file} must contain ${symbol}`).toContain(symbol)
    }
    expect(GOVERNANCE_KEYS.allowedProviders.file).toBe(GOVERNANCE_KEYS.locked.file)
    const store = parseTypeScript(GOVERNANCE_KEYS.locked.file)
    expect(hasNamedImport(store, './fresh-lean-speech-defaults', 'ManagedPolicyAuthority')).toBe(true)
    expect(
      visit(
        store,
        (node) =>
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'managedPolicyAuthority' &&
          !!node.initializer &&
          ts.isNewExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === 'ManagedPolicyAuthority'
      )
    ).toHaveLength(1)
    for (const method of ['parseLocked', 'parseAllowed'] as const) {
      const calls = authorityCalls(store, method)
      expect(calls.length, `store must call ManagedPolicyAuthority.${method}`).toBeGreaterThan(0)
      expect(new Set(calls.map((call) => call.arguments[1]?.getText(store).replaceAll("'", '')))).toEqual(
        new Set(['admin', 'user'])
      )
    }
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

describe('managed-config policy authority parser compatibility', () => {
  it('honors locked precedence and legacy lockedKeys while retaining malformed-policy unreadability', () => {
    const legacyAlias = new ManagedPolicyAuthority()
    expect(legacyAlias.parseLocked(JSON.stringify({ lockedKeys: ['provider', 'provider'] }), 'user')).toEqual([
      'provider'
    ])
    expect(legacyAlias.readable).toBe(true)

    const explicitEmpty = new ManagedPolicyAuthority()
    expect(explicitEmpty.parseLocked(JSON.stringify({ locked: [], lockedKeys: ['provider'] }), 'admin')).toEqual([])
    expect(explicitEmpty.readable).toBe(true)

    const malformedExplicitAdmin = new ManagedPolicyAuthority()
    expect(
      malformedExplicitAdmin.parseLocked(JSON.stringify({ locked: null, lockedKeys: ['provider'] }), 'admin')
    ).toEqual([])
    expect(malformedExplicitAdmin.readable).toBe(false)

    const malformedUser = new ManagedPolicyAuthority()
    expect(malformedUser.parseLocked('{', 'user')).toEqual([])
    expect(malformedUser.readable).toBe(false)
  })

  it('distinguishes absent allowedProviders from explicit deny-all and malformed policy', () => {
    const absent = new ManagedPolicyAuthority()
    expect(absent.parseAllowed(JSON.stringify({ provider: 'openai' }), 'user')).toBeNull()
    expect(absent.readable).toBe(true)

    const denyAll = new ManagedPolicyAuthority()
    expect(denyAll.parseAllowed(JSON.stringify({ allowedProviders: [] }), 'admin')).toEqual([])
    expect(denyAll.readable).toBe(true)

    const duplicates = new ManagedPolicyAuthority()
    expect(
      duplicates.parseAllowed(JSON.stringify({ allowedProviders: ['openai', 'openai', 'anthropic'] }), 'user')
    ).toEqual(['openai', 'anthropic'])
    expect(duplicates.readable).toBe(true)

    const nullPolicy = new ManagedPolicyAuthority()
    expect(nullPolicy.parseAllowed(JSON.stringify({ allowedProviders: null }), 'admin')).toBeNull()
    expect(nullPolicy.readable).toBe(false)

    const mixedTypes = new ManagedPolicyAuthority()
    expect(mixedTypes.parseAllowed(JSON.stringify({ allowedProviders: ['openai', 7] }), 'user')).toEqual(['openai'])
    expect(mixedTypes.readable).toBe(false)

    const malformedJson = new ManagedPolicyAuthority()
    expect(malformedJson.parseAllowed('{', 'admin')).toBeNull()
    expect(malformedJson.readable).toBe(false)
  })
})
