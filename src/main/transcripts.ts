import { app, safeStorage } from 'electron'
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  renameSync
} from 'node:fs'
import { unlink } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { join, basename, dirname } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv, publicEncrypt, constants } from 'node:crypto'
import type {
  SaveDraftTranscriptResult,
  SaveMeeting,
  SaveNote,
  Settings,
  RecapExport,
  TranscriptLine
} from '@shared/ipc'
import { LiveMeetingStartedAtSchema } from '@shared/ipc'
import { isSummaryOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import { useFileBackend } from './secrets'
import {
  generateContentKey,
  unwrapContentKey,
  unwrapWithKeychain,
  wrapContentKey,
  wrapContentKeyWithFileBackend
} from './infra/security/content-key-wrap'
import { readTrustedAdminManaged, lockPathToCurrentUserWin32 } from './win-security'
import { mainLog, auditLog } from './logger'
import { resolveMeetingsFolder } from './infra/storage/paths'
import { devEnv, isPackagedBuild } from './dev-env'
import { safeMeetingBasename } from './meeting-path'
import { refuseIfDemoTagged } from '@shared/demo-guard'
import { recapStatusValidationError } from '@shared/recap-status'
import { meetingDurationMinutes } from '@shared/meeting-duration'
import { classifyAll, storageAt } from './infra/storage/meetings-storage'
import { atomicSavedWrite } from './infra/storage/atomic-saved-write'
import {
  draftFilename,
  finalizeDraftMeeting,
  isDraftMeetingFinalized,
  serializeDraftWrite,
  knownDraftPathsForMeeting,
  trackDraftWrite
} from './infra/storage/draft-transcript-write-state'
import { createWriteAdmissionGuard } from './infra/storage/write-with-admission'
import type { FileClass } from './infra/storage/gateway'
import { speakerLabel } from './features/meetings/transcript-format'
import {
  buildDraftTranscriptDocument,
  promoteDraftTranscript,
  recoveredDraftIndexFields
} from './features/meetings/draft-transcript-document'
import {
  cleanTitle,
  escapeHeadingLines,
  opaqueNamePart,
  slug,
  stamp
} from './features/meetings/transcript-document-format'
import {
  decryptMeetingEnvelopeAsync,
  encryptMeetingEnvelopeAsync,
  getMeetingSpeechReadLimitBytes,
  isMeetingSpeechPersistenceConfigured,
  reportMeetingSpeechTiming,
  renderMeetingTranscriptAsync,
  rewrapMeetingEnvelopeAsync
} from './features/meetings/meeting-speech'
import {
  escapeSpeechMarkers,
  meetingSpeechTailOffset,
  refuseReservedSpeechProse
} from './features/meetings/speech-provenance'
import { buildMeetingSaveDocument } from './features/meetings/meeting-save-document'
import {
  applyDebriefSection,
  buildNoteDocument,
  DEBRIEF_HEADING,
  formatIndexRow,
  indexDateString,
  INDEX_HEADER,
  README
} from './transcript-markdown-documents'
import { draftCleanupCandidates } from './transcript-draft-cleanup'
import { parseRecapMarkdown } from './transcripts-recap'
import { readEnvelopeLocalKey } from './transcript-envelope-reader'

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

// The machine-wide managed-config path + its win32 admin-trust gate live in win-security.ts. This
// matters most here: a forged, user-writable %ProgramData%\Métis\managed-config.json could set
// `escrowPubKey` to an attacker key and silently escrow every future transcript to them. The trust gate
// (admin-owned + no Users-write ACE) blocks that on Windows; root-owned dirs enforce it on macOS/Linux.

/** Resolve a configured value to a PEM public key: inline PEM, a file path to one, or base64-wrapped PEM. */
function resolveEscrowPem(raw: string | null | undefined): string | null {
  const v = (raw || '').trim()
  if (!v) return null
  if (v.includes('-----BEGIN')) return v // inline PEM (env can hold newlines; managed-config a JSON string)
  try {
    if (existsSync(v)) {
      const f = readFileSync(v, 'utf8')
      if (f.includes('-----BEGIN')) return f
    }
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
 * setenv`), so devEnv() closes the env tier in packaged builds (MQA-153).
 */
function readEscrowPubKey(): string | null {
  const fromEnv = resolveEscrowPem(devEnv('ASKTOTO_ESCROW_PUBKEY'))
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
    const machine = admin ? resolveEscrowPem(escrowFromManagedContent(admin)) : null
    if (machine) return machine
  } catch {
    /* ignore */
  }
  return null
}

/** Envelope paths are fail-closed and throw: the typed wrap/unwrap results are re-raised as the original Error. */
function wrapContentKeyOrThrow(key: Buffer): string {
  const wrapped = wrapContentKey(key)
  if (!wrapped.ok) throw wrapped.error
  return wrapped.wrapped
}

function unwrapContentKeyOrThrow(kLocal: string, allowKeychainRecovery: boolean) {
  const unwrapped = unwrapContentKey(kLocal, { allowKeychainRecovery })
  if (!unwrapped.ok) throw unwrapped.error
  return unwrapped
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
function encryptEnvelopeV2(content: string): Buffer {
  const contentKey = generateContentKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
  const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // LOCAL wrap: prefer the OS keychain (safeStorage); when the file backend is in force (un-notarized
  // build — see the keystore note in index.ts) or safeStorage is unavailable (Linux / CI / no
  // secret-service), wrap with the AES-GCM file-backend key from secrets.ts instead so recording never
  // triggers a Keychain prompt mid-meeting. Either way the content key is always encrypted at rest.
  const kLocalField = wrapContentKeyOrThrow(contentKey)
  const env: EnvelopeV2 = {
    v: 2,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
    kLocal: kLocalField
  }
  // ESCROW wrap (only when configured): RSA-OAEP(content key) so an admin holding the org PRIVATE key can
  // recover the content key out-of-band. The app only ever WRITES kEscrow; it never reads it.
  const pem = readEscrowPubKey()
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

/** Meeting-framed documents offload bulk AES and envelope serialization after native key wrapping in main. */
async function encryptSpeechEnvelopeV2(content: string): Promise<Buffer> {
  const contentKey = generateContentKey()
  const iv = randomBytes(12)
  let kLocalField: string
  let kEscrow: string | undefined
  const wrapStartedAt = performance.now()
  try {
    try {
      kLocalField = wrapContentKeyOrThrow(contentKey)
      const pem = readEscrowPubKey()
      if (pem) {
        try {
          kEscrow = publicEncrypt(
            { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
            contentKey
          ).toString('base64')
        } catch {
          mainLog.warn('Métis: escrow public key configured but unusable; wrote transcript without escrow wrap')
          auditLog('transcript.saved', { escrowFailed: true })
        }
      }
    } finally {
      // The resource harness replaces Electron's safeStorage boundary; this is not native OS-key evidence.
      reportMeetingSpeechTiming('mock-native-key-wrap', performance.now() - wrapStartedAt)
    }
    return await encryptMeetingEnvelopeAsync(content, contentKey, iv, kLocalField, kEscrow)
  } finally {
    contentKey.fill(0)
    iv.fill(0)
  }
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
function decryptEnvelopeV2(buf: Buffer, allowKeychainRecovery = false, filePath?: string): string {
  const env = JSON.parse(buf.subarray(MARKER_LEN).toString('utf8')) as EnvelopeV2
  const unwrapped = unwrapContentKeyOrThrow(env.kLocal, allowKeychainRecovery)
  const contentKey = unwrapped.key
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
  if (unwrapped.keychainRecovery && filePath && useFileBackend()) {
    const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`
    try {
      const updated: EnvelopeV2 = { ...env, kLocal: wrapContentKeyWithFileBackend(contentKey) }
      writeFileSync(tmp, Buffer.concat([ENC_MARKER_V2, Buffer.from(JSON.stringify(updated), 'utf8')]), {
        mode: 0o600
      })
      renameSync(tmp, filePath)
    } catch {
      try {
        if (existsSync(tmp)) unlinkSync(tmp) // don't leave an orphaned .tmp behind on a failed rewrap
      } catch {
        /* best-effort cleanup */
      }
    }
  }
  const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(env.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8')
}

/** Main unwraps only the small local key field; the child parses/base64-decodes/decrypts the bulk envelope. */
async function decryptEnvelopeV2Async(buf: Buffer, allowKeychainRecovery = false, filePath?: string): Promise<string> {
  const kLocal = readEnvelopeLocalKey(buf.subarray(MARKER_LEN))
  const unwrapped = unwrapContentKeyOrThrow(kLocal, allowKeychainRecovery)
  const contentKey = unwrapped.key
  const recoveredLocalKey =
    unwrapped.keychainRecovery && filePath && useFileBackend() ? wrapContentKeyWithFileBackend(contentKey) : undefined
  try {
    const text = await decryptMeetingEnvelopeAsync(buf.subarray(MARKER_LEN), contentKey, kLocal)
    if (recoveredLocalKey && filePath) {
      try {
        const rewritten = await rewrapMeetingEnvelopeAsync(buf.subarray(MARKER_LEN), recoveredLocalKey)
        await writeSaved(filePath, Buffer.concat([ENC_MARKER_V2, rewritten]).toString('utf8'), false)
      } catch {
        // Self-heal is best effort; the user already received the decrypted contents.
      }
    }
    return text
  } finally {
    contentKey.fill(0)
  }
}

// Shown in place of a transcript that can't be decrypted on this device (e.g. encrypted under a different
// OS keychain/user — common when an encrypted file is OneDrive-synced to another machine). Beats a dead
// "Open" click or a silent unhandled rejection.
const UNDECRYPTABLE_MSG =
  "# This transcript can't be opened here\n\n" +
  "It was encrypted at rest on a different machine or user account, so this device's keychain cannot " +
  'decrypt it. Open it on the machine where it was created, or turn off at-rest encryption in Settings ' +
  'before saving if you need transcripts portable across devices.\n'

/** The outcome of decoding saved bytes. "Cannot be decrypted here" is a VALUE, never an exception —
 *  that is the whole point (MQA-175): the callers that must distinguish an intact-elsewhere file from a
 *  genuinely empty one (the brain index, the corrections journal) get to branch on it, and no read path
 *  can be taken down by whatever the envelope happens to contain. */
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
function tryDecodeSaved(buf: Buffer, allowKeychainRecovery = false, filePath?: string): SavedDecode {
  // v2 envelope: AES-256-GCM content key wrapped by safeStorage (+ optional org escrow).
  if (buf.length >= MARKER_LEN && buf.subarray(0, MARKER_LEN).equals(ENC_MARKER_V2)) {
    try {
      return { ok: true, text: decryptEnvelopeV2(buf, allowKeychainRecovery, filePath) }
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
 *  search/list keep working. Use decodeSavedResult() when '' and "unreadable" must not be confused, and
 *  decryptToTemp() for the user-facing Open path (it shows the notice). */
export function decodeSaved(buf: Buffer): string {
  const r = tryDecodeSaved(buf)
  return r.ok ? r.text : ''
}

/** Meeting-only async decode; generic brain/import JSON readers retain their established sync contract. */
export async function decodeSavedMeetingAsync(
  buf: Buffer,
  allowKeychainRecovery = false,
  filePath?: string
): Promise<SavedDecode> {
  if (buf.length >= MARKER_LEN && buf.subarray(0, MARKER_LEN).equals(ENC_MARKER_V2)) {
    if (!isMeetingSpeechPersistenceConfigured()) {
      const legacy = tryDecodeSaved(buf, allowKeychainRecovery, filePath)
      if (legacy.ok && legacy.text.includes('metis-speech-') && getMeetingSpeechReadLimitBytes() === undefined)
        return { ok: false, reason: 'Speech metadata is unavailable until its read budget is configured.' }
      return legacy
    }
    try {
      return { ok: true, text: await decryptEnvelopeV2Async(buf, allowKeychainRecovery, filePath) }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  return tryDecodeSaved(buf, allowKeychainRecovery, filePath)
}

/** Read a saved transcript/note (sync), transparently decrypting if it was written encrypted. */
export function readSavedFile(path: string): string {
  return decodeSaved(readFileSync(path))
}

export function isEncryptedBytes(bytes: Buffer): boolean {
  const head = bytes.subarray(0, MARKER_LEN)
  return head.equals(ENC_MARKER) || head.equals(ENC_MARKER_V2)
}

/** True if the file on disk is one of Métis's encrypted transcripts. */
export function isEncryptedFile(path: string): boolean {
  try {
    return isEncryptedBytes(readFileSync(path))
  } catch {
    return false
  }
}

/** Atomic write; encrypts at rest when `encrypt` is true. Cleans up temp on failure.
 *  Exported for the brain store (src/main/brain/) so derived knowledge files share the exact same
 *  at-rest encryption semantics as the transcripts they're built from. */
export async function writeSaved(
  file: string,
  content: string,
  encrypt: boolean,
  beforeReplace?: () => void
): Promise<void> {
  let data: Buffer = Buffer.from(content, 'utf8')
  if (encrypt) {
    // encryptEnvelopeV2 always produces an ATKENC2-marked encrypted envelope — safeStorage path
    // when the keychain is available, AES-GCM file-backend path otherwise. Any error propagates
    // to the caller (fail-closed): plaintext is never silently written when encryption is on.
    data = content.includes('<!-- metis-speech-provenance:v1 -->')
      ? await encryptSpeechEnvelopeV2(content)
      : encryptEnvelopeV2(content)
  }
  await atomicSavedWrite(file, data, beforeReplace)
}

// Decrypted temp copies are tracked and deleted on quit so an encrypted transcript never leaves a
// permanent cleartext file behind (the name is randomized so it isn't a predictable target either).
const decryptedTemps = new Set<string>()
let tempCleanupHooked = false

function trackDecryptedTemp(tmp: string): void {
  decryptedTemps.add(tmp)
  if (tempCleanupHooked) return
  tempCleanupHooked = true
  app.on('will-quit', () => {
    for (const path of decryptedTemps) {
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch {
        /* best-effort cleanup */
      }
    }
    decryptedTemps.clear()
  })
}

/** Decrypt an encrypted transcript to a temp plaintext file so it can be opened in an editor. The file
 *  lives under the per-user temp dir (user-scoped ACL), has a randomized name, and is unlinked on app
 *  quit. Confidentiality: POSIX `mode: 0o600` on the write below (owner-only on macOS/Linux) is a no-op
 *  on Windows, so on win32 we additionally apply an explicit owner-only DACL via lockPathToCurrentUserWin32.
 *
 *  This is an explicit single-file user read (the only caller is recallOpen's "Open" click), so it opts
 *  into Keychain recovery for an old 'S:'-wrapped meeting despite the forced local keystore — see
 *  decryptEnvelopeV2's doc comment. Bulk list/search paths (recall.ts) go through decodeSaved instead and
 *  never set this, so they stay exactly as boot-prompt-free as commit 486227d intended. Given `bytes` (read
 *  through the storage gateway by History's Open, history-actions.ts), the file is never read here. */
export function decryptToTemp(path: string, bytes?: Buffer): string {
  // Read + decrypt defensively: a foreign-keychain file yields the notice instead of throwing and
  // leaving the user with a dead "Open" click.
  let content: string
  try {
    const decoded = tryDecodeSaved(bytes ?? readFileSync(path), true, path)
    content = decoded.ok ? decoded.text : UNDECRYPTABLE_MSG
  } catch {
    content = UNDECRYPTABLE_MSG
  }
  const tmp = join(
    app.getPath('temp'),
    `asktoto-${randomBytes(6).toString('hex')}-${basename(path).replace(/\.md$/, '')}.md`
  )
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  lockPathToCurrentUserWin32(tmp) // mode bits are ignored on Windows; enforce owner-only via DACL
  trackDecryptedTemp(tmp)
  return tmp
}

/** Meeting Open variant: decrypt the large ATKENC2 payload in the owned worker before writing temp. */
export async function decryptMeetingToTempAsync(path: string, bytes: Buffer): Promise<string> {
  let content: string
  try {
    const decoded = await decodeSavedMeetingAsync(bytes, true, path)
    content = decoded.ok ? decoded.text : UNDECRYPTABLE_MSG
  } catch {
    content = UNDECRYPTABLE_MSG
  }
  const tmp = join(
    app.getPath('temp'),
    `asktoto-${randomBytes(6).toString('hex')}-${basename(path).replace(/\.md$/, '')}.md`
  )
  await writeSaved(tmp, content, false)
  lockPathToCurrentUserWin32(tmp)
  trackDecryptedTemp(tmp)
  return tmp
}

/**
 * Startup sweep: removes orphaned `asktoto-<hex>-*.md` cleartext temp files left by a previous
 * session that was hard-killed (SIGKILL) before the will-quit cleanup hook could run.
 *
 * INTEGRATOR: call this from the main process immediately after `app.whenReady()` resolves,
 * before any transcript is opened, e.g.:
 *   import { sweepStaleTempFiles } from './transcripts'
 *   app.whenReady().then(() => { sweepStaleTempFiles(); … })
 */
export function sweepStaleTempFiles(): void {
  try {
    const tmp = app.getPath('temp')
    for (const name of readdirSync(tmp)) {
      if (/^asktoto-[0-9a-f]+-.*\.md$/.test(name)) {
        try {
          unlinkSync(join(tmp, name))
        } catch {
          /* best-effort — file may already be deleted or still open */
        }
      }
    }
  } catch {
    /* ignore — temp dir unreadable */
  }
}

/** Ensure the meetings folder exists and is self-documenting (README + index). Safe to call repeatedly. */
export function ensureMeetingsFolder(settings: Settings): string {
  const folder = resolveMeetingsFolder(settings)
  try {
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    const readme = join(folder, 'README.md')
    if (!existsSync(readme)) writeFileSync(readme, README, 'utf8')
    const index = join(folder, 'index.md')
    if (!existsSync(index)) writeFileSync(index, INDEX_HEADER, 'utf8')
  } catch {
    /* fail-open: folder may be offline/unwritable */
  }
  return folder
}

function appendIndexRow(
  folder: string,
  dateStr: string,
  title: string,
  mode: string,
  durMin: number,
  fileName: string
): void {
  try {
    const index = join(folder, 'index.md')
    if (!existsSync(index)) writeFileSync(index, INDEX_HEADER, 'utf8')
    appendFileSync(index, formatIndexRow(dateStr, title, mode, durMin, fileName), 'utf8')
  } catch {
    /* ignore */
  }
}

// The meetings root is resolved in infra/storage/paths.ts; re-exported for this module's importers.
export { detectOneDrive } from './infra/storage/paths'
export { resolveMeetingsFolder }

/** Save any single Q&A / answer as a Dust-readable markdown note. Returns the file path. */
export async function saveNote(settings: Settings, n: SaveNote): Promise<string> {
  // MQA-278 — refuses Act 2 onboarding-demo-tagged data before touching disk. See @shared/demo-guard.
  refuseIfDemoTagged('saveNote', n.title, n.mode, n.question)
  const folder = ensureMeetingsFolder(settings)
  const started = Date.now()
  const title = cleanTitle(n.title || n.question || 'Note') || 'Note'
  // Encrypted at rest → the filename must not leak the plaintext title either (see opaqueNamePart above).
  const namePart = settings.encryptTranscripts ? opaqueNamePart() : slug(title)
  let file = join(folder, `${stamp(started)}-note-${namePart}.md`)
  for (let i = 2; existsSync(file); i++) {
    file = join(folder, `${stamp(started)}-note-${namePart}-${i}.md`)
  }
  const document = buildNoteDocument(n, title, started)
  // Atomic write (encrypted at rest when enabled).
  await writeSaved(file, document, settings.encryptTranscripts)

  // The plaintext index.md would leak titles/dates, defeating encryption — skip it in that mode.
  if (!settings.encryptTranscripts) {
    appendIndexRow(folder, indexDateString(started), title, 'note', 0, file.slice(folder.length + 1))
  }
  return file
}

/** Whole minutes of recording when measured, or a legacy transcript-span estimate. The value saveMeeting stamps into
 *  the frontmatter AND the value recordMeetingSummarized credits, so the tile and the on-disk meetings
 *  can never disagree about how long a call was. */
export function meetingDurationMin(m: { startedAt: number; durationMs?: number; lines: { t: number }[] }): number {
  return meetingDurationMinutes(m)
}

/** Write a meeting as Dust-readable markdown + frontmatter. Returns the file path. */
export async function saveMeeting(settings: Settings, m: SaveMeeting, beforeReplace?: () => void): Promise<string> {
  const statusError = recapStatusValidationError(m.recap, m.recapStatus)
  if (statusError) throw new Error(statusError)
  // MQA-278 — refuses Act 2 onboarding-demo-tagged data before touching disk. See @shared/demo-guard.
  refuseIfDemoTagged('saveMeeting', m.title, m.mode)
  const folder = ensureMeetingsFolder(settings)

  // Guard against non-finite/out-of-range values (e.g. Infinity), not just falsy ones: Date's valid
  // range is +/-8.64e15ms from epoch, and anything outside it throws RangeError from toISOString()
  // below with no surrounding try/catch, losing the whole meeting.
  const started =
    m.startedAt && Number.isFinite(m.startedAt) && Math.abs(m.startedAt) <= 8.64e15 ? m.startedAt : Date.now()
  const heuristicTitle = cleanTitle(m.title) || `${m.mode} meeting`

  // Main is the single source of truth for the final title: when a recap was generated, prefer its
  // "## Title" (2-4 real words naming the topic) over the renderer's "first sentence of theirs" heuristic.
  // Falls back to the renderer-provided title when there's no recap yet, or the model left Title empty.
  const recapParsed = m.recap ? parseRecapMarkdown(m.recap) : null
  const title = cleanTitle(recapParsed?.title24 || '') || heuristicTitle
  const tags = recapParsed?.tags || []
  refuseReservedSpeechProse(title, m.mode, ...tags)

  // Encrypted at rest → the filename must not leak the plaintext title either (see opaqueNamePart above).
  const namePart = settings.encryptTranscripts ? opaqueNamePart() : slug(title)
  let file = join(folder, `${stamp(started)}-${namePart}.md`)
  for (let n = 2; existsSync(file); n++) {
    file = join(folder, `${stamp(started)}-${namePart}-${n}.md`)
  }

  const durMin = meetingDurationMin(m)
  const participants = Array.from(new Set(m.lines.map((l) => speakerLabel(l.speaker))))

  // Enterprise-live SUMMARY_ONLY: omit fresh Full transcript section. Never rewrite/delete older files.
  const summaryOnly = isSummaryOnlyProfile(resolveEnterpriseLiveProfile(settings.enterpriseLive ?? settings))
  const transcript = summaryOnly ? '' : await renderMeetingTranscriptAsync(m.lines)

  const document = buildMeetingSaveDocument({
    meeting: m,
    title,
    mode: cleanTitle(m.mode),
    started,
    durationMin: durMin,
    participants,
    tags,
    summaryOnly,
    transcript
  })
  await writeSaved(file, document, settings.encryptTranscripts, beforeReplace)

  if (!settings.encryptTranscripts) {
    appendIndexRow(folder, indexDateString(started), title, m.mode, durMin, file.slice(folder.length + 1))
  }
  return file
}

/**
 * 90-Second Debrief (innovation #6): append the user's post-meeting gut-read — what was NOT said
 * aloud, hallway remarks, instinct — to the saved meeting as its own section. This is the off-record
 * layer: the transcript records what was spoken; the debrief records what the user sensed. It lives in
 * the same file so it inherits encryption, retention, deletion, and brain ingest (the extraction reads
 * the full markdown, so debrief observations feed signals/missed_signals on the next ingest).
 *
 * Idempotent: a second save REPLACES the debrief section rather than stacking copies. `file` must be a
 * bare basename inside the meetings folder (callers pass basename; we re-basename for defense).
 *
 * The section boundary is TWO layers deep, since either alone can be defeated by adversarial-looking-
 * but-perfectly-normal user text (e.g. a debrief that itself starts with "## "):
 *   1. The debrief body is sanitized on write (escapeHeadingLines) so it can never contain a real
 *      "## "-shaped line in the first place.
 *   2. The section is terminated by an explicit `DEBRIEF_END_MARKER` HTML comment, so the replace logic
 *      finds the exact end of the PREVIOUS debrief instead of scanning for the next "## " (which would
 *      match text inside the debrief body on an older, pre-marker file). Files written before this
 *      marker existed fall back to the old "next heading" search.
 */
export { DEBRIEF_HEADING }
export async function appendDebrief(
  settings: Settings,
  file: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const folder = resolveMeetingsFolder(settings)
  const safeName = safeMeetingBasename(file)
  if (!safeName) return { ok: false, error: 'Invalid meeting file name.' }
  const path = join(folder, safeName)
  const maxBytes = getMeetingSpeechReadLimitBytes()
  const read = await storageAt(folder).read(safeName, { ...(maxBytes ? { maxBytes } : {}) })
  if (read.status === 'missing') return { ok: false, error: 'Meeting file not found.' }
  if (read.status !== 'ok') {
    return { ok: false, error: 'Could not read the meeting file.' }
  }
  const decoded = await decodeSavedMeetingAsync(read.bytes, false, path)
  const md = decoded.ok ? decoded.text : ''
  if (!md) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }
  if (!/^type: meeting-transcript$/m.test(md)) return { ok: false, error: 'Not a meeting transcript.' }
  const safeText = escapeSpeechMarkers(escapeHeadingLines(text.trim()))
  const updated = applyDebriefSection(md, safeText, meetingSpeechTailOffset(md))
  // Preserve the file's ORIGINAL at-rest encryption exactly as found (mirrors updateMeetingRecap /
  // renameMeeting), NOT the live encryptTranscripts toggle. Otherwise appending a debrief to a file
  // that was saved while encryption was on would rewrite the whole transcript as plaintext once the
  // toggle is later turned off — a silent at-rest downgrade of already-recorded third-party speech.
  const wasEncrypted = isEncryptedBytes(read.bytes)
  await writeSaved(path, updated, wasEncrypted)
  return { ok: true }
}

/**
 * Periodic best-effort snapshot of an IN-PROGRESS meeting (see the renderer's autosave timer while
 * Listen is active). Overwrites this ONE meeting's own draft file every tick — never touches index.md.
 * `type: meeting-transcript-draft` (not `meeting-transcript`) means readMeeting/listMeetings already
 * ignore it (see recall.ts's frontmatter-type guard) — no extra filtering needed there.
 *
 * Without this, a renderer crash or force-quit mid-meeting loses the whole transcript with zero disk
 * footprint (it exists only in React state until the recap-triggered save at the end). With it, the
 * worst case is losing the last autosave interval, not the whole meeting. clearDraftTranscript removes
 * it once the meeting ends normally and its real saveMeeting() has already succeeded. A crashed meeting's
 * draft is left on disk (dot-prefixed, so it doesn't clutter the meetings list) rather than auto-recovered
 * — that's a real, disclosed limitation: this closes the data-loss gap, it doesn't build recovery UX.
 * Finalized meeting identities are process-local; after a crash/restart the old renderer and its late
 * callbacks are gone, while an interrupted meeting's on-disk draft remains eligible for recovery.
 */
export async function saveDraftTranscript(
  settings: Settings,
  m: SaveMeeting,
  beforeReplace?: () => void
): Promise<SaveDraftTranscriptResult> {
  const liveStartedAt = LiveMeetingStartedAtSchema.safeParse(m.startedAt)
  if (!liveStartedAt.success) return { status: 'disabled' }
  let finishWrite: (() => void) | undefined
  const admission = createWriteAdmissionGuard(beforeReplace)
  // Summary-only retention also applies to crash-recovery snapshots, which contain raw speech.
  // Leave previously permitted files untouched, as the normal summary-only save does.
  if (isSummaryOnlyProfile(resolveEnterpriseLiveProfile(settings.enterpriseLive ?? settings)))
    return { status: 'disabled' }
  try {
    const started = liveStartedAt.data
    // Meeting identity is sealed across folder changes, so a late tick cannot recreate a finalized
    // draft under a newly selected meetings folder.
    if (isDraftMeetingFinalized(started)) return { status: 'disabled' }
    const folder = ensureMeetingsFolder(settings)
    const file = join(folder, draftFilename(started, stamp(started)))
    // Register synchronously before the first await so completed-save cleanup sees this operation.
    finishWrite = trackDraftWrite(file, started) ?? undefined
    if (!finishWrite) return { status: 'disabled' }
    return await serializeDraftWrite(file, async () => {
      const title = cleanTitle(m.title) || `${m.mode} meeting`
      refuseReservedSpeechProse(title, m.mode)
      const transcript = await renderMeetingTranscriptAsync(m.lines)
      const document = buildDraftTranscriptDocument(m, started, title, transcript)
      await writeSaved(file, document, settings.encryptTranscripts, admission.guard)
      return { status: 'saved' }
    })
  } catch {
    const refusal = admission.refusal
    if (refusal) throw refusal.error
    // Keep ordinary failures nonthrowing while allowing the renderer to report an unsaved snapshot.
    return { status: 'failed' }
  } finally {
    finishWrite?.()
  }
}

/**
 * Remove one meeting's autosave draft once it ends normally (its real saveMeeting() already succeeded).
 *
 * The unlink gets the same bounded retry writeSaved() uses for rename: the default meetings folder is
 * OneDrive-synced, which routinely holds a just-written file open for upload hashing, and AV/EDR
 * real-time scanning grabs it too — unlink then throws EPERM/EBUSY on Windows even though nothing is
 * wrong. A single best-effort attempt leaves the draft on disk, and recoverOrphanDrafts() promotes it
 * on the next launch, so the user sees their meeting twice with the second copy labelled
 * "(recovered)". Retrying rides out the transient lock; a genuinely stuck file still degrades to the
 * old behaviour rather than failing the meeting end.
 */
async function unlinkDraftFiles(
  files: readonly string[],
  isCurrent: () => boolean = () => true
): Promise<{ failed: string[]; pending: string[] }> {
  const failed: string[] = []
  for (let index = 0; index < files.length; index++) {
    const file = files[index]
    if (!isCurrent()) return { failed, pending: files.slice(index) }
    try {
      if (!existsSync(file)) continue
      for (let attempt = 0; ; attempt++) {
        // Auth may change during an unlink retry delay; check immediately before every filesystem mutation.
        if (!isCurrent()) return { failed, pending: files.slice(index) }
        try {
          await unlink(file)
          break
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          if (code === 'ENOENT') break
          if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 4) throw e
          await new Promise((r) => setTimeout(r, 40 * 2 ** attempt))
        }
      }
    } catch {
      failed.push(file)
    }
  }
  return { failed, pending: [] }
}

// Keep exact failed paths even after finalizeDraftMeeting drops its per-meeting registry. A normal
// final-save cleanup is best-effort, but Review's later explicit Disregard must still be able to
// retry every draft copy that cleanup could not unlink.
const failedDraftCleanupPaths = new Map<number, Set<string>>()

/** Seal and join a retired meeting while retaining its on-disk drafts for crash recovery. */
export async function preserveDraftTranscript(startedAt: number): Promise<void> {
  await finalizeDraftMeeting(startedAt)
}

/** Explicit user discard: seal the meeting, join its writes, and remove every known draft copy. */
export async function discardDraftTranscript(
  settings: Settings,
  startedAt: number,
  isCurrent: () => boolean = () => true
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isCurrent())
    return { ok: false, error: 'Sign-in changed before draft cleanup could start. Try Disregard again.' }
  const priorFailures = failedDraftCleanupPaths.get(startedAt) ?? new Set<string>()
  const candidates = [
    ...knownDraftPathsForMeeting(startedAt),
    ...priorFailures,
    ...draftCleanupCandidates(settings, startedAt)
  ]
  const files = await finalizeDraftMeeting(startedAt, candidates)
  if (!isCurrent()) {
    failedDraftCleanupPaths.set(startedAt, new Set(files))
    return { ok: false, error: 'Sign-in changed before draft cleanup could finish. Try Disregard again.' }
  }
  const { failed, pending } = await unlinkDraftFiles(files, isCurrent)
  if (pending.length || !isCurrent()) {
    failedDraftCleanupPaths.set(startedAt, new Set([...failed, ...pending]))
    return { ok: false, error: 'Sign-in changed before draft cleanup could finish. Try Disregard again.' }
  }
  if (failed.length) {
    failedDraftCleanupPaths.set(startedAt, new Set(failed))
    return { ok: false, error: 'Some autosaved draft files could not be removed. Try Disregard again.' }
  }
  failedDraftCleanupPaths.delete(startedAt)
  return { ok: true }
}

export async function clearDraftTranscript(
  settings: Settings,
  startedAt: number,
  savedTranscriptPath?: string
): Promise<void> {
  try {
    // Include the current and durable-save folders, while finalizeDraftMeeting also includes every
    // folder this meeting used previously. It seals the startedAt identity before awaiting writes.
    const candidateFiles = draftCleanupCandidates(settings, startedAt, savedTranscriptPath)
    const files = await finalizeDraftMeeting(startedAt, candidateFiles)
    const { failed } = await unlinkDraftFiles(files)
    if (failed.length) failedDraftCleanupPaths.set(startedAt, new Set(failed))
    else failedDraftCleanupPaths.delete(startedAt)
  } catch {
    /* best-effort — a stuck draft is recovered on next launch, it must never fail the meeting end */
  }
}

// Never follow a symlink planted with a draft-shaped name: `FileClass.isSymlink` is the directory
// entry's own type (from lstat), not the target's, so a symlink to another meeting already inside the
// folder is rejected here even though the gateway's `read()` would otherwise follow it.
function isFile(fileClass: FileClass | undefined): boolean {
  return !!fileClass && 'isSymlink' in fileClass && !fileClass.isSymlink
}

/**
 * Promote orphaned autosave drafts into real, visible meetings (run once at launch). A draft only
 * survives on disk when its meeting never reached a normal save — a crash or force-quit — so leaving
 * it as an invisible dot-file meant the recording of third-party speech sat outside History, outside
 * the retention sweep, and outside recovery, forever. Promotion re-enters it into the normal
 * lifecycle: it appears in History as "(recovered)", retention applies (the recovered filename keeps
 * the stamp prefix the sweep parses), and the user loses at most the final autosave interval instead
 * of the whole meeting. Runs before any Listen session starts, and drafts are keyed by their own
 * startedAt, so a live meeting's draft can never be promoted out from under it. Undecryptable drafts
 * (foreign keychain) are left for the device that can read them. A draft whose promoted file exists (e.g. after a
 * successful write) is never re-promoted — only its stale source file is retried for cleanup — and,
 * in plaintext mode, the recovered meeting gets an index.md row exactly like a normally-saved one.
 */
export async function recoverOrphanDrafts(settings: Settings, savedDrafts?: ReadonlySet<string>) {
  let recovered = 0
  try {
    const folder = resolveMeetingsFolder(settings)
    const gateway = storageAt(folder)
    const listing = await gateway.list('')
    if (listing.status !== 'ok') return { recovered }
    const draftNames = listing.names.filter((name) => name.startsWith('.autosave-draft-') && name.endsWith('.md'))
    const draftClasses = await classifyAll(gateway, draftNames)
    const occupied = new Set(listing.names)
    for (const f of draftNames) {
      if (savedDrafts?.has(f)) continue
      if (!isFile(draftClasses.get(f))) continue
      const draftPath = join(folder, f)
      try {
        const stampPart = f.slice('.autosave-draft-'.length, -'.md'.length)
        const primaryOut = join(folder, `${stampPart}-recovered.md`)
        if (occupied.has(basename(primaryOut))) {
          // Already promoted by a previous run — this draft only still exists because that run's
          // unlink below failed afterward (transient EBUSY/EPERM; this folder is often OneDrive-synced).
          // Re-promoting would write a second, fully duplicate "-recovered-2.md" copy of the same
          // meeting, so just retry the cleanup and move on without touching `recovered`.
          await unlink(draftPath).catch(() => {
            /* still stale for the next run — harmless; the occupied-name guard prevents a dupe */
          })
          continue
        }
        // Preserve the DRAFT's own at-rest encryption exactly as found (mirrors appendDebrief /
        // renameMeeting), NOT the live encryptTranscripts toggle. A draft written while encryption was
        // on holds recorded third-party speech; promoting it under a since-disabled toggle would rewrite
        // it as unmarked cleartext into the (OneDrive-synced) meetings folder — a silent at-rest
        // downgrade, with no prompt and no way back.
        const maxBytes = getMeetingSpeechReadLimitBytes()
        const read = await gateway.read(f, { ...(maxBytes ? { maxBytes } : {}) })
        if (read.status !== 'ok') continue
        const wasEncrypted = isEncryptedBytes(read.bytes)
        const decoded = await decodeSavedMeetingAsync(read.bytes, false, draftPath)
        const text = decoded.ok ? decoded.text : ''
        if (!text) continue // undecryptable on this device — leave it alone
        const promoted = promoteDraftTranscript(text)
        let out = primaryOut
        for (let n = 2; occupied.has(basename(out)); n++) out = join(folder, `${stampPart}-recovered-${n}.md`)
        await writeSaved(out, promoted, wasEncrypted)
        occupied.add(basename(out))
        try {
          await unlink(draftPath)
        } catch {
          // The promoted copy is already safely on disk; a future run will see primaryOut exists and
          // skip re-promoting this same stale draft (see the guard above), only retrying its cleanup.
        }
        recovered++

        // Mirror saveMeeting's exact plaintext-mode index.md bookkeeping (same row shape) — a recovered
        // meeting should be just as discoverable from index.md as a normal one. Keyed on the file we
        // just wrote, not the live toggle: index.md is always cleartext, so a preserved-encrypted
        // recovery would otherwise leak the meeting's title and date beside the ciphertext.
        if (!wasEncrypted) {
          const { dateStr, title, mode } = recoveredDraftIndexFields(text)
          appendIndexRow(folder, dateStr, title, mode, 0, basename(out))
        }
      } catch {
        /* one unreadable draft must not block recovering the others */
      }
    }
  } catch {
    /* best-effort — recovery must never block launch */
  }
  return { recovered }
}

export { recapMarkdownToHtml, recapSectionKey, parseRecapMarkdown } from './transcripts-recap'
