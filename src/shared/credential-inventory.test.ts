import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CREDENTIAL_INVENTORY,
  CREDENTIAL_READ_REFUSAL_CODES,
  CREDENTIAL_REFUSAL_COPY,
  REVIEWED_NON_SECRET_SETTINGS_KEYS,
  SECRET_SETTINGS_KEYS,
  credentialEntry,
  credentialsFor,
  isClassifiedSettingsKey,
  isCredentialShapedSettingsKey,
  redactCredentialSettings,
  type CredentialAction,
  type CredentialEntry,
  type CredentialTrigger
} from './credential-inventory'
import { BaseSettingsSchema, DEFAULT_SETTINGS, PublicSettingsSchema } from './ipc'
import { PROVIDER_IDS } from './providers'

const TRIGGERS: readonly CredentialTrigger[] = ['signOut', 'accountSwitch', 'reset']
const ACTIONS: readonly CredentialAction[] = ['keep', 'clear', 'archive']
const SETTINGS_KEYS = Object.keys(BaseSettingsSchema.shape)

/** A value that must never appear anywhere in a renderer-facing object. Named synthetic so Gitleaks ignores it. */
const SECRET = (name: string): string => `synthetic-${name}-secret-value`

describe('G20 (a): the credential inventory covers every credential-shaped settings key', () => {
  it('has a unique id and a complete lifecycle row for every credential', () => {
    const ids = CREDENTIAL_INVENTORY.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of CREDENTIAL_INVENTORY) {
      expect(Object.keys(entry.cleanup).sort(), entry.id).toEqual([...TRIGGERS].sort())
      for (const trigger of TRIGGERS) expect(ACTIONS, `${entry.id}.${trigger}`).toContain(entry.cleanup[trigger])
      expect(entry.label.length, entry.id).toBeGreaterThan(3)
      expect(entry.note.length, entry.id).toBeGreaterThan(10)
      expect(credentialEntry(entry.id)).toBe(entry)
    }
  })

  it('classifies every credential-shaped key in the settings schema (a new key fails here until it is placed)', () => {
    const unclassified = SETTINGS_KEYS.filter(
      (key) => isCredentialShapedSettingsKey(key) && !isClassifiedSettingsKey(key)
    )
    expect(
      unclassified,
      `Add each key to a CREDENTIAL_INVENTORY entry (secretSettingsKeys or companionSettingsKeys), or to REVIEWED_NON_SECRET_SETTINGS_KEYS with a reason: ${unclassified.join(', ')}`
    ).toEqual([])
  })

  it('names only settings keys that exist (no stale inventory row)', () => {
    const named = [
      ...CREDENTIAL_INVENTORY.flatMap((e) => [...e.secretSettingsKeys, ...e.companionSettingsKeys]),
      ...Object.keys(REVIEWED_NON_SECRET_SETTINGS_KEYS)
    ]
    expect(named.filter((key) => !SETTINGS_KEYS.includes(key))).toEqual([])
  })

  it('never lists one settings key under two credentials as a secret, or as both secret and reviewed non-secret', () => {
    expect(new Set(SECRET_SETTINGS_KEYS).size).toBe(SECRET_SETTINGS_KEYS.length)
    for (const key of SECRET_SETTINGS_KEYS) expect(REVIEWED_NON_SECRET_SETTINGS_KEYS, key).not.toHaveProperty(key)
  })

  it('records every secret settings key as a string whose default is empty (so redaction is the default)', () => {
    for (const key of SECRET_SETTINGS_KEYS) {
      expect(z.string().safeParse((DEFAULT_SETTINGS as Record<string, unknown>)[key]).success, key).toBe(true)
      expect((DEFAULT_SETTINGS as Record<string, unknown>)[key], key).toBe('')
    }
  })

  it('holds the known secret-bearing settings keys, including the three the renderer used to receive', () => {
    expect([...SECRET_SETTINGS_KEYS].sort()).toEqual(
      ['licenseKey', 'licenseLease', 'operatorIngestSecret', 'operatorLicenseToken', 'operatorReportingToken'].sort()
    )
  })

  it('matches each profile file to exactly one credential, and every provider key file to the provider entry', () => {
    const files = [
      'secret-key.bin',
      'secret-key.bin.migrate.tmp',
      'auth-session.bin',
      'msal-cache.bin',
      'google-session.bin',
      'key-soniox.bin',
      'key-bidstack.bin',
      'key-mcp-clickup.bin',
      'key-mcp-clickup-refresh.bin',
      'key-mcp-plane-client.bin',
      'dust-refresh.bin',
      'license-cache.bin',
      ...PROVIDER_IDS.map((id) => `key-${id}.bin`)
    ]
    const owners = (name: string): string[] =>
      CREDENTIAL_INVENTORY.filter(
        (e) => e.holder.kind === 'keystore-file' && e.holder.files.some((f) => f.match.test(name))
      ).map((e) => e.id)
    for (const file of files) expect(owners(file), file).toHaveLength(1)
    for (const id of PROVIDER_IDS) expect(owners(`key-${id}.bin`), id).toEqual(['provider-api-key'])
    expect(owners('key-mcp-clickup.bin')).toEqual(['mcp-api-key'])
    expect(owners('key-mcp-clickup-refresh.bin')).toEqual(['mcp-oauth-refresh'])
    expect(owners('key-mcp-plane-client.bin')).toEqual(['mcp-oauth-client-secret'])
    expect(owners('key-bidstack.bin')).toEqual(['mcp-api-key'])
    expect(owners('settings.json')).toEqual([])
  })
})

describe('G20: the lifecycle matrix', () => {
  const byTrigger = (trigger: CredentialTrigger, action: CredentialAction): string[] =>
    credentialsFor(trigger, action).map((e) => e.id)

  it('sign-out clears what is bound to the signed-in identity and what left the encrypted store, and nothing else', () => {
    expect(byTrigger('signOut', 'clear').sort()).toEqual(
      ['auth-session', 'dust-cli-seed', 'legacy-google-session', 'msal-cache', 'speech-auth-lease'].sort()
    )
    expect(byTrigger('signOut', 'archive')).toEqual([])
  })

  it('an account switch clears every credential the previous owner supplied', () => {
    const cleared = byTrigger('accountSwitch', 'clear')
    for (const id of [
      'provider-api-key',
      'soniox-api-key',
      'operator-licence',
      'operator-reporting-token',
      'operator-ingest-secret',
      'dust-oauth-refresh',
      'dust-cli-seed',
      'mcp-api-key',
      'mcp-oauth-refresh',
      'mcp-oauth-client-secret',
      'member-licence-key',
      'member-licence-cache'
    ])
      expect(cleared, id).toContain(id)
  })

  it('reset archives (never deletes) every file or settings credential, and clears only copies outside the profile', () => {
    for (const entry of CREDENTIAL_INVENTORY) {
      const action = entry.cleanup.reset
      if (entry.holder.kind === 'keystore-file' || entry.holder.kind === 'encrypted-settings') {
        // The owner-key salt stays with the user's own journals; everything else moves into the recovery folder.
        if (entry.id === 'owner-key-salt') expect(action, entry.id).toBe('keep')
        else expect(action, entry.id).toBe('archive')
      }
      if (entry.holder.kind === 'os-keychain' || entry.holder.kind === 'memory') expect(action, entry.id).toBe('clear')
    }
  })

  it("never clears the user's own data keys: content keys and the file key outlive sign-out and an account switch", () => {
    for (const id of ['content-key', 'file-key', 'owner-key-salt'] as const) {
      expect(credentialEntry(id).cleanup.signOut, id).toBe('keep')
      expect(credentialEntry(id).cleanup.accountSwitch, id).toBe('keep')
      expect(credentialEntry(id).cleanup.reset, id).not.toBe('clear')
    }
  })

  it('never lets the renderer read a value: nothing is renderer-readable beyond a presence flag', () => {
    for (const entry of CREDENTIAL_INVENTORY) expect(['never', 'presence-only'], entry.id).toContain(entry.renderer)
  })

  it('lets only main decrypt a stored credential', () => {
    for (const entry of CREDENTIAL_INVENTORY) {
      if (entry.holder.kind === 'keystore-file' || entry.holder.kind === 'encrypted-settings')
        expect(entry.readers, entry.id).toContain('main')
      expect((entry.readers as readonly string[]).includes('renderer'), entry.id).toBe(false)
    }
  })

  it('keeps the trial start stamp out of every credential row (clearing it would restart the trial)', () => {
    const named = CREDENTIAL_INVENTORY.flatMap((e) => [...e.secretSettingsKeys, ...e.companionSettingsKeys])
    expect(named).not.toContain('trialStartedAt')
  })
})

describe('G20 (b): renderer-facing settings never carry a secret value', () => {
  const populated = (): Record<string, unknown> => {
    const all: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    for (const key of SECRET_SETTINGS_KEYS) all[key] = SECRET(key)
    return all
  }

  it('redactCredentialSettings blanks every inventory secret and leaves the rest alone', () => {
    const input: Record<string, unknown> = { ...populated(), operatorLicenseLast4: 'wxyz', operatorConfigured: true }
    const out = redactCredentialSettings(input)
    for (const key of SECRET_SETTINGS_KEYS) expect(out[key], key).toBe('')
    expect(out.operatorLicenseLast4).toBe('wxyz')
    expect(out.operatorConfigured).toBe(true)
    expect(JSON.stringify(out)).not.toContain('synthetic-')
    expect(input.operatorReportingToken).toBe(SECRET('operatorReportingToken')) // input is not mutated
  })

  it('does not invent a secret key a partial settings object never had', () => {
    expect(Object.keys(redactCredentialSettings({ provider: 'openai' }))).toEqual(['provider'])
  })

  it('the public settings schema adds only presence or readiness fields where the name is credential-shaped', () => {
    const base = new Set(SETTINGS_KEYS)
    const extras = Object.keys(PublicSettingsSchema.shape).filter((k) => !base.has(k))
    const unwrap = (schema: z.ZodType): z.ZodType => {
      let current = schema
      for (;;) {
        const def = current._zod.def as unknown as { type: string; innerType?: z.ZodType }
        if (def.type === 'default' || def.type === 'optional' || def.type === 'nullable') current = def.innerType!
        else return current
      }
    }
    // Names of settings IT has locked, and of providers whose key comes from the environment: identifiers, never values.
    const listsOfNames = new Set(['managedKeys', 'envKeys'])
    for (const key of extras.filter(
      (k) => !listsOfNames.has(k) && (isCredentialShapedSettingsKey(k) || /key/i.test(k))
    )) {
      const field = unwrap(PublicSettingsSchema.shape[key as keyof typeof PublicSettingsSchema.shape])
      const def = field._zod.def as unknown as { type: string; valueType?: z.ZodType }
      const isFlag = def.type === 'boolean'
      const isFlagMap =
        def.type === 'record' && (unwrap(def.valueType!)._zod.def as { type: string }).type === 'boolean'
      expect(isFlag || isFlagMap, `${key} is credential-shaped but not a boolean flag`).toBe(true)
    }
  })

  it('has a refusal copy for every refusal code, with no placeholder that could carry a value', () => {
    for (const code of CREDENTIAL_READ_REFUSAL_CODES) {
      const copy = CREDENTIAL_REFUSAL_COPY[code]
      expect(copy.length, code).toBeGreaterThan(20)
      expect(copy, code).not.toMatch(/\$\{|%s|\{\{/)
    }
  })

  it('exposes entries whose secret keys all appear in the inventory list used for redaction', () => {
    const fromEntries = CREDENTIAL_INVENTORY.flatMap((e: CredentialEntry) => e.secretSettingsKeys)
    expect([...fromEntries].sort()).toEqual([...SECRET_SETTINGS_KEYS].sort())
  })
})
