/**
 * secrets.ts — app-managed AES-256-GCM encrypted-file backend.
 *
 * WHY THIS EXISTS
 * Electron's safeStorage on macOS delegates to the system Keychain. The Keychain ties the
 * trust anchor to the binary's code signature. Every time a dev rebuild changes the signature
 * (which happens on every `npm run dev`), macOS throws a password-prompt modal asking the
 * user to allow access — a huge UX pain that blocks daily development.
 *
 * BACKEND SELECTION (checked per-call so env-var overrides work mid-run in tests):
 *   FILE backend — when ANY of:
 *     • !app.isPackaged   (dev / electron-vite dev mode)
 *     • process.env.ASKTOTO_LOCAL_KEYSTORE is set
 *     • safeStorage.isEncryptionAvailable() returns false (Linux without secret-service, CI)
 *   → Per-install 32-byte key persisted to <userData>/secret-key.bin (mode 0o600).
 *   → AES-256-GCM; format: [12-byte IV][16-byte authTag][ciphertext].
 *   → NEVER touches the macOS Keychain → no Keychain prompts in dev.
 *
 *   SAFE-STORAGE backend — packaged app, safeStorage available, env override off.
 *   → OS Keychain (macOS), Windows DPAPI, or Linux secret-service.
 *   → Callers continue to call safeStorage directly in the prod path; this module is the
 *     file-backend half only, imported where safeStorage was used before.
 *
 * CODE-SIGNING NOTE (prod):
 *   The file-backend REMOVES dev keychain prompts NOW. For production, code-signing still
 *   requires Tony's Apple Developer ID certificate. To sign + notarise:
 *     1. Export your Developer ID cert as a .p12 and set:
 *          CSC_LINK=<path or base64 of .p12>
 *          CSC_KEY_PASSWORD=<cert password>
 *          APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID   (for notarise)
 *     2. Run `npm run dist` — electron-builder reads those env vars automatically.
 *   The build works WITHOUT a cert (signing is skipped when no CSC_LINK is set).
 *   electron-builder.yml already has hardenedRuntime:true and the entitlements wired.
 */

import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const KEY_FILE = 'secret-key.bin'
const ALG = 'aes-256-gcm' as const

/** Byte lengths for the [IV][tag][ciphertext] wire format. */
const IV_LEN = 12
const TAG_LEN = 16

/** Cached per-install key — module-level singleton, never re-read after first load. */
let _key: Buffer | null = null

/**
 * True when the AES-GCM file backend should be used for crypto operations.
 * Evaluated per-call so env-var changes (e.g. integration tests) are respected
 * without restarting the process.
 */
export function useFileBackend(): boolean {
  try {
    return !app.isPackaged || !!process.env.ASKTOTO_LOCAL_KEYSTORE || !safeStorage.isEncryptionAvailable()
  } catch {
    // app not ready (test environment) — default to file backend
    return true
  }
}

/**
 * Load or generate the per-install AES-256-GCM key.
 * Persisted to <userData>/secret-key.bin with mode 0o600.
 * Created once on first use; stable for the lifetime of the userData directory.
 * If the file is present but has the wrong length (truncated / corrupt), it is regenerated.
 *
 * KEY-ENCRYPTION-KEY (KEK):
 *   When safeStorage.isEncryptionAvailable() is true the 32-byte key is wrapped with
 *   safeStorage.encryptString(base64(key)) before writing, so a bare copy of secret-key.bin
 *   is not directly usable without this device's keychain.
 *   Legacy files (exactly 32 raw bytes, written before this change) are detected on read and
 *   migrated to the wrapped format in-place.
 *   When safeStorage is unavailable (Linux / CI), the raw key is written as before.
 */
function getOrCreateKey(): Buffer {
  if (_key) return _key

  const p = join(app.getPath('userData'), KEY_FILE)
  const canWrap = safeStorage.isEncryptionAvailable()

  if (existsSync(p)) {
    const buf = readFileSync(p)
    if (canWrap) {
      if (buf.length === 32) {
        // Legacy raw key written before KEK support — migrate to wrapped format now.
        _key = buf
        try {
          writeFileSync(p, safeStorage.encryptString(buf.toString('base64')), { mode: 0o600 })
        } catch {
          // Migration is best-effort; the raw key is still usable this session.
        }
      } else {
        // safeStorage-wrapped key (new format) — unwrap.
        _key = Buffer.from(safeStorage.decryptString(buf), 'base64')
      }
    } else {
      // No keychain available now. A raw 32-byte key is usable directly.
      if (buf.length === 32) {
        _key = buf
      } else if (buf.length > 0) {
        // Non-empty but not a raw key — almost certainly a safeStorage-WRAPPED key written
        // when the keychain WAS available (availability has since flipped to false). Regenerating
        // here would silently destroy every existing encrypted secret, session, and transcript
        // content-key. Fail-closed: refuse to overwrite so the data stays recoverable once the
        // keychain returns. (A genuinely zero-byte file falls through to regeneration below.)
        throw new Error(
          'secrets: key file is keychain-wrapped but the keychain is unavailable; refusing to regenerate (would lose existing encrypted data)'
        )
      }
      // else (empty file): fall through to regenerate.
    }
    if (_key) return _key
  }

  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  _key = randomBytes(32)
  if (canWrap) {
    writeFileSync(p, safeStorage.encryptString(_key.toString('base64')), { mode: 0o600 })
  } else {
    writeFileSync(p, _key, { mode: 0o600 })
  }
  return _key
}

/**
 * Encrypt `data` with AES-256-GCM using the per-install file key.
 * Output format: [12-byte IV][16-byte authTag][ciphertext].
 *
 * Every call uses a fresh IV so identical plaintexts produce distinct ciphertexts.
 * The returned Buffer is what callers write directly to disk.
 */
export function encryptSecret(data: string | Buffer): Buffer {
  const key = getOrCreateKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, key, iv)
  const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()])
  const authTag = cipher.getAuthTag() // always TAG_LEN (16) bytes for GCM
  return Buffer.concat([iv, authTag, ciphertext])
}

/**
 * Decrypt a buffer produced by `encryptSecret`.
 * Throws if the buffer is too short, the authentication tag is wrong, or the key doesn't match.
 * Callers should catch and treat as "not our format" to trigger safeStorage migration.
 */
export function decryptSecret(buf: Buffer): string {
  if (buf.length < IV_LEN + TAG_LEN) {
    // A valid envelope is [12 IV][16 tag][N ciphertext]; N may be 0 (empty plaintext encrypts
    // to exactly IV_LEN+TAG_LEN bytes), so the floor is IV_LEN+TAG_LEN, not +1.
    throw new Error('secrets: buffer too short to be a valid AES-GCM ciphertext')
  }
  const key = getOrCreateKey()
  const iv = buf.subarray(0, IV_LEN)
  const authTag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALG, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
