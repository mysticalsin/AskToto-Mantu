import { describe, it, expect } from 'vitest'
import {
  winCredReadScript,
  winCredReadSpawnSpec,
  winCredReadSessionScript,
  winCredReadSessionSpawnSpec,
  macDustSessionJxa,
  macDustSessionSpawnSpec,
  DUST_KEYCHAIN_SERVICE
} from './dust-secret-store'

// Accepts either separator so the assertion holds when a non-Windows host resolves the pinned path.
const ABSOLUTE_SYSTEM32_POWERSHELL =
  /^[A-Za-z]:[\\/](.+[\\/])?System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i

// The Windows read path can't run on this host — these guard the generated PowerShell against silent
// drift (wrong target, missing CredRead/CredFree, wrong not-found exit code) that would break Windows.
describe('winCredReadScript', () => {
  it('targets the exact Credential-Manager name keytar writes (service/account)', () => {
    const s = winCredReadScript('dust-cli/access_token')
    expect(s).toContain("[MetisCred]::CredReadW('dust-cli/access_token',1,0,[ref]$p)")
    expect(DUST_KEYCHAIN_SERVICE).toBe('dust-cli')
  })

  it('reads via CredRead, frees the handle, and decodes the blob as UTF-8', () => {
    const s = winCredReadScript('dust-cli/workspace_sid')
    expect(s).toContain('CredReadW')
    expect(s).toContain('CredFree')
    expect(s).toContain('[Text.Encoding]::UTF8.GetString')
  })

  it('exits 2 when the credential is absent (→ read returns null, not an error)', () => {
    expect(winCredReadScript('dust-cli/region')).toContain('exit 2')
  })
})

describe('winCredReadSpawnSpec — powershell is pinned to System32', () => {
  // Regression: this read used to spawn a bare 'powershell.exe'. Windows' CreateProcess searches the
  // current working directory before PATH, so a bare name hands the user's stored OAuth token to an
  // attacker-planted powershell.exe (win-security.ts states the invariant).
  it('spawns the absolute %SystemRoot%\\System32 powershell, never a bare name', () => {
    const spec = winCredReadSpawnSpec('dust-cli/access_token')
    expect(spec.command).toMatch(ABSOLUTE_SYSTEM32_POWERSHELL)
    expect(spec.command).not.toBe('powershell.exe')
    expect(spec.command).not.toBe('powershell')
  })

  it('still passes the encoded CredRead script (the pinning did not change the payload)', () => {
    const spec = winCredReadSpawnSpec('dust-cli/access_token')
    expect(spec.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(Buffer.from(spec.args[3], 'base64').toString('utf16le')).toBe(
      winCredReadScript('dust-cli/access_token')
    )
  })
})

describe('in-process session cache — one Allow for import + probe + reconnect', () => {
  const service = 'asktoto-dust-cache-test'

  it('import + probe + reconnect after the first Allow are privilegeSpawns 0 (no second Keychain)', async () => {
    const {
      clearDustSessionSecretsCache,
      peekDustSessionSecretsCache,
      readDustSessionSecrets,
      rememberDustSessionSecrets
    } = await import('./dust-secret-store')
    clearDustSessionSecretsCache(service)
    rememberDustSessionSecrets(service, {
      access_token: { value: 'tok', accessDenied: false },
      workspace_sid: { value: 'ws_mantu', accessDenied: false },
      region: { value: 'us', accessDenied: false },
      privilegeSpawns: 1
    })
    const importHit = await readDustSessionSecrets(service)
    const probeHit = await readDustSessionSecrets(service)
    const reconnectHit = await readDustSessionSecrets(service)
    expect(importHit.privilegeSpawns).toBe(0)
    expect(probeHit.privilegeSpawns).toBe(0)
    expect(reconnectHit.privilegeSpawns).toBe(0)
    expect(importHit.access_token.value).toBe('tok')
    expect(probeHit.workspace_sid.value).toBe('ws_mantu')
    expect(reconnectHit.access_token.value).toBe('tok')
    expect(peekDustSessionSecretsCache(service)?.privilegeSpawns).toBe(0)
    clearDustSessionSecretsCache(service)
  })

  it('does not cache a Keychain denial — Reconnect can ask again', async () => {
    const { clearDustSessionSecretsCache, peekDustSessionSecretsCache, rememberDustSessionSecrets } =
      await import('./dust-secret-store')
    clearDustSessionSecretsCache(service)
    rememberDustSessionSecrets(service, {
      access_token: { value: null, accessDenied: true },
      workspace_sid: { value: null, accessDenied: true },
      region: { value: null, accessDenied: true },
      privilegeSpawns: 1
    })
    expect(peekDustSessionSecretsCache(service)).toBeNull()
    clearDustSessionSecretsCache(service)
  })
})

describe('one-consent Dust session read (DUST-CONNECT)', () => {
  it('Mac JXA is one osascript, not three security finds', () => {
    const spec = macDustSessionSpawnSpec()
    expect(spec.command).toBe('/usr/bin/osascript')
    expect(spec.args).toEqual(['-l', 'JavaScript', '-e', macDustSessionJxa(DUST_KEYCHAIN_SERVICE)])
    const jxa = macDustSessionJxa(DUST_KEYCHAIN_SERVICE)
    expect(jxa).toContain('kSecMatchLimitAll')
    expect(jxa).toContain('dust-cli')
    expect(jxa).not.toMatch(/find-generic-password/)
  })

  it('Windows session script CredReads all three targets in one process', () => {
    const s = winCredReadSessionScript()
    expect(s).toContain("dust-cli/access_token")
    expect(s).toContain("dust-cli/workspace_sid")
    expect(s).toContain("dust-cli/region")
    expect(s).toContain('CredReadW')
    expect(s).toContain('ConvertTo-Json')
    const spec = winCredReadSessionSpawnSpec()
    expect(spec.command).toMatch(ABSOLUTE_SYSTEM32_POWERSHELL)
    expect(spec.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  })
})
