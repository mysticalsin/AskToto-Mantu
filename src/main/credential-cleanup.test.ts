import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CREDENTIAL_INVENTORY,
  CREDENTIAL_REFUSAL_COPY,
  credentialsFor,
  type CredentialId,
  type CredentialTrigger
} from '@shared/credential-inventory'

vi.mock('electron')

const sink = vi.hoisted(() => ({ logs: [] as unknown[][], audits: [] as unknown[][] }))
vi.mock('./logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logger')>()
  const record =
    (target: unknown[][]) =>
    (...args: unknown[]): void => {
      target.push(args)
    }
  return {
    ...actual,
    mainLog: { error: record(sink.logs), warn: record(sink.logs), info: record(sink.logs), debug: record(sink.logs) },
    auditLog: record(sink.audits)
  }
})

const SECRET = (name: string): string => `synthetic-${name}-cleanup-secret`
const everything = (): string => inspect([sink.logs, sink.audits], { depth: 8, maxStringLength: 100_000 })

let userData: string
let safeStorage: typeof import('electron').safeStorage

beforeEach(async () => {
  vi.resetModules()
  sink.logs.length = 0
  sink.audits.length = 0
  userData = mkdtempSync(join(tmpdir(), 'metis-cred-cleanup-'))
  // vi.resetModules() gives every module a fresh electron mock, so the profile path is pinned on that one.
  const electron = await import('electron')
  safeStorage = electron.safeStorage
  ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
    name === 'userData' ? userData : join(userData, name)
  )
  delete process.env.ASKTOTO_LOCAL_KEYSTORE
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('G20: the cleanup executor follows the inventory', () => {
  const TRIGGERS: CredentialTrigger[] = ['signOut', 'accountSwitch', 'reset']

  const recordingClearers = async (): Promise<{
    calls: CredentialId[]
    clearers: Record<string, () => string>
  }> => {
    const calls: CredentialId[] = []
    const clearers: Record<string, () => string> = {}
    for (const entry of CREDENTIAL_INVENTORY) {
      clearers[entry.id] = () => {
        calls.push(entry.id)
        return 'cleared'
      }
    }
    return { calls, clearers }
  }

  it.each(TRIGGERS)('%s runs the clearer of every "clear" entry and of nothing else', async (trigger) => {
    const { runCredentialCleanup } = await import('./credential-cleanup')
    const { calls, clearers } = await recordingClearers()
    const receipt = await runCredentialCleanup(trigger, clearers as never)
    expect(calls).toEqual(credentialsFor(trigger, 'clear').map((e) => e.id))
    expect(receipt.trigger).toBe(trigger)
    expect(receipt.results.map((r) => r.credential)).toEqual(calls)
    expect(receipt.failed).toBe(0)
  })

  it('runs a clearer shared by several entries once', async () => {
    const { runCredentialCleanup } = await import('./credential-cleanup')
    let runs = 0
    const shared = (): 'cleared' => {
      runs += 1
      return 'cleared'
    }
    const clearers = Object.fromEntries(CREDENTIAL_INVENTORY.map((e) => [e.id, shared]))
    const receipt = await runCredentialCleanup('accountSwitch', clearers as never)
    expect(runs).toBe(1)
    expect(receipt.results.every((r) => r.outcome === 'cleared')).toBe(true)
  })

  it('continues past a failing clearer, reports it as failed, and never repeats the error text', async () => {
    const { runCredentialCleanup } = await import('./credential-cleanup')
    const { calls, clearers } = await recordingClearers()
    clearers['soniox-api-key'] = () => {
      throw new Error(`EPERM: could not delete ${SECRET('soniox')}`)
    }
    const receipt = await runCredentialCleanup('accountSwitch', clearers as never)
    expect(receipt.failed).toBe(1)
    expect(receipt.results.find((r) => r.credential === 'soniox-api-key')?.outcome).toBe('failed')
    expect(calls).toContain('mcp-api-key') // later entries still ran
    expect(JSON.stringify(receipt)).not.toContain('synthetic-')
    expect(everything()).not.toContain('synthetic-')
    expect(everything()).not.toContain('EPERM')
  })

  it('fails loudly, per credential, when a "clear" entry has no clearer', async () => {
    const { runCredentialCleanup } = await import('./credential-cleanup')
    const { clearers } = await recordingClearers()
    delete clearers['provider-api-key']
    const receipt = await runCredentialCleanup('accountSwitch', clearers as never)
    expect(receipt.results.find((r) => r.credential === 'provider-api-key')?.outcome).toBe('failed')
    expect(receipt.failed).toBe(1)
  })

  it('audits one content-free receipt per run (ids and counts only)', async () => {
    const { runCredentialCleanup } = await import('./credential-cleanup')
    const { clearers } = await recordingClearers()
    await runCredentialCleanup('signOut', clearers as never)
    expect(sink.audits).toHaveLength(1)
    const [event, detail] = sink.audits[0] as [string, Record<string, unknown>]
    expect(event).toBe('credential.cleanup')
    expect(Object.keys(detail).sort()).toEqual(['cleared', 'credentials', 'failed', 'trigger'])
    expect(detail.trigger).toBe('signOut')
  })

  it('names exactly the clearers the production map is missing', async () => {
    const { missingClearers } = await import('./credential-cleanup')
    expect(missingClearers({}, 'signOut').sort()).toEqual(
      credentialsFor('signOut', 'clear')
        .map((e) => e.id)
        .sort()
    )
    expect(missingClearers(await import('./credential-clearers').then((m) => m.productionClearers()), 'reset')).toEqual(
      []
    )
    for (const trigger of TRIGGERS) {
      const { productionClearers } = await import('./credential-clearers')
      expect(missingClearers(productionClearers(), trigger), trigger).toEqual([])
    }
  })
})

/** Seeds every kind of credential this build can hold, plus the user's own data, all with synthetic values. */
async function seedProfile(): Promise<void> {
  const store = await import('./store')
  const { setMcpApiKey, setMcpRefreshToken, setMcpClientSecret } = await import('./mcp/mcpSecrets')
  const { writeLicenseCache } = await import('./license/secret-store')
  store.setApiKey('anthropic', SECRET('anthropic'))
  store.setApiKey('dust', SECRET('dust'))
  store.setSonioxApiKey(SECRET('soniox'))
  store.setDustRefreshToken(SECRET('dust-refresh'))
  setMcpApiKey('plane', SECRET('plane'))
  setMcpRefreshToken('clickup', SECRET('clickup-refresh'))
  setMcpClientSecret('plane', SECRET('plane-client'))
  writeLicenseCache({
    jws: SECRET('licence-jws'),
    cachedAt: 1,
    kid: 'kid',
    edition: 'pro',
    source: 'cache'
  })
  store.setSettings({
    operatorLicenseToken: SECRET('operator-licence'),
    operatorLicenseJti: 'a1b2c3d4e5f60718',
    operatorLicenseLast4: 'ence',
    operatorReportingToken: SECRET('reporting'),
    operatorReportingJti: '0011223344556677',
    operatorLicenseOrigin: 'sso',
    operatorEnrollState: 'enrolled',
    operatorIngestSecret: SECRET('ingest'),
    licenseKey: SECRET('member-key'),
    licenseLease: SECRET('lease'),
    licenseValid: true,
    trialStartedAt: 1_700_000_000_000,
    dustSessionOrigin: 'oauth',
    mcpConnections: [
      {
        id: 'plane',
        kind: 'plane',
        label: 'Plane',
        endpointUrl: 'https://plane.example.test/mcp',
        connected: true,
        tools: ['create_issue'],
        extraHeaders: {}
      }
    ]
  } as never)
  // Session artefacts and a legacy file, which cleanup must treat as credentials; a meeting and a brain file
  // are the user's own data, which it must never touch.
  writeFileSync(join(userData, 'auth-session.bin'), 'session-bytes')
  writeFileSync(join(userData, 'msal-cache.bin'), 'msal-bytes')
  writeFileSync(join(userData, 'google-session.bin'), 'legacy-bytes')
  mkdirSync(join(userData, 'meetings'), { recursive: true })
  writeFileSync(join(userData, 'meetings', 'a-meeting.md'), 'the user wrote this')
  mkdirSync(join(userData, '.brain'), { recursive: true })
  writeFileSync(join(userData, '.brain', 'index.json'), '{"entities":[]}')
}

const present = (name: string): boolean => existsSync(join(userData, name))

describe('G20: production cleanup against a real profile folder', () => {
  it("sign-out clears the session and the legacy file, keeps pasted keys and the seat, and leaves the user's data alone", async () => {
    await seedProfile()
    const { runCredentialCleanup } = await import('./credential-cleanup')
    const { productionClearers } = await import('./credential-clearers')
    const receipt = await runCredentialCleanup('signOut', productionClearers())
    expect(receipt.failed).toBe(0)
    for (const gone of ['auth-session.bin', 'msal-cache.bin', 'google-session.bin'])
      expect(present(gone), gone).toBe(false)
    for (const kept of [
      'key-anthropic.bin',
      'key-dust.bin',
      'key-soniox.bin',
      'dust-refresh.bin',
      'key-mcp-plane.bin',
      'key-mcp-clickup-refresh.bin',
      'key-mcp-plane-client.bin',
      'license-cache.bin',
      'secret-key.bin',
      'settings.json'
    ])
      expect(present(kept), kept).toBe(true)
    const store = await import('./store')
    expect(store.getApiKey('anthropic')).toBe(SECRET('anthropic'))
    expect(store.getSettings().operatorLicenseToken).toBe(SECRET('operator-licence'))
    expect(store.getSettings().licenseKey).toBe(SECRET('member-key'))
    expect(existsSync(join(userData, 'meetings', 'a-meeting.md'))).toBe(true)
    expect(existsSync(join(userData, '.brain', 'index.json'))).toBe(true)
  })

  it('an account switch removes every credential the previous owner supplied and nothing of their saved data', async () => {
    await seedProfile()
    const { runCredentialCleanup } = await import('./credential-cleanup')
    const { productionClearers } = await import('./credential-clearers')
    const receipt = await runCredentialCleanup('accountSwitch', productionClearers())
    expect(receipt.failed).toBe(0)
    for (const gone of [
      'key-anthropic.bin',
      'key-dust.bin',
      'key-soniox.bin',
      'dust-refresh.bin',
      'key-mcp-plane.bin',
      'key-mcp-clickup-refresh.bin',
      'key-mcp-plane-client.bin',
      'license-cache.bin',
      'google-session.bin'
    ])
      expect(present(gone), gone).toBe(false)
    // The new owner's session is never touched by an account switch.
    expect(present('auth-session.bin')).toBe(true)
    expect(present('msal-cache.bin')).toBe(true)
    // The file key stays: it opens the user's own encrypted meetings.
    expect(present('secret-key.bin')).toBe(true)

    const store = await import('./store')
    const { getMcpApiKey } = await import('./mcp/mcpSecrets')
    expect(store.getApiKey('anthropic')).toBe('') // the in-memory caches were cleared with the files
    expect(store.getSonioxApiKeyStored()).toBe('')
    expect(getMcpApiKey('plane')).toBe('')
    const s = store.getSettings()
    for (const key of [
      'operatorLicenseToken',
      'operatorReportingToken',
      'operatorIngestSecret',
      'licenseKey',
      'licenseLease'
    ] as const)
      expect(s[key], key).toBe('')
    expect(s.operatorLicenseOrigin).toBeNull()
    expect(s.operatorEnrollState).toBe('unenrolled')
    expect(s.licenseValid).toBe(false)
    expect(s.dustSessionOrigin).toBe('cli')
    expect(s.mcpConnections[0]).toMatchObject({ id: 'plane', connected: false, tools: [] })
    expect(s.trialStartedAt).toBe(1_700_000_000_000) // not a credential: clearing it would restart the trial
    expect(existsSync(join(userData, 'meetings', 'a-meeting.md'))).toBe(true)
    expect(existsSync(join(userData, '.brain', 'index.json'))).toBe(true)
    expect(readdirSync(userData).filter((n) => /^key-.+\.bin$/.test(n))).toEqual([])
    expect(everything()).not.toContain('synthetic-')
  })

  it('reset clears only the copies outside the profile files (those are archived by the recovery step)', async () => {
    await seedProfile()
    const { runCredentialCleanup } = await import('./credential-cleanup')
    const { productionClearers } = await import('./credential-clearers')
    const receipt = await runCredentialCleanup('reset', productionClearers())
    expect(receipt.failed).toBe(0)
    expect(receipt.results.map((r) => r.credential).sort()).toEqual(
      credentialsFor('reset', 'clear')
        .map((e) => e.id)
        .sort()
    )
    expect(present('key-anthropic.bin')).toBe(true)
    expect(present('settings.json')).toBe(true)
  })

  it('refuses to remove the Dust CLI seed when the stored Dust key cannot be read, and says so without the key', async () => {
    const store = await import('./store')
    store.setSettings({ dustSessionOrigin: 'oauth' } as never)
    writeFileSync(join(userData, 'key-dust.bin'), Buffer.from('enc:legacy-bytes-the-keychain-must-open'))
    vi.mocked(safeStorage.decryptString).mockImplementation(() => {
      throw new Error(`keychain locked ${SECRET('dust')}`)
    })
    const { runCredentialCleanup } = await import('./credential-cleanup')
    const { productionClearers } = await import('./credential-clearers')
    const receipt = await runCredentialCleanup('signOut', productionClearers())
    expect(receipt.results.find((r) => r.credential === 'dust-cli-seed')?.outcome).toBe('refused')
    expect(receipt.failed).toBe(0)
    expect(everything()).not.toContain('synthetic-')
    expect(everything()).not.toContain('keychain locked')
    const { lastCredentialReadRefusal } = await import('./credential-read-denial')
    expect(lastCredentialReadRefusal('provider-api-key', 'dust')?.message).toBe(
      CREDENTIAL_REFUSAL_COPY['keychain-locked']
    )
  })

  it('disconnecting a provider removes the Dust pair and never reports the key', async () => {
    await seedProfile()
    const { disconnectProvider } = await import('./credential-clearers')
    const result = await disconnectProvider('dust')
    expect(result).toEqual({ dustRefreshRemoved: true })
    expect(present('key-dust.bin')).toBe(false)
    expect(present('dust-refresh.bin')).toBe(false)
    expect(present('key-anthropic.bin')).toBe(true)
    expect((await import('./store')).getSettings().dustSessionOrigin).toBe('cli')
  })
})
