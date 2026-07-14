import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron')

describe('secrets — explicit local keystore', () => {
  let userData: string
  let electron: typeof import('electron')

  beforeEach(async () => {
    vi.resetModules()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-secrets-local-test-'))
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
    electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    ;(electron.safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true)
  })

  afterEach(() => {
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true })
  })

  it('never prompts Keychain when the explicit local keystore override is active', async () => {
    const { encryptSecret, decryptSecret } = await import('./secrets')

    expect(decryptSecret(encryptSecret('local-only'))).toBe('local-only')
    expect(electron.safeStorage.encryptString).not.toHaveBeenCalled()
    expect(electron.safeStorage.decryptString).not.toHaveBeenCalled()
    expect(readFileSync(join(userData, 'secret-key.bin'))).toHaveLength(32)
  })
})
