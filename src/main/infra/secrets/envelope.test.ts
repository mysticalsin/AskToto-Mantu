import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron')

// The per-install file key and IV of every golden blob. The blobs are built here with node:crypto from the
// documented wire format [12 IV][16 tag][ciphertext], never with the code under test, so a change to that
// layout fails these tests instead of silently re-encoding.
const FILE_KEY = Buffer.alloc(32, 7)
const IV = Buffer.alloc(12, 3)

function goldenFileBlob(text: string, key: Buffer = FILE_KEY): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, IV)
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([IV, cipher.getAuthTag(), ct])
}

function decryptGolden(blob: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', FILE_KEY, blob.subarray(0, 12))
  decipher.setAuthTag(blob.subarray(12, 28))
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8')
}

// The electron mock's safeStorage: encryptString('x') is the bytes 'enc:x'.
const keychainBlob = (text: string): Buffer => Buffer.from(`enc:${text}`)

const JSON_TEXT = '{"theme":"dark","n":1}'

describe('envelope', () => {
  let userData: string
  let electron: typeof import('electron')
  let envelope: typeof import('./envelope')

  beforeEach(async () => {
    vi.resetModules()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-envelope-test-'))
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    ;(electron.app as unknown as { isPackaged: boolean }).isPackaged = false // file backend
    ;(electron.safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true)
    writeFileSync(join(userData, 'secret-key.bin'), FILE_KEY)
    envelope = await import('./envelope')
  })

  afterEach(() => {
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    ;(electron.app as unknown as { isPackaged?: boolean }).isPackaged = undefined
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true })
  })

  describe('open: golden fixtures for every existing format', () => {
    it('settings ATKENC2 (file backend) decodes to the exact text', () => {
      const bytes = Buffer.concat([Buffer.from('ATKENC2\n'), goldenFileBlob(JSON_TEXT)])
      expect(envelope.open(bytes, envelope.SETTINGS_FORMAT, { keychain: false })).toEqual({ kind: 'file', text: JSON_TEXT })
    })

    it('settings ATKENC1 (credential store) decodes only when the caller allows the keychain', () => {
      const bytes = Buffer.concat([Buffer.from('ATKENC1\n'), keychainBlob(JSON_TEXT)])
      expect(envelope.open(bytes, envelope.SETTINGS_FORMAT, { keychain: true })).toEqual({ kind: 'keychain', text: JSON_TEXT })
      const refused = envelope.open(bytes, envelope.SETTINGS_FORMAT, { keychain: false })
      expect(refused.kind).toBe('foreign-key')
      expect(electron.safeStorage.decryptString).toHaveBeenCalledTimes(1) // only the allowed read reached it
    })

    it('settings plain JSON is returned as plain text', () => {
      expect(envelope.open(Buffer.from(JSON_TEXT), envelope.SETTINGS_FORMAT, { keychain: false })).toEqual({
        kind: 'plain',
        text: JSON_TEXT
      })
    })

    it('API key ATKAES1 decodes; legacy plain: is plain; a bare blob is the credential store', () => {
      const file = Buffer.concat([Buffer.from('ATKAES1\n'), goldenFileBlob('sk-secret')])
      expect(envelope.open(file, envelope.API_KEY_FORMAT, { keychain: false })).toEqual({ kind: 'file', text: 'sk-secret' })
      expect(envelope.open(Buffer.from('plain:sk-old'), envelope.API_KEY_FORMAT, { keychain: false })).toEqual({
        kind: 'plain',
        text: 'sk-old'
      })
      expect(envelope.open(keychainBlob('sk-bare'), envelope.API_KEY_FORMAT, { keychain: true })).toEqual({
        kind: 'keychain',
        text: 'sk-bare'
      })
      expect(envelope.open(keychainBlob('sk-bare'), envelope.API_KEY_FORMAT, { keychain: false }).kind).toBe('foreign-key')
    })

    it('MCP ATKMCP1 and the legacy BidStack ATKBID1 decode under their own markers only', () => {
      const mcp = Buffer.concat([Buffer.from('ATKMCP1\n'), goldenFileBlob('mcp-secret')])
      const bid = Buffer.concat([Buffer.from('ATKBID1\n'), goldenFileBlob('bid-secret')])
      const mcpFormat = envelope.secretFileFormat(envelope.MARKER_MCP_FILE)
      const bidFormat = envelope.secretFileFormat(envelope.MARKER_BIDSTACK_FILE)
      expect(envelope.open(mcp, mcpFormat, { keychain: false })).toEqual({ kind: 'file', text: 'mcp-secret' })
      expect(envelope.open(bid, bidFormat, { keychain: false })).toEqual({ kind: 'file', text: 'bid-secret' })
      // Wrong family: the marker is not stripped, so it is treated as a bare credential-store blob.
      expect(envelope.open(mcp, bidFormat, { keychain: false }).kind).toBe('foreign-key')
    })

    it('bare blobs decode from either backend, in the order the caller asks', () => {
      const file = goldenFileBlob(JSON_TEXT)
      expect(envelope.open(file, envelope.BARE_FORMAT, { keychain: false, fileFirst: true })).toEqual({
        kind: 'file',
        text: JSON_TEXT
      })
      expect(envelope.open(keychainBlob(JSON_TEXT), envelope.BARE_FORMAT, { keychain: true })).toEqual({
        kind: 'keychain',
        text: JSON_TEXT
      })
      // The file blob under keychain-first still ends at the file key once the credential store fails.
      vi.mocked(electron.safeStorage.decryptString).mockImplementationOnce(() => {
        throw new Error('not a keychain blob')
      })
      expect(envelope.open(file, envelope.BARE_FORMAT, { keychain: true, fileFirst: false })).toEqual({
        kind: 'file',
        text: JSON_TEXT
      })
    })
  })

  describe('open: outcomes that are not text', () => {
    it('a marker with no body, or a body too short for an AES-GCM blob, is malformed', () => {
      expect(envelope.open(Buffer.from('ATKENC2\n'), envelope.SETTINGS_FORMAT, { keychain: false }).kind).toBe('malformed')
      expect(envelope.open(Buffer.from('ATKENC1\n'), envelope.SETTINGS_FORMAT, { keychain: true }).kind).toBe('malformed')
      const shortBody = Buffer.concat([Buffer.from('ATKAES1\n'), Buffer.alloc(27, 1)])
      expect(envelope.open(shortBody, envelope.API_KEY_FORMAT, { keychain: false }).kind).toBe('malformed')
      expect(electron.safeStorage.decryptString).not.toHaveBeenCalled()
    })

    it('a blob written under another file key is foreign-key, never an empty secret', () => {
      const other = goldenFileBlob('secret', Buffer.alloc(32, 9))
      const bytes = Buffer.concat([Buffer.from('ATKENC2\n'), other])
      expect(envelope.open(bytes, envelope.SETTINGS_FORMAT, { keychain: false }).kind).toBe('foreign-key')
    })

    it('a profile with no file key cannot read a file blob (and a read creates no key)', () => {
      rmSync(join(userData, 'secret-key.bin'))
      const bytes = Buffer.concat([Buffer.from('ATKAES1\n'), goldenFileBlob('secret')])
      expect(envelope.open(bytes, envelope.API_KEY_FORMAT, { keychain: false }).kind).toBe('foreign-key')
      expect(existsSync(join(userData, 'secret-key.bin'))).toBe(false)
    })

    it('a credential-store failure is foreign-key, and a truncated OSCrypt v10 blob never reaches the native call', () => {
      vi.mocked(electron.safeStorage.decryptString).mockImplementationOnce(() => {
        throw new Error('decrypt failed')
      })
      const wrong = Buffer.concat([Buffer.from('ATKENC1\n'), Buffer.from('opaque-bytes')])
      expect(envelope.open(wrong, envelope.SETTINGS_FORMAT, { keychain: true })).toEqual({
        kind: 'foreign-key',
        reason: 'decrypt failed'
      })
      vi.mocked(electron.safeStorage.decryptString).mockClear()
      const truncated = Buffer.concat([Buffer.from('ATKENC1\n'), Buffer.from('v10'), Buffer.alloc(4, 1)])
      expect(envelope.open(truncated, envelope.SETTINGS_FORMAT, { keychain: true }).kind).toBe('foreign-key')
      expect(electron.safeStorage.decryptString).not.toHaveBeenCalled()
    })

    it('never throws on arbitrary bytes', () => {
      for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0xfe]), Buffer.alloc(64, 0)]) {
        for (const format of [envelope.SETTINGS_FORMAT, envelope.API_KEY_FORMAT, envelope.BARE_FORMAT]) {
          expect(() => envelope.open(bytes, format, { keychain: true })).not.toThrow()
        }
      }
    })
  })

  describe('seal', () => {
    it('writes the file-backend layout byte for byte: marker, then [IV][tag][ciphertext] under the file key', () => {
      const settings = envelope.seal(JSON_TEXT, envelope.SETTINGS_FORMAT)
      expect(settings.kind).toBe('file')
      if (settings.kind !== 'file') return
      expect(settings.bytes.subarray(0, 8).toString('utf8')).toBe('ATKENC2\n')
      expect(decryptGolden(settings.bytes.subarray(8))).toBe(JSON_TEXT)

      const apiKey = envelope.seal('sk-secret', envelope.API_KEY_FORMAT)
      if (apiKey.kind !== 'file') throw new Error('expected a file blob')
      expect(apiKey.bytes.subarray(0, 8).toString('utf8')).toBe('ATKAES1\n')
      expect(decryptGolden(apiKey.bytes.subarray(8))).toBe('sk-secret')

      const bare = envelope.seal('bare', envelope.BARE_FORMAT)
      if (bare.kind !== 'file') throw new Error('expected a file blob')
      expect(decryptGolden(bare.bytes)).toBe('bare')
    })

    it('sealed bytes open back to the same text under every format', () => {
      for (const format of [envelope.SETTINGS_FORMAT, envelope.API_KEY_FORMAT, envelope.BARE_FORMAT]) {
        const sealed = envelope.seal('round-trip', format)
        if (sealed.kind === 'unavailable') throw new Error('expected a blob')
        expect(envelope.open(sealed.bytes, format, { keychain: false, fileFirst: true })).toEqual({
          kind: sealed.kind,
          text: 'round-trip'
        })
      }
    })

    it('uses the credential store when it is the backend in force, with the credential-store markers', () => {
      ;(electron.app as unknown as { isPackaged: boolean }).isPackaged = true
      const settings = envelope.seal(JSON_TEXT, envelope.SETTINGS_FORMAT)
      expect(settings).toEqual({ kind: 'keychain', bytes: Buffer.concat([Buffer.from('ATKENC1\n'), keychainBlob(JSON_TEXT)]) })
      const apiKey = envelope.seal('sk-secret', envelope.API_KEY_FORMAT)
      expect(apiKey).toEqual({ kind: 'keychain', bytes: keychainBlob('sk-secret') }) // bare: no marker
    })

    it('reports unavailable instead of writing plaintext, unless the caller allows the file fallback', () => {
      ;(electron.app as unknown as { isPackaged: boolean }).isPackaged = true
      const available = electron.safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>
      // Availability flips off between the backend choice and the encryption: the only way to reach this branch.
      available.mockReturnValueOnce(true).mockReturnValueOnce(false)
      expect(envelope.seal('x', envelope.SETTINGS_FORMAT).kind).toBe('unavailable')
      expect(electron.safeStorage.encryptString).not.toHaveBeenCalled()
      available.mockReturnValueOnce(true).mockReturnValueOnce(false)
      expect(envelope.seal('x', envelope.SETTINGS_FORMAT, { fallbackToFile: true }).kind).toBe('file')
    })

    it('never asks the credential store while the local keystore is forced', () => {
      ;(electron.app as unknown as { isPackaged: boolean }).isPackaged = true
      process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
      expect(envelope.seal('x', envelope.API_KEY_FORMAT).kind).toBe('file')
      expect(electron.safeStorage.encryptString).not.toHaveBeenCalled()
      expect(electron.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    })
  })

  describe('wrapped content keys', () => {
    it('wraps under the file key as F: and opens it back', () => {
      const field = envelope.sealWrappedKey('content-key-b64')
      expect(field.startsWith('F:')).toBe(true)
      expect(decryptGolden(Buffer.from(field.slice(2), 'base64'))).toBe('content-key-b64')
      expect(envelope.openWrappedKey(field, { keychain: false })).toEqual({ kind: 'file', text: 'content-key-b64' })
    })

    it('wraps under the credential store as S: and also opens the legacy bare form', () => {
      ;(electron.app as unknown as { isPackaged: boolean }).isPackaged = true
      const field = envelope.sealWrappedKey('content-key-b64')
      expect(field).toBe(`S:${keychainBlob('content-key-b64').toString('base64')}`)
      expect(envelope.openWrappedKey(field, { keychain: true })).toEqual({ kind: 'keychain', text: 'content-key-b64' })
      const legacy = keychainBlob('content-key-b64').toString('base64') // no prefix
      expect(envelope.wrappedKeyBackend(legacy)).toBe('keychain')
      expect(envelope.openWrappedKey(legacy, { keychain: true })).toEqual({ kind: 'keychain', text: 'content-key-b64' })
      expect(envelope.openWrappedKey(field, { keychain: false }).kind).toBe('foreign-key')
    })
  })
})
