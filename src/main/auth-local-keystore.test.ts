import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron')

describe('auth session with the explicit local keystore', () => {
  let userData: string
  let electron: typeof import('electron')

  beforeEach(async () => {
    vi.resetModules()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-auth-local-keystore-'))
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
    electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    ;(electron.safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true)
    writeFileSync(join(userData, 'auth-session.bin'), Buffer.from('legacy-keychain-session'))
  })

  afterEach(() => {
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    rmSync(userData, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('does not query Keychain for a legacy session and starts signed out instead', async () => {
    const { authStatus } = await import('./auth')

    expect(authStatus().signedIn).toBe(false)
    expect(electron.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(electron.safeStorage.decryptString).not.toHaveBeenCalled()
  })
})
