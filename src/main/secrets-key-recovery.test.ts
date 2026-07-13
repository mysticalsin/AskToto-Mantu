import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'

vi.mock('electron')

describe('secrets — corrupt wrapped key recovery', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-secrets-recovery-'))
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
    rmSync(userData, { recursive: true, force: true })
  })

  it('regenerates a wrapped value that does not decode to a 32-byte AES key', async () => {
    writeFileSync(join(userData, 'secret-key.bin'), Buffer.from('legacy-invalid-wrapped-key'))
    const { encryptSecret, decryptSecret } = await import('./secrets')

    const encrypted = encryptSecret('brain-data')

    expect(decryptSecret(encrypted)).toBe('brain-data')
    expect(readFileSync(join(userData, 'secret-key.bin')).toString('utf8')).toMatch(/^enc:/)
  })
})
