import { describe, expect, it } from 'vitest'
import { isEncryptedProfileFileName, isProfileRecoveryFileName } from './profile-recovery-files'

describe('profile recovery file names', () => {
  it('settings.json.recovered is recognised, so the archive carries the recovery copy with the old key', () => {
    // D7-7: readUserRaw's fail-closed path leaves settings.json.recovered in the profile root; before this
    // it stayed behind after an archive and read as live evidence of the old profile.
    expect(isProfileRecoveryFileName('settings.json.recovered')).toBe(true)
  })

  it('still recognises the existing profile evidence and ignores unrelated files', () => {
    for (const name of ['secret-key.bin', 'settings.json', 'auth-session.bin', 'key-openai.bin', 'key-dust.bin.tmp']) {
      expect(isProfileRecoveryFileName(name), name).toBe(true)
    }
    for (const name of ['ordinary-user-file.txt', 'settings.json.bak', 'key-.bin', 'machine-id.txt']) {
      expect(isProfileRecoveryFileName(name), name).toBe(false)
    }
  })

  it('names only the files that are encrypted under the file key as encrypted profile state', () => {
    // D7-8: these are the files a freshly minted key could never open. A plaintext settings.json is not one.
    expect(isEncryptedProfileFileName('key-anthropic.bin')).toBe(true)
    expect(isEncryptedProfileFileName('auth-session.bin')).toBe(true)
    for (const name of ['settings.json', 'settings.json.recovered', 'secret-key.bin', 'key-x.bin.tmp', 'notes.txt']) {
      expect(isEncryptedProfileFileName(name), name).toBe(false)
    }
  })
})
