/**
 * The OS credential store (macOS Keychain, Windows DPAPI, Linux secret-service) behind Electron's
 * safeStorage. This is the only module in the main process that references safeStorage; every other module
 * seals and opens secrets through envelope.ts.
 */
import { safeStorage } from 'electron'

// The one native boundary, and the one place a read can die in a way no JS can observe.
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

/** True when the credential store can encrypt now. False (never a throw) when Electron is not ready. */
export function isKeychainAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function keychainEncrypt(plaintext: string): Buffer {
  return safeStorage.encryptString(plaintext)
}

/** Throws an ordinary Error for an empty, truncated, foreign or corrupt blob; never crosses the native
 *  boundary with a blob that could kill the process. */
export function keychainDecrypt(blob: Buffer): string {
  if (blob.length === 0) throw new Error('wrapped key is empty')
  if (blob.subarray(0, OSCRYPT_V10_PREFIX.length).equals(OSCRYPT_V10_PREFIX) && blob.length < OSCRYPT_V10_MIN_INDEXABLE) {
    throw new Error('wrapped key is a truncated OSCrypt v10 blob')
  }
  return safeStorage.decryptString(blob)
}
