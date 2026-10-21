import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { decryptSecret, encryptSecret, useFileBackend } from '../../secrets'
import { atomicSavedWrite } from '../storage/atomic-saved-write'

/**
 * Per-file content-key custody, shared by the at-rest transcript envelope (transcripts.ts) and the live
 * meeting journal's `key.v1` file.
 *
 * A content key is 32 random bytes. It is never stored in the clear: it is wrapped, as the base64 text of
 * the key, by either the OS keychain or the AES-GCM file backend in secrets.ts, and the wrapped form carries
 * a prefix that selects the unwrap path on read:
 *   'S:<base64>' - wrapped by safeStorage (OS keychain, preferred).
 *   'F:<base64>' - wrapped by the file backend (un-notarized builds, Linux, CI, no secret-service).
 *   '<bare base64>' - legacy keychain form written before the prefixes existed; read as 'S:'.
 * Key material and wrapped values are never logged and never placed in an error message.
 */

export const CONTENT_KEY_BYTES = 32

export type ContentKeyWrapResult = { ok: true; wrapped: string } | { ok: false; reason: 'unavailable'; error: unknown }

export type ContentKeyUnwrapResult =
  | {
      ok: true
      /** Fresh buffer owned by the caller, who must zero it (`fill(0)`) when done. */
      key: Buffer
      /**
       * True when the wrapped key was keychain-wrapped and this device's keychain is allowed to recover it
       * (explicit single-file read, safeStorage available). Callers use it to decide on self-healing.
       */
      keychainRecovery: boolean
    }
  // The forced local keystore refuses a keychain-wrapped key (no keychain prompt, no silent decrypt).
  | { ok: false; reason: 'refused'; error: Error }
  // Malformed, truncated, foreign-keychain or missing-file-key input.
  | { ok: false; reason: 'unavailable'; error: unknown }

export interface UnwrapContentKeyOptions {
  /** Default false (the boot/bulk-read behaviour): an explicit single-file read may pass true. */
  allowKeychainRecovery?: boolean
}

export function generateContentKey(): Buffer {
  return randomBytes(CONTENT_KEY_BYTES)
}

// The ONE native boundary for keychain unwrap, and the one place a read can die in a way no JS can observe.
//
// safeStorage.decryptString drops into Chromium's OSCrypt. Its Windows implementation
// (components/os_crypt/sync/os_crypt_win.cc) reads a 'v10'-prefixed blob as 'v10' + 12-byte nonce +
// AES-GCM ciphertext + tag, and slices out the body with `ciphertext.substr(15)` — no length check
// first. std::string::substr throws std::out_of_range when the position is past the end, and that is a
// native C++ exception (0xE06D7363): it unwinds straight past V8, so `uncaughtException`, the
// surrounding try/catch, and every fatal handler this app installs are all blind to it. The process
// simply vanishes — no window, no dialog, no crash-*.log, no audit line. That is MQA-175, observed on
// six consecutive launches of the shipped 1.5.4 Windows build against a sync-mangled
// `.brain/index.json`. A bad blob that is merely WRONG (right length, wrong bytes) is fine — OSCrypt
// returns false and Electron throws an ordinary JS error. Only a SHORT one kills the process.
//
// So the length is checked here, on the JS side, before the boundary is crossed. The bound is exactly
// the position os_crypt_win.cc indexes to, not the size of a well-formed blob: a real Windows envelope
// is at least 31 bytes (3 + 12 + 16) and macOS's AES-128-CBC form at least 19, so anything legitimate
// clears this by a wide margin while every blob that could throw is refused as a normal JS Error.
const OSCRYPT_V10_PREFIX = Buffer.from('v10', 'utf8')
const OSCRYPT_V10_MIN_INDEXABLE = OSCRYPT_V10_PREFIX.length + 12 // the substr(15) os_crypt_win.cc does

/** Unwrap a raw safeStorage blob (also the legacy v1 transcript body). Throws an ordinary Error on bad input. */
export function unwrapWithKeychain(blob: Buffer): string {
  if (blob.length === 0) throw new Error('wrapped key is empty')
  if (
    blob.subarray(0, OSCRYPT_V10_PREFIX.length).equals(OSCRYPT_V10_PREFIX) &&
    blob.length < OSCRYPT_V10_MIN_INDEXABLE
  ) {
    throw new Error('wrapped key is a truncated OSCrypt v10 blob')
  }
  return safeStorage.decryptString(blob)
}

/** Wrap with the AES-GCM file backend regardless of keystore policy (also the self-heal rewrap target). */
export function wrapContentKeyWithFileBackend(key: Buffer): string {
  return 'F:' + encryptSecret(key.toString('base64')).toString('base64')
}

/**
 * Wrap a content key. Prefers the OS keychain; when the file backend is in force (un-notarized build) or
 * safeStorage is unavailable, wraps with the file backend instead so recording never triggers a Keychain
 * prompt mid-meeting. Never falls through to cleartext: a failure is returned as `unavailable`.
 */
export function wrapContentKey(key: Buffer): ContentKeyWrapResult {
  try {
    if (!useFileBackend() && safeStorage.isEncryptionAvailable()) {
      return { ok: true, wrapped: 'S:' + safeStorage.encryptString(key.toString('base64')).toString('base64') }
    }
    return { ok: true, wrapped: wrapContentKeyWithFileBackend(key) }
  } catch (error) {
    return { ok: false, reason: 'unavailable', error }
  }
}

/** Unwrap a content key from any of the three wrapped forms. Never throws. */
export function unwrapContentKey(wrapped: string, options: UnwrapContentKeyOptions = {}): ContentKeyUnwrapResult {
  const allowKeychainRecovery = options.allowKeychainRecovery ?? false
  try {
    if (wrapped.startsWith('F:')) {
      // File-backend path: wrapped by secrets.ts AES-GCM (no keychain required).
      return {
        ok: true,
        key: Buffer.from(decryptSecret(Buffer.from(wrapped.slice(2), 'base64')), 'base64'),
        keychainRecovery: false
      }
    }
    // safeStorage path: 'S:' prefix, or legacy bare base64 (no prefix).
    const canRecover = allowKeychainRecovery && safeStorage.isEncryptionAvailable()
    if (process.env.ASKTOTO_LOCAL_KEYSTORE && !canRecover) {
      return {
        ok: false,
        reason: 'refused',
        error: new Error('Keychain-wrapped transcript is unavailable while the local keystore is active')
      }
    }
    const raw = wrapped.startsWith('S:') ? wrapped.slice(2) : wrapped
    return {
      ok: true,
      key: Buffer.from(unwrapWithKeychain(Buffer.from(raw, 'base64')), 'base64'),
      keychainRecovery: canRecover
    }
  } catch (error) {
    return { ok: false, reason: 'unavailable', error }
  }
}

// ---- Wrapped-key file (the live meeting journal's <userData>/meeting-journal/<uuid>/key.v1) ----

const KEY_FILE_MAX_BYTES = 4096
const WRAPPED_FORM = /^[SF]:[A-Za-z0-9+/]+={0,2}$/

export type WrappedKeyFileWriteResult = { ok: true } | { ok: false; reason: 'unavailable'; error: unknown }

export type WrappedKeyFileReadResult =
  | { ok: true; wrapped: string }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'corrupt' }
  | { ok: false; reason: 'unavailable'; error: unknown }

/** Persist a wrapped key as `{"v":1,"kLocal":...}` (mode 0600, atomic replace). Only prefixed forms are accepted. */
export async function writeWrappedKeyFile(path: string, wrapped: string): Promise<WrappedKeyFileWriteResult> {
  try {
    if (!WRAPPED_FORM.test(wrapped)) throw new Error('wrapped key is not a prefixed wrapped form')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await atomicSavedWrite(path, Buffer.from(JSON.stringify({ v: 1, kLocal: wrapped }), 'utf8'))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: 'unavailable', error }
  }
}

/** Read and validate a wrapped-key file. A missing file, a malformed file and an I/O failure are distinct typed results. */
export async function readWrappedKeyFile(path: string): Promise<WrappedKeyFileReadResult> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > KEY_FILE_MAX_BYTES) return { ok: false, reason: 'corrupt' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'unavailable', error }
  }
  let text: string
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(KEY_FILE_MAX_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > KEY_FILE_MAX_BYTES) return { ok: false, reason: 'corrupt' }
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close().catch(() => {})
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'unavailable', error }
  }
  try {
    const parsed = JSON.parse(text) as { v?: unknown; kLocal?: unknown }
    if (parsed.v !== 1 || typeof parsed.kLocal !== 'string' || !WRAPPED_FORM.test(parsed.kLocal)) {
      return { ok: false, reason: 'corrupt' }
    }
    return { ok: true, wrapped: parsed.kLocal }
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
}
