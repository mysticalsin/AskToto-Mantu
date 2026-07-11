import { describe, it, expect, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { importDustCliSession } from './dustcli'

const exec = promisify(execFile)

// Real keychain round-trip — exercises the exact `security find-generic-password` path the app uses,
// but against a THROWAWAY service so the user's real `dust login` session is never touched.
const TEST_SERVICE = 'asktoto-dustcli-test'
const ACCOUNTS = ['access_token', 'workspace_sid', 'region']

// Probe once whether this environment can actually write the login keychain. Sandboxes and headless CI
// deny `security add-generic-password`, where this real-keychain suite would FAIL rather than prove
// anything — so skip cleanly there instead of reporting a false failure.
function keychainWritable(): boolean {
  if (process.platform !== 'darwin') return false
  const probe = 'asktoto-dustcli-probe'
  try {
    execFileSync('security', ['add-generic-password', '-s', probe, '-a', 'probe', '-w', 'x'], { stdio: 'ignore' })
    try {
      execFileSync('security', ['delete-generic-password', '-s', probe, '-a', 'probe'], { stdio: 'ignore' })
    } catch {
      /* best-effort cleanup */
    }
    return true
  } catch {
    return false
  }
}
const canKeychain = keychainWritable()

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

describe.runIf(canKeychain)('importDustCliSession (real keychain)', () => {
  afterAll(async () => {
    await delAll()
  })

  it('reports no session when the keychain is empty', async () => {
    await delAll()
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/No Dust CLI session found/i)
  })

  it('imports token + workspace and maps EU region to eu.dust.tt', async () => {
    await setSession({ access_token: 'tok_eu_123', workspace_sid: 'ws_eu', region: 'europe-west1' })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(true)
    expect(r.token).toBe('tok_eu_123')
    expect(r.workspaceId).toBe('ws_eu')
    expect(r.baseUrl).toBe('https://eu.dust.tt')
  })

  it('maps US region to dust.tt', async () => {
    await setSession({ access_token: 'tok_us_123', workspace_sid: 'ws_us', region: 'us-central1' })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(true)
    expect(r.baseUrl).toBe('https://dust.tt')
  })

  it('fails when only a partial session exists (token but no workspace)', async () => {
    await setSession({ access_token: 'tok_only' })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(false)
  })
})
