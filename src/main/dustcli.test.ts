import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { importDustCliSession } from './dustcli'

const exec = promisify(execFile)

// Real keychain round-trip — exercises the exact `security find-generic-password` path the app uses,
// but against a THROWAWAY service so the user's real `dust login` session is never touched.
const TEST_SERVICE = 'asktoto-dustcli-test'
const isMac = process.platform === 'darwin'
const ACCOUNTS = ['access_token', 'workspace_sid', 'region']

async function delItem(account: string): Promise<void> {
  // Delete every duplicate (security keeps only one per service+account, but loop to be safe).
  for (let i = 0; i < 5; i++) {
    try {
      await exec('security', ['delete-generic-password', '-s', TEST_SERVICE, '-a', account])
    } catch {
      return // none left
    }
  }
}
async function delAll(): Promise<void> {
  for (const a of ACCOUNTS) await delItem(a)
}
async function setSession(fields: Record<string, string>): Promise<void> {
  await delAll()
  for (const [account, value] of Object.entries(fields)) {
    await exec('security', ['add-generic-password', '-s', TEST_SERVICE, '-a', account, '-w', value])
  }
}

describe.runIf(isMac)('importDustCliSession (real keychain)', () => {
  beforeAll(() => {
    process.env.DUST_CLI_KEYCHAIN_SERVICE = TEST_SERVICE
  })
  afterAll(async () => {
    await delAll()
    delete process.env.DUST_CLI_KEYCHAIN_SERVICE
  })

  it('reports no session when the keychain is empty', async () => {
    await delAll()
    const r = await importDustCliSession()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/dust login/i)
  })

  it('imports token + workspace and maps EU region to eu.dust.tt', async () => {
    await setSession({ access_token: 'tok_eu_123', workspace_sid: 'ws_eu', region: 'europe-west1' })
    const r = await importDustCliSession()
    expect(r.ok).toBe(true)
    expect(r.token).toBe('tok_eu_123')
    expect(r.workspaceId).toBe('ws_eu')
    expect(r.baseUrl).toBe('https://eu.dust.tt')
  })

  it('maps US region to dust.tt', async () => {
    await setSession({ access_token: 'tok_us_123', workspace_sid: 'ws_us', region: 'us-central1' })
    const r = await importDustCliSession()
    expect(r.ok).toBe(true)
    expect(r.baseUrl).toBe('https://dust.tt')
  })

  it('fails when only a partial session exists (token but no workspace)', async () => {
    await setSession({ access_token: 'tok_only' })
    const r = await importDustCliSession()
    expect(r.ok).toBe(false)
  })
})
