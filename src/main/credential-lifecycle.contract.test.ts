import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREDENTIAL_INVENTORY, type CredentialEntry } from '@shared/credential-inventory'
import { readModuleSource } from '../test-helpers/module-source'
import { isProfileRecoveryFileName } from './profile-recovery-files'

const index = readModuleSource(__dirname, './index').text

/** The body of `function name(...) {...}` or an `ipcMain.handle(IPC.x, ...)` block, up to the next top-level marker. */
function sliceFrom(source: string, marker: string, length = 3500): string {
  const at = source.indexOf(marker)
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1)
  return source.slice(at, at + length)
}

describe('G20: main wires the credential lifecycle at the real boundaries', () => {
  it('builds renderer-facing settings through the inventory redaction, not a hand-kept list', () => {
    const body = sliceFrom(index, 'function publicSettings(): PublicSettings {', 9000)
    expect(body).toMatch(/\.\.\.redactCredentialSettings\(s\)/)
    expect(body).not.toMatch(/operatorLicenseToken: ''/)
    expect(body).not.toMatch(/operatorIngestSecret: ''/)
  })

  it('runs sign-out cleanup from the one place every session end passes through', () => {
    const body = sliceFrom(index, 'function revokePrivilegedSurface(): void {', 900)
    expect(body).toMatch(/credentialLifecycle\.onSessionCleared\(\)/)
    expect(index).toMatch(
      /setSessionClearedHandler\(commandControl\.wrapLifecycleListener\('auth_session_cleared', revokePrivilegedSurface\)\)/
    )
  })

  it('checks for an account switch before enrolment runs on sign-in', () => {
    const body = sliceFrom(index, 'ipcMain.handle(IPC.authSignIn,', 1200)
    expect(body).toMatch(/credentialLifecycle\.onSignedIn\(enrollmentOnSignedIn\)/)
  })

  it('disconnects a provider through the shared function that also retires the Dust pair', () => {
    const body = sliceFrom(index, 'ipcMain.handle(IPC.clearApiKey,', 1600)
    expect(body).toMatch(/disconnectProvider\(parsed\.provider\)/)
    expect(body).not.toMatch(/\bclearApiKey\(/)
    expect(body).not.toMatch(/clearSeededDustCliSession/)
  })

  it('runs reset cleanup before the recovery archive moves the profile files', () => {
    const body = sliceFrom(index, 'ipcMain.handle(IPC.settingsRecoverProfile,', 2600)
    const reset = body.indexOf('credentialLifecycle.onProfileReset()')
    const archive = body.indexOf('archiveEncryptedProfile()')
    expect(reset).toBeGreaterThan(-1)
    expect(archive).toBeGreaterThan(reset)
  })
})

describe('G20: the profile-recovery classifier is driven by the inventory', () => {
  const sample = (entry: CredentialEntry): string[] =>
    entry.holder.kind !== 'keystore-file'
      ? []
      : entry.holder.files.flatMap((file) => {
          const base = file.name.split(' ')[0].replace('<provider>', 'anthropic').replace('<connection>', 'plane')
          return base.includes('/') ? [] : [base, ...(file.name.includes('key-bidstack') ? ['key-bidstack.bin'] : [])]
        })

  it('archives every file credential the inventory says reset archives, including the ones the old fixed list missed', () => {
    for (const entry of CREDENTIAL_INVENTORY.filter((e) => e.cleanup.reset === 'archive')) {
      for (const name of sample(entry)) expect(isProfileRecoveryFileName(name), `${entry.id}: ${name}`).toBe(true)
    }
    expect(isProfileRecoveryFileName('dust-refresh.bin')).toBe(true)
    expect(isProfileRecoveryFileName('license-cache.bin')).toBe(true)
    expect(isProfileRecoveryFileName('key-mcp-plane-client.bin.tmp')).toBe(true)
  })

  it("leaves the files cleanup keeps (the owner-key salt) and the user's own data alone", () => {
    expect(isProfileRecoveryFileName('owner-key-salt.v1')).toBe(false)
    expect(isProfileRecoveryFileName('a-meeting.md')).toBe(false)
    expect(isProfileRecoveryFileName('desktop-action-tasks.bin')).toBe(false)
  })
})

describe('G20 (a): a new credential file in the main process fails CI until it is in the inventory', () => {
  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) sources(full, out)
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full)
    }
    return out
  }

  it('names every credential-shaped .bin file the main sources mention', () => {
    const matchers = CREDENTIAL_INVENTORY.flatMap((e) => (e.holder.kind === 'keystore-file' ? e.holder.files : []))
    const found = new Set<string>()
    for (const file of sources(join(__dirname))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/(?:key|dust|license|msal|auth|google|secret)[A-Za-z0-9_${}.-]*\.bin/g)) {
        found.add(m[0].replace(/\$\{[^}]*(?:provider)[^}]*\}/gi, 'anthropic').replace(/\$\{[^}]*\}/g, 'plane'))
      }
    }
    expect(found.size).toBeGreaterThan(8)
    const unknown = [...found].filter((name) => !matchers.some((file) => file.match.test(name.replace(/\.tmp$/, ''))))
    expect(
      unknown,
      `Add each file to a keystore-file entry in shared/credential-inventory.ts: ${unknown.join(', ')}`
    ).toEqual([])
  })
})
