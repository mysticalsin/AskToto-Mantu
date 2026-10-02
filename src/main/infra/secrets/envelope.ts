/**
 * Secret envelopes: the one place that turns text into at-rest bytes and back.
 *
 * Two backends write them: the per-install AES-256-GCM file key (secrets.ts) and the OS credential store
 * (keychain.ts). Every on-disk family is a format here: an optional marker per backend, an optional legacy
 * plaintext prefix, and what an unmarked buffer is. Bytes written before this module existed decode
 * unchanged, and seal() writes exactly the bytes those writers did.
 *
 * Markers (8 bytes, ASCII):
 *   ATKENC2\n  settings, AES-GCM file backend      ATKENC1\n  settings and transcripts, credential store
 *   ATKAES1\n  provider API keys, file backend     ATKMCP1\n / ATKBID1\n  MCP secrets, file backend
 *   (none)     bare blob: file-backend AES-GCM [12 IV][16 tag][ct], or a bare credential-store blob
 *
 * Invariants:
 *   - open() never throws and never writes. "Cannot be read here" is a value: a caller must be able to tell
 *     an intact-elsewhere blob (foreign-key) from a structurally broken one (malformed) and never treat
 *     either as an empty secret.
 *   - open() touches the credential store only when the caller says it may (`keychain`). The caller owns
 *     that decision because a forced local keystore must never open a Keychain prompt.
 *   - seal() never falls back to plaintext. It returns 'unavailable' instead, and a caller decides.
 */
import { decryptSecret, encryptSecret, prepareFileKeyForWrite, useFileBackend } from '../../secrets'
import { isKeychainAvailable, keychainDecrypt, keychainEncrypt } from './keychain'

const marker = (name: string): Buffer => Buffer.from(`${name}\n`)

/** Settings written by the file backend; also the leading marker of a transcript's JSON envelope. */
export const MARKER_ATKENC2 = marker('ATKENC2')
/** Settings and transcripts written directly by the credential store. */
export const MARKER_ATKENC1 = marker('ATKENC1')
export const MARKER_API_KEY_FILE = marker('ATKAES1')
export const MARKER_MCP_FILE = marker('ATKMCP1')
export const MARKER_BIDSTACK_FILE = marker('ATKBID1')

export interface EnvelopeFormat {
  /** Prefix of a file-backend blob; null when file-backend blobs are bare. */
  file: Buffer | null
  /** Prefix of a credential-store blob; null when those are bare. */
  keychain: Buffer | null
  /** Legacy plaintext prefix, stripped on read. */
  plainPrefix: Buffer | null
  /** What a buffer with none of the markers is: readable text, a bare credential-store blob, or a bare blob
   *  of either backend. */
  unmarked: 'plain' | 'keychain' | 'either'
}

/** settings.json: ATKENC2 file, ATKENC1 credential store, otherwise plain JSON. */
export const SETTINGS_FORMAT: EnvelopeFormat = {
  file: MARKER_ATKENC2,
  keychain: MARKER_ATKENC1,
  plainPrefix: null,
  unmarked: 'plain'
}

/** A secret file with a file-backend marker, a bare credential-store blob, and (when given) legacy plaintext. */
export const secretFileFormat = (file: Buffer, plainPrefix: Buffer | null = null): EnvelopeFormat => ({
  file,
  keychain: null,
  plainPrefix,
  unmarked: 'keychain'
})

/** Provider API keys, the Soniox key and the Dust refresh token. */
export const API_KEY_FORMAT = secretFileFormat(MARKER_API_KEY_FILE, Buffer.from('plain:'))

/** Bare blobs (session, token cache, license cache): no marker on either backend. */
export const BARE_FORMAT: EnvelopeFormat = { file: null, keychain: null, plainPrefix: null, unmarked: 'either' }

export type OpenOutcome =
  /** Readable without a key: legacy plaintext. */
  | { kind: 'plain'; text: string }
  /** Decrypted by the credential store. */
  | { kind: 'keychain'; text: string }
  /** Decrypted by the file-backend key. */
  | { kind: 'file'; text: string }
  /** A marker with no usable body: too short to hold a ciphertext. */
  | { kind: 'malformed'; reason: string }
  /** Well-formed, but written under a key this machine cannot use (or may not ask for): another OS user,
   *  a lost file key, or a credential store the caller ruled out. The bytes are intact elsewhere. */
  | { kind: 'foreign-key'; reason: string }

export interface OpenOptions {
  /** True when the credential store may be asked to decrypt. The caller folds in availability and any
   *  forced local keystore. */
  keychain: boolean
  /** For bare blobs: try the file key before the credential store. */
  fileFirst?: boolean
}

// [12 IV][16 tag] precede the ciphertext, which may be empty.
const MIN_FILE_BLOB = 12 + 16

/** True when `buf` begins with `marker`. */
export const hasMarker = (buf: Buffer, marker: Buffer): boolean =>
  buf.length >= marker.length && buf.subarray(0, marker.length).equals(marker)

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** An outcome of asking one backend: never plain. */
export type BackendOutcome =Exclude<OpenOutcome, { kind: 'plain' }>

function openFile(body: Buffer): BackendOutcome {
  if (body.length < MIN_FILE_BLOB) return { kind: 'malformed', reason: 'too short to be an AES-GCM ciphertext' }
  try {
    return { kind: 'file', text: decryptSecret(body) }
  } catch (e) {
    return { kind: 'foreign-key', reason: messageOf(e) }
  }
}

function openKeychain(body: Buffer, allowed: boolean): BackendOutcome {
  if (!allowed) return { kind: 'foreign-key', reason: 'the credential store is not available for this read' }
  try {
    return { kind: 'keychain', text: keychainDecrypt(body) }
  } catch (e) {
    return { kind: 'foreign-key', reason: messageOf(e) }
  }
}

export function open(buf: Buffer, format: EnvelopeFormat, options: OpenOptions): OpenOutcome {
  if (format.file && hasMarker(buf, format.file)) {
    return buf.length === format.file.length
      ? { kind: 'malformed', reason: 'marker without a body' }
      : openFile(buf.subarray(format.file.length))
  }
  if (format.keychain && hasMarker(buf, format.keychain)) {
    return buf.length === format.keychain.length
      ? { kind: 'malformed', reason: 'marker without a body' }
      : openKeychain(buf.subarray(format.keychain.length), options.keychain)
  }
  if (format.plainPrefix && hasMarker(buf, format.plainPrefix)) {
    return { kind: 'plain', text: buf.subarray(format.plainPrefix.length).toString('utf8') }
  }
  if (format.unmarked === 'plain') return { kind: 'plain', text: buf.toString('utf8') }
  if (format.unmarked === 'keychain') return openKeychain(buf, options.keychain)
  const attempts = options.fileFirst
    ? [() => openFile(buf), () => openKeychain(buf, options.keychain)]
    : [() => openKeychain(buf, options.keychain), () => openFile(buf)]
  let outcome: BackendOutcome = { kind: 'foreign-key', reason: 'no backend could read this blob' }
  for (const attempt of attempts) {
    outcome = attempt()
    if (outcome.kind === 'file' || outcome.kind === 'keychain') return outcome
  }
  return outcome
}

export type SealOutcome =
  | { kind: 'file'; bytes: Buffer }
  | { kind: 'keychain'; bytes: Buffer }
  /** The credential store cannot encrypt and the file backend is not in force: nothing safe to write. */
  | { kind: 'unavailable'; reason: string }

export interface SealOptions {
  /** Fail closed (KeychainKeyRecoveryError) before writing when this profile holds a file key that cannot
   *  be unlocked, so a fresh blob never replaces the only copy of an older secret. */
  prepareKey?: boolean
  /** Write with the file key when the credential store is unavailable, instead of 'unavailable'. */
  fallbackToFile?: boolean
}

const sealFile = (text: string, format: EnvelopeFormat): SealOutcome => ({
  kind: 'file',
  bytes: Buffer.concat([format.file ?? Buffer.alloc(0), encryptSecret(text)])
})

/**
 * Encrypt `text` under the backend in force: the file key when useFileBackend(), else the credential store.
 * A credential-store encryption failure propagates (fail closed) rather than downgrading the backend.
 */
export function seal(text: string, format: EnvelopeFormat, options: SealOptions = {}): SealOutcome {
  if (options.prepareKey) prepareFileKeyForWrite()
  if (useFileBackend()) return sealFile(text, format)
  if (!isKeychainAvailable()) {
    return options.fallbackToFile ? sealFile(text, format) : { kind: 'unavailable', reason: 'the credential store is unavailable' }
  }
  return { kind: 'keychain', bytes: Buffer.concat([format.keychain ?? Buffer.alloc(0), keychainEncrypt(text)]) }
}

// ── Wrapped content keys (transcript envelopes) ─────────────────────────────────────────────────────
// A transcript's per-file content key is stored as a string field: 'S:<base64>' wrapped by the credential
// store, 'F:<base64>' wrapped by the file key, or a bare base64 credential-store blob (written before the
// prefixes existed).

/** Wrap a content key under the backend in force. Never falls through to cleartext. */
export function sealWrappedKey(contentKeyB64: string): string {
  const sealed = seal(contentKeyB64, BARE_FORMAT, { fallbackToFile: true })
  if (sealed.kind === 'unavailable') throw new Error(sealed.reason)
  return (sealed.kind === 'keychain' ? 'S:' : 'F:') + sealed.bytes.toString('base64')
}

/** Which backend wrapped a content key field. */
export const wrappedKeyBackend = (field: string): 'file' | 'keychain' => (field.startsWith('F:') ? 'file' : 'keychain')

export function openWrappedKey(field: string, options: Pick<OpenOptions, 'keychain'>): BackendOutcome {
  if (wrappedKeyBackend(field) === 'file') return openFile(Buffer.from(field.slice(2), 'base64'))
  const raw = field.startsWith('S:') ? field.slice(2) : field
  return openKeychain(Buffer.from(raw, 'base64'), options.keychain)
}
