import { safeStorage } from 'electron'
import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { constants, createCipheriv, createDecipheriv, publicEncrypt, randomBytes } from 'node:crypto'
import { auditLog, mainLog } from '../../logger'
import { decryptSecret, encryptSecret, useFileBackend } from '../../secrets'
import { devEnv, isPackagedBuild } from '../../dev-env'
import { readTrustedAdminManaged } from '../../win-security'

// Optional at-rest encryption for transcripts/notes. Two on-disk formats share one fixed-length
// `ATKENC<n>\n` magic prefix so detection stays a simple prefix check:
//   v1 (legacy) — ENC_MARKER + safeStorage.encryptString(plaintext). OS-keychain-direct.
//   v2 (envelope) — ENC_MARKER_V2 + JSON: a per-file random AES-256-GCM content key encrypts the
//     transcript; the content key is wrapped for the LOCAL keychain (kLocal, always) and, when an org
//     escrow public key is configured, also for an out-of-band admin (kEscrow). Envelope encryption lets
//     an org recover a transcript via the escrow private key even if the device/keychain is lost.
const ENC_MARKER = Buffer.from('ATKENC1\n')
const ENC_MARKER_V2 = Buffer.from('ATKENC2\n')
const MARKER_LEN = ENC_MARKER.length // v1 and v2 markers are the same length — share one prefix check

type EnvelopeV2 = {
  v: 2
  iv: string // base64, AES-GCM nonce (12 bytes)
  tag: string // base64, AES-GCM auth tag (16 bytes)
  ct: string // base64, AES-256-GCM ciphertext of the transcript
  kLocal: string // base64, safeStorage-wrapped content key (this device can always decrypt)
  kEscrow?: string // base64, RSA-OAEP(content key) under the org escrow public key — written, never read here
}

export type RewrapRecoveredEnvelope = (filePath: string, bytes: Buffer) => void

// The machine-wide managed-config path + its win32 admin-trust gate live in win-security.ts. This
// matters most here: a forged, user-writable %ProgramData%\Métis\managed-config.json could set
// `escrowPubKey` to an attacker key and silently escrow every future transcript to them. The trust gate
// (admin-owned + no Users-write ACE) blocks that on Windows; root-owned dirs enforce it on macOS/Linux.

/** Resolve a configured value to a PEM public key: inline PEM, a file path to one, or base64-wrapped PEM. */
async function resolveEscrowPem(raw: string | null | undefined): Promise<string | null> {
  const v = (raw || '').trim()
  if (!v) return null
  if (v.includes('-----BEGIN')) return v // inline PEM (env can hold newlines; managed-config a JSON string)
  try {
    await access(v)
    const f = await readFile(v, 'utf8')
    if (f.includes('-----BEGIN')) return f
  } catch {
    /* not a readable path */
  }
  try {
    const dec = Buffer.from(v, 'base64').toString('utf8') // base64-wrapped PEM (env-var-friendly)
    if (dec.includes('-----BEGIN')) return dec
  } catch {
    /* not base64 */
  }
  return null
}

/** One warning per process — readEscrowPubKey runs on every encrypted write. */
let warnedIgnoredEscrowEnv = false

/** Raw-parse an `escrowPubKey` string out of managed-config.json text (escrow isn't a Settings schema key). */
function escrowFromManagedContent(raw: string): string | null {
  try {
    const obj = JSON.parse(raw)
    return typeof obj?.escrowPubKey === 'string' ? obj.escrowPubKey : null
  } catch {
    return null
  }
}

/**
 * Org escrow public key (PEM), if configured. Precedence: env ASKTOTO_ESCROW_PUBKEY (dev) → machine-wide
 * ADMIN-TRUSTED managed-config (IT policy) ONLY. Returns null when unset/unusable, so encryption silently
 * falls back to local-only (no regression). Never throws; never logs key material.
 *
 * SECURITY: escrow decides WHO can decrypt every future transcript, so it must never be honored from a
 * user-writable source. The per-user `userData/managed-config.json` is writable by the current user (and
 * anything running as them), so a planted `escrowPubKey` there would silently wrap every transcript to an
 * attacker key (readable off OneDrive). Escrow is therefore admin-machine-path-only (ACL-gated by
 * trustedAdminManagedPath) or env (dev) — the per-user tier is deliberately NOT consulted here.
 *
 * The process environment is user-writable on exactly the same terms (HKCU\Environment, `launchctl
 * setenv`), so devEnv() closes the env tier in packaged builds.
 */
async function readEscrowPubKey(): Promise<string | null> {
  const fromEnv = await resolveEscrowPem(devEnv('ASKTOTO_ESCROW_PUBKEY'))
  if (fromEnv) return fromEnv
  // An install that was configured through the dev variable would otherwise lose escrow in silence: the
  // warn below only fires for a key we actually tried to use.
  if (!warnedIgnoredEscrowEnv && process.env.ASKTOTO_ESCROW_PUBKEY && isPackagedBuild()) {
    warnedIgnoredEscrowEnv = true
    mainLog.warn(
      'Métis: ASKTOTO_ESCROW_PUBKEY is a dev-only switch and is ignored in a packaged build; set escrowPubKey in the machine-wide managed-config instead'
    )
  }
  try {
    // readTrustedAdminManaged() is null on win32 unless admin-owned + not user-writable, and reads
    // through the same held fd that verified that trust (closes the check-path/read-path TOCTOU).
    const admin = readTrustedAdminManaged()
    const machine = admin ? await resolveEscrowPem(escrowFromManagedContent(admin)) : null
    if (machine) return machine
  } catch {
    /* ignore */
  }
  return null
}

// The ONE native boundary in this file, and the one place a read can die in a way no JS can observe.
//
// safeStorage.decryptString drops into Chromium's OSCrypt. Its Windows implementation
// (components/os_crypt/sync/os_crypt_win.cc) reads a 'v10'-prefixed blob as 'v10' + 12-byte nonce +
// AES-GCM ciphertext + tag, and slices out the body with `ciphertext.substr(15)` — no length check
// first. std::string::substr throws std::out_of_range when the position is past the end, and that is a
// native C++ exception (0xE06D7363): it unwinds straight past V8, so `uncaughtException`, the
// surrounding try/catch, and every fatal handler this app installs are all blind to it. The process
// simply vanishes — no window, no dialog, no crash-*.log, no audit line. A bad blob that is merely
// WRONG (right length, wrong bytes) is fine — OSCrypt returns false and Electron throws an ordinary JS
// error. Only a SHORT one kills the process.
//
// So the length is checked here, on the JS side, before the boundary is crossed. The bound is exactly
// the position os_crypt_win.cc indexes to, not the size of a well-formed blob: a real Windows envelope
// is at least 31 bytes (3 + 12 + 16) and macOS's AES-128-CBC form at least 19, so anything legitimate
// clears this by a wide margin while every blob that could throw is refused as a normal JS Error — which
// tryDecodeSaved below already turns into a typed "undecryptable" outcome.
const OSCRYPT_V10_PREFIX = Buffer.from('v10', 'utf8')
const OSCRYPT_V10_MIN_INDEXABLE = OSCRYPT_V10_PREFIX.length + 12 // the substr(15) os_crypt_win.cc does

function unwrapWithKeychain(blob: Buffer): string {
  if (blob.length === 0) throw new Error('wrapped key is empty')
  if (blob.subarray(0, OSCRYPT_V10_PREFIX.length).equals(OSCRYPT_V10_PREFIX) && blob.length < OSCRYPT_V10_MIN_INDEXABLE) {
    throw new Error('wrapped key is a truncated OSCrypt v10 blob')
  }
  return safeStorage.decryptString(blob)
}

/**
 * Build the v2 envelope on-disk buffer (marker + JSON).
 *
 * kLocal encoding — a prefix selects the unwrap path on read:
 *   'S:<base64>' — content key wrapped by safeStorage (OS keychain, preferred).
 *   'F:<base64>' — content key wrapped by the AES-GCM file backend in secrets.ts
 *                  (used when the keychain is unavailable: Linux, CI, no secret-service).
 *   '<bare base64>' — legacy: written before this change; treated as safeStorage on read.
 *
 * The content key is always encrypted at rest. This function never falls through to cleartext —
 * callers should let any error propagate (fail-closed).
 */
async function encryptEnvelopeV2(content: string): Promise<Buffer> {
  const contentKey = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
  const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // LOCAL wrap: prefer the OS keychain (safeStorage); when the file backend is in force (un-notarized
  // build — see the keystore note in index.ts) or safeStorage is unavailable (Linux / CI / no
  // secret-service), wrap with the AES-GCM file-backend key from secrets.ts instead so recording never
  // triggers a Keychain prompt mid-meeting. Either way the content key is always encrypted at rest.
  let kLocalField: string
  if (!useFileBackend() && safeStorage.isEncryptionAvailable()) {
    kLocalField = 'S:' + safeStorage.encryptString(contentKey.toString('base64')).toString('base64')
  } else {
    kLocalField = 'F:' + encryptSecret(contentKey.toString('base64')).toString('base64')
  }
  const env: EnvelopeV2 = {
    v: 2,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
    kLocal: kLocalField
  }
  // ESCROW wrap (only when configured): RSA-OAEP(content key) so an admin holding the org PRIVATE key can
  // recover the content key out-of-band. The app only ever WRITES kEscrow; it never reads it.
  const pem = await readEscrowPubKey()
  if (pem) {
    try {
      const kEscrow = publicEncrypt(
        { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        contentKey
      )
      env.kEscrow = kEscrow.toString('base64')
    } catch {
      // A malformed escrow key must not break saving (no regression): write local-only. Never log key material.
      // mainLog (not console.warn) so this is visible in packaged builds' rotated log file, plus a
      // metadata-only audit record (no secrets/PII) so an admin relying on escrow recovery can see the gap.
      mainLog.warn('Métis: escrow public key configured but unusable; wrote transcript without escrow wrap')
      auditLog('transcript.saved', { escrowFailed: true })
    }
  }
  return Buffer.concat([ENC_MARKER_V2, Buffer.from(JSON.stringify(env), 'utf8')])
}

/** Decrypt a v2 envelope. Handles the 'S:' (safeStorage), 'F:' (file-backend), and legacy (bare
 *  base64) kLocal encodings. Throws on malformed/foreign-keychain input so tryDecodeSaved can turn it
 *  into a typed failure (SavedDecode) instead of crashing a read.
 *
 *  `allowKeychainRecovery` (default false, the boot/bulk-read behavior — see index.ts's forced local
 *  keystore note) lets an explicit single-file user read reach an 'S:'-wrapped envelope anyway when this
 *  device's Keychain can still unwrap it: the forced keystore stops the boot-time Keychain PROMPT, but the
 *  'asktoto Safe Storage' Keychain item itself still exists on a device that recorded before the forced
 *  keystore shipped, so refusing the read there was throwing away recoverable meetings, not protecting them.
 *  `filePath`, when given, lets a successful recovery self-heal (see the rewrap below). */
function decryptEnvelopeV2(
  buf: Buffer,
  allowKeychainRecovery = false,
  filePath?: string,
  rewrapRecovered?: RewrapRecoveredEnvelope
): string {
  const env = JSON.parse(buf.subarray(MARKER_LEN).toString('utf8')) as EnvelopeV2
  let contentKeyB64: string
  if (env.kLocal.startsWith('F:')) {
    // File-backend path: content key was wrapped by secrets.ts AES-GCM (no keychain required).
    contentKeyB64 = decryptSecret(Buffer.from(env.kLocal.slice(2), 'base64'))
  } else {
    // safeStorage path: 'S:' prefix (new) or legacy bare base64 (no prefix, backward compat).
    const canRecover = allowKeychainRecovery && safeStorage.isEncryptionAvailable()
    if (process.env.ASKTOTO_LOCAL_KEYSTORE && !canRecover) {
      throw new Error('Keychain-wrapped transcript is unavailable while the local keystore is active')
    }
    const raw = env.kLocal.startsWith('S:') ? env.kLocal.slice(2) : env.kLocal
    contentKeyB64 = unwrapWithKeychain(Buffer.from(raw, 'base64'))
    // Self-healing: this device's Keychain just proved it can still unwrap the SAME content key —
    // rewrap it under the current file-backend key so every later read (bulk list/search included)
    // converges to 'F:' without ever touching the Keychain again. iv/tag/ct are untouched; only kLocal
    // changes. Atomic tmp+rename (mirrors writeSaved above), done synchronously like store.ts's own
    // legacy-format migration since this runs inside an otherwise-synchronous read. Best-effort: a
    // rewrap failure must never fail this read — the caller already has the decrypted content either way.
    //
    // Only converge when the file backend is the ACTIVE write backend. On packaged Windows it is not:
    // safeStorage (DPAPI) is the writer, so every new transcript is 'S:', and safeStorage.isEncryptionAvailable()
    // is always true there — which made canRecover true and rewrapped every meeting to 'F:' the moment it was
    // opened, silently materialising a secret-key.bin the profile never needed and moving the meeting off DPAPI.
    // Gating on useFileBackend() keeps the convergence for the macOS forced-keystore case it was written for
    // and makes it a no-op wherever safeStorage is the writer.
    if (canRecover && filePath && useFileBackend() && rewrapRecovered) {
      try {
        const updated: EnvelopeV2 = { ...env, kLocal: 'F:' + encryptSecret(contentKeyB64).toString('base64') }
        rewrapRecovered(filePath, Buffer.concat([ENC_MARKER_V2, Buffer.from(JSON.stringify(updated), 'utf8')]))
      } catch {
        /* best-effort self-heal */
      }
    }
  }
  const contentKey = Buffer.from(contentKeyB64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(env.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8')
}

/** The outcome of decoding saved bytes. "Cannot be decrypted here" is a VALUE, never an exception. */
export type SavedDecode = { ok: true; text: string } | { ok: false; reason: string }

/** Classify an at-rest envelope by marker only. No decryption, key access, or filesystem writes. */
export function envelopeKeyKind(buf: Buffer): 'plain' | 'keychain' | 'file' | 'malformed' {
  if (buf.length >= MARKER_LEN && buf.subarray(0, MARKER_LEN).equals(ENC_MARKER_V2)) {
    try {
      const env = JSON.parse(buf.subarray(MARKER_LEN).toString('utf8')) as { kLocal?: unknown }
      if (typeof env.kLocal !== 'string') return 'malformed'
      return env.kLocal.startsWith('F:') ? 'file' : 'keychain'
    } catch {
      return 'malformed'
    }
  }
  if (buf.length >= ENC_MARKER.length && buf.subarray(0, ENC_MARKER.length).equals(ENC_MARKER)) return 'keychain'
  return 'plain'
}

/** Decode saved bytes, decrypting if the at-rest marker is present.
 *  `allowKeychainRecovery`/`filePath` are forwarded to decryptEnvelopeV2 — see its doc comment; the v1
 *  legacy branch below gets the same recovery bypass but never self-heals (no envelope kLocal to rewrap). */
export function tryDecodeSaved(
  buf: Buffer,
  allowKeychainRecovery = false,
  filePath?: string,
  rewrapRecovered?: RewrapRecoveredEnvelope
): SavedDecode {
  // v2 envelope: AES-256-GCM content key wrapped by safeStorage (+ optional org escrow).
  if (buf.length >= MARKER_LEN && buf.subarray(0, MARKER_LEN).equals(ENC_MARKER_V2)) {
    try {
      return { ok: true, text: decryptEnvelopeV2(buf, allowKeychainRecovery, filePath, rewrapRecovered) }
    } catch (e) {
      // malformed, auth-tag failure, or foreign keychain — never throw out of a read path
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  // v1 (legacy): safeStorage-direct. Kept for full backward compatibility with existing transcripts.
  if (buf.length >= ENC_MARKER.length && buf.subarray(0, ENC_MARKER.length).equals(ENC_MARKER)) {
    const canRecover = allowKeychainRecovery && safeStorage.isEncryptionAvailable()
    if (process.env.ASKTOTO_LOCAL_KEYSTORE && !canRecover) {
      return { ok: false, reason: 'keychain-wrapped transcript is unavailable while the local keystore is active' }
    }
    try {
      return { ok: true, text: unwrapWithKeychain(buf.subarray(ENC_MARKER.length)) }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  return { ok: true, text: buf.toString('utf8') }
}

/** Decode saved bytes into the typed outcome above. Never throws. */
export function decodeSavedResult(buf: Buffer): SavedDecode {
  return tryDecodeSaved(buf)
}

/** Decode saved bytes, decrypting if needed. Never throws; yields '' for an undecryptable file so
 *  search/list keep working. Use decodeSavedResult() when '' and "unreadable" must not be confused. */
export function decodeSaved(buf: Buffer): string {
  const r = tryDecodeSaved(buf)
  return r.ok ? r.text : ''
}

export function isEncryptedBytes(bytes: Buffer): boolean {
  const head = bytes.subarray(0, MARKER_LEN)
  return head.equals(ENC_MARKER) || head.equals(ENC_MARKER_V2)
}

/** Atomic write; encrypts at rest when `encrypt` is true. Cleans up temp on failure. */
export async function writeSaved(file: string, content: string, encrypt: boolean): Promise<void> {
  let data: Buffer = Buffer.from(content, 'utf8')
  if (encrypt) {
    // encryptEnvelopeV2 always produces an ATKENC2-marked encrypted envelope — safeStorage path
    // when the keychain is available, AES-GCM file-backend path otherwise. Any error propagates
    // to the caller (fail-closed): plaintext is never silently written when encryption is on.
    data = await encryptEnvelopeV2(content)
  }
  // Unique per-call tmp name: two concurrent writers to the SAME target (e.g. a background brain
  // ingest and an IPC-driven edit both updating one entity file) would otherwise share `${file}.tmp` —
  // the first rename steals the second writer's bytes and the second rename throws ENOENT.
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data, { mode: 0o600 }) // async: off the main-process event loop
    // The default meetings folder lives under OneDrive, which routinely holds a just-written file
    // open (upload hashing) or gets grabbed by AV/EDR real-time scanning — rename() then throws
    // EPERM/EBUSY on Windows even though nothing is actually wrong. Bounded retry rides out that
    // transient lock instead of losing the save; any other error (or exhausted retries) still throws.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file)
        break
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 4) throw e
        await new Promise((r) => setTimeout(r, 40 * 2 ** attempt))
      }
    }
  } catch (e) {
    try {
      await unlink(tmp) // don't leave an orphaned .tmp on failure
    } catch {
      /* ignore */
    }
    throw e
  }
}
