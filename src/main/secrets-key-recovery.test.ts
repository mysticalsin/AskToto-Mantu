import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'

vi.mock('electron')

describe('secrets — corrupt wrapped key recovery', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-secrets-recovery-'))
    ;(app as unknown as { isPackaged: boolean }).isPackaged = true
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(safeStorage.encryptString as ReturnType<typeof vi.fn>).mockImplementation((value: string) =>
      Buffer.from(`enc:${value}`)
    )
    ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockImplementation((buffer: Buffer) => {
      const value = buffer.toString('utf8')
      return value.startsWith('enc:') ? value.slice(4) : value
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    ;(app as unknown as { isPackaged: boolean }).isPackaged = false
    rmSync(userData, { recursive: true, force: true })
  })

  it('refuses to regenerate a non-empty wrapped value that cannot decode to a 32-byte AES key', async () => {
    const original = Buffer.from('legacy-invalid-wrapped-key')
    writeFileSync(join(userData, 'secret-key.bin'), original)
    const { encryptSecret } = await import('./secrets')

    expect(() => encryptSecret('brain-data')).toThrow('Métis could not unlock the existing encrypted profile')
    expect(readFileSync(join(userData, 'secret-key.bin'))).toEqual(original)
  })

  it('recovers a wrapped key on an explicit write even when availability reports false', async () => {
    const originalKey = randomBytes(32)
    writeFileSync(join(userData, 'secret-key.bin'), Buffer.from(`enc:${originalKey.toString('base64')}`))
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const { prepareFileKeyForWrite, encryptSecret, decryptSecret } = await import('./secrets')

    prepareFileKeyForWrite()
    expect(readFileSync(join(userData, 'secret-key.bin'))).toEqual(originalKey)
    expect(decryptSecret(encryptSecret('brain-data'))).toBe('brain-data')
  })
})
