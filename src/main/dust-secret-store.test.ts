import { describe, it, expect } from 'vitest'
import { winCredReadScript, DUST_KEYCHAIN_SERVICE } from './dust-secret-store'

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
