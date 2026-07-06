import { app, safeStorage } from 'electron'
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, createCipheriv, createDecipheriv, publicEncrypt, constants } from 'node:crypto'
import type { SaveMeeting, SaveNote, Settings, RecapExport, TranscriptLine } from '@shared/ipc'
import { encryptSecret, decryptSecret, useFileBackend } from './secrets'
import { trustedAdminManagedPath, lockPathToCurrentUserWin32 } from './win-security'
import { mainLog, auditLog } from './logger'

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

/** Raw-read an `escrowPubKey` string from a managed-config.json (escrow isn't a Settings schema key). */
function readEscrowFromManaged(p: string): string | null {
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'))
    return typeof obj?.escrowPubKey === 'string' ? obj.escrowPubKey : null
  } catch {
    return null
  }
}

/**
 * Org escrow public key (PEM), if configured. Precedence: env ASKTOTO_ESCROW_PUBKEY (dev) → machine-wide
 * managed-config (IT policy) → per-user managed-config. Returns null when unset/unusable, so encryption
 * silently falls back to local-only (no regression). Never throws; never logs key material.
 */
function readEscrowPubKey(): string | null {
  const fromEnv = resolveEscrowPem(process.env.ASKTOTO_ESCROW_PUBKEY)
  if (fromEnv) return fromEnv
  try {
    const adminPath = trustedAdminManagedPath() // null on win32 unless admin-owned + not user-writable
    const machine = adminPath ? resolveEscrowPem(readEscrowFromManaged(adminPath)) : null
    if (machine) return machine
  } catch {
    /* ignore */
  }
  try {
    const user = resolveEscrowPem(readEscrowFromManaged(join(app.getPath('userData'), 'managed-config.json')))
    if (user) return user
  } catch {
    /* ignore */
  }
  return null
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

/** Decrypt a v2 envelope. Handles the 'S:' (safeStorage), 'F:' (file-backend), and legacy (bare
 *  base64) kLocal encodings. Throws on malformed/foreign-keychain input so tryDecodeSaved degrades
 *  to the UNDECRYPTABLE path instead of crashing a read. */
function decryptEnvelopeV2(buf: Buffer): string {
  const env = JSON.parse(buf.subarray(MARKER_LEN).toString('utf8')) as EnvelopeV2
  let contentKeyB64: string
  if (env.kLocal.startsWith('F:')) {
    // File-backend path: content key was wrapped by secrets.ts AES-GCM (no keychain required).
    contentKeyB64 = decryptSecret(Buffer.from(env.kLocal.slice(2), 'base64'))
  } else {
    // safeStorage path: 'S:' prefix (new) or legacy bare base64 (no prefix, backward compat).
    if (process.env.ASKTOTO_LOCAL_KEYSTORE) {
      throw new Error('Keychain-wrapped transcript is unavailable while the local keystore is active')
    }
    const raw = env.kLocal.startsWith('S:') ? env.kLocal.slice(2) : env.kLocal
    contentKeyB64 = safeStorage.decryptString(Buffer.from(raw, 'base64'))
  }
  const contentKey = Buffer.from(contentKeyB64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(env.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8')
}

// Shown in place of a transcript that can't be decrypted on this device (e.g. encrypted under a different
// OS keychain/user — common when an encrypted file is OneDrive-synced to another machine). Beats a dead
// "Open" click or a silent unhandled rejection.
const UNDECRYPTABLE_MSG =
  '# This transcript can\'t be opened here\n\n' +
  'It was encrypted at rest on a different machine or user account, so this device\'s keychain cannot ' +
  'decrypt it. Open it on the machine where it was created, or turn off at-rest encryption in Settings ' +
  'before saving if you need transcripts portable across devices.\n'

/** Decode saved bytes, decrypting if the at-rest marker is present. Returns null when an encrypted file
 *  can't be decrypted on this machine (foreign keychain), so callers degrade instead of throwing. */
function tryDecodeSaved(buf: Buffer): string | null {
  // v2 envelope: AES-256-GCM content key wrapped by safeStorage (+ optional org escrow).
  if (buf.length >= MARKER_LEN && buf.subarray(0, MARKER_LEN).equals(ENC_MARKER_V2)) {
    try {
      return decryptEnvelopeV2(buf)
    } catch {
      return null // malformed or foreign-keychain — never throw out of a read path
    }
  }
  // v1 (legacy): safeStorage-direct. Kept for full backward compatibility with existing transcripts.
  if (buf.length >= ENC_MARKER.length && buf.subarray(0, ENC_MARKER.length).equals(ENC_MARKER)) {
    if (process.env.ASKTOTO_LOCAL_KEYSTORE) return null
    try {
      return safeStorage.decryptString(buf.subarray(ENC_MARKER.length))
    } catch {
      return null // undecryptable on this device — never throw out of a read path
    }
  }
  return buf.toString('utf8')
}

/** Decode saved bytes, decrypting if needed. Never throws; yields '' for an undecryptable file so
 *  search/list keep working. Use decryptToTemp() for the user-facing Open path (it shows the notice). */
export function decodeSaved(buf: Buffer): string {
  return tryDecodeSaved(buf) ?? ''
}

/** Read a saved transcript/note (sync), transparently decrypting if it was written encrypted. */
export function readSavedFile(path: string): string {
  return decodeSaved(readFileSync(path))
}

/** True if the file on disk is one of Métis's encrypted transcripts. */
export function isEncryptedFile(path: string): boolean {
  try {
    const head = readFileSync(path).subarray(0, MARKER_LEN)
    return head.equals(ENC_MARKER) || head.equals(ENC_MARKER_V2)
  } catch {
    return false
  }
}

/** Atomic write; encrypts at rest when `encrypt` is true. Cleans up temp on failure.
 *  Exported for the brain store (src/main/brain/) so derived knowledge files share the exact same
 *  at-rest encryption semantics as the transcripts they're built from. */
export async function writeSaved(file: string, content: string, encrypt: boolean): Promise<void> {
  let data: Buffer = Buffer.from(content, 'utf8')
  if (encrypt) {
    // encryptEnvelopeV2 always produces an ATKENC2-marked encrypted envelope — safeStorage path
    // when the keychain is available, AES-GCM file-backend path otherwise. Any error propagates
    // to the caller (fail-closed): plaintext is never silently written when encryption is on.
    data = encryptEnvelopeV2(content)
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
      if (existsSync(tmp)) await unlink(tmp) // don't leave an orphaned .tmp on failure
    } catch {
      /* ignore */
    }
    throw e
  }
}

// Decrypted temp copies are tracked and deleted on quit so an encrypted transcript never leaves a
// permanent cleartext file behind (the name is randomized so it isn't a predictable target either).
const decryptedTemps = new Set<string>()
let tempCleanupHooked = false

/** Decrypt an encrypted transcript to a temp plaintext file so it can be opened in an editor. The file
 *  lives under the per-user temp dir (user-scoped ACL), has a randomized name, and is unlinked on app
 *  quit. Confidentiality: POSIX `mode: 0o600` on the write below (owner-only on macOS/Linux) is a no-op
 *  on Windows, so on win32 we additionally apply an explicit owner-only DACL via lockPathToCurrentUserWin32. */
export function decryptToTemp(path: string): string {
  // Read + decrypt defensively: a foreign-keychain file yields the notice instead of throwing and
  // leaving the user with a dead "Open" click.
  let content: string
  try {
    content = tryDecodeSaved(readFileSync(path)) ?? UNDECRYPTABLE_MSG
  } catch {
    content = UNDECRYPTABLE_MSG
  }
  const tmp = join(
    app.getPath('temp'),
    `asktoto-${randomBytes(6).toString('hex')}-${basename(path).replace(/\.md$/, '')}.md`
  )
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  lockPathToCurrentUserWin32(tmp) // mode bits are ignored on Windows; enforce owner-only via DACL
  decryptedTemps.add(tmp)
  if (!tempCleanupHooked) {
    tempCleanupHooked = true
    app.on('will-quit', () => {
      for (const t of decryptedTemps) {
        try {
          if (existsSync(t)) unlinkSync(t)
        } catch {
          /* best-effort cleanup */
        }
      }
      decryptedTemps.clear()
    })
  }
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

const README = `# Métis — Meeting transcripts

This folder is created and maintained by **Métis**. Every meeting you run the copilot in is
saved here automatically as one markdown file: AI notes + the full timestamped transcript, with
frontmatter (\`type: meeting-transcript\`, \`status: ready-for-followup\`).

## For your Dust agents
- Read **index.md** for the running list of meetings, or scan the \`*.md\` files directly.
- Each file is tagged \`status: ready-for-followup\` — generate follow-ups, then update the status.
- Filenames are \`YYYY-MM-DD_HHMMSS-<slug>.md\`; frontmatter carries date, mode, participants, duration.

Do not rename this folder — Métis and your agents read from here.
`

const INDEX_HEADER = `# Métis Meetings — Index

| Date | Title | Mode | Duration | File |
|------|-------|------|----------|------|
`

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

function appendIndexRow(folder: string, dateStr: string, title: string, mode: string, durMin: number, fileName: string): void {
  try {
    const index = join(folder, 'index.md')
    if (!existsSync(index)) writeFileSync(index, INDEX_HEADER, 'utf8')
    const safeTitle = title.replace(/\|/g, '/')
    const safeMode = mode.replace(/\|/g, '/').replace(/[\r\n]/g, ' ')
    appendFileSync(index, `| ${dateStr} | ${safeTitle} | ${safeMode} | ${durMin} min | [open](${fileName}) |\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

// detectOneDrive() does a handful of sync fs calls (existsSync/readdirSync) and its answer can't change
// mid-process (the OneDrive sync root doesn't move while Métis is running) — resolveMeetingsFolder
// calls it on every settings read, so memoize once per process rather than re-stating the same paths
// every time.
let _oneDriveCache: string | undefined

/** Find the user's OneDrive root. Cross-platform (macOS / Windows / Linux). */
export function detectOneDrive(): string {
  if (_oneDriveCache !== undefined) return _oneDriveCache
  return (_oneDriveCache = detectOneDriveUncached())
}

function detectOneDriveUncached(): string {
  // Windows: OneDrive sets env vars to its sync roots.
  if (process.platform === 'win32') {
    for (const e of [process.env.OneDriveCommercial, process.env.OneDrive, process.env.OneDriveConsumer]) {
      if (e && existsSync(e)) return e
    }
    const winAlt = join(homedir(), 'OneDrive')
    return existsSync(winAlt) ? winAlt : ''
  }
  // macOS: ~/Library/CloudStorage/OneDrive-*
  try {
    const base = join(homedir(), 'Library', 'CloudStorage')
    if (existsSync(base)) {
      const dirs = readdirSync(base)
      const personal = dirs.find((d) => /^OneDrive-(?!SharedLibraries)/i.test(d))
      const any = dirs.find((d) => /^OneDrive/i.test(d))
      if (personal) return join(base, personal)
      if (any) return join(base, any)
    }
  } catch {
    /* ignore */
  }
  // Linux / fallback
  const alt = join(homedir(), 'OneDrive')
  return existsSync(alt) ? alt : ''
}

/** The folder transcripts are written to (explicit setting, else OneDrive, else Documents). */
export function resolveMeetingsFolder(settings: Settings): string {
  if (settings.meetingsFolder) return settings.meetingsFolder
  // `ASKTOTO_USERDATA` is the packaged-app physical-QA hook. Keep its implicit meeting store under
  // that temporary profile too: otherwise the normal OneDrive fallback would make an apparently
  // isolated test read and write the operator's real meeting data.
  const qaUserData = process.env.ASKTOTO_USERDATA?.trim()
  if (qaUserData) return join(qaUserData, 'Métis Meetings')
  const base = detectOneDrive() || app.getPath('documents')
  return join(base, 'Métis Meetings')
}

const pad = (n: number): string => String(n).padStart(2, '0')
function slug(s: string): string {
  return (
    (s || 'meeting')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'meeting'
  )
}
function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
/** Non-reversible filename segment used in place of the title slug when encryptTranscripts is on — the
 *  file CONTENTS are already encrypted, but a readable `-${slug(title)}` in the filename itself leaks the
 *  plaintext title at rest (e.g. via a OneDrive-synced folder listing). A random token carries no
 *  relationship to the title (unlike a hash, which a small guessable title space could dictionary-attack).
 *  Keeps the `stamp(started)-` prefix untouched so recall.ts's STUB_FILENAME_TIMESTAMP/NOTE_FILENAME
 *  regexes (timestamp-prefix only) still recognize the file as a real meeting/note. */
function opaqueNamePart(): string {
  return randomBytes(6).toString('hex')
}
const cleanTitle = (s: string): string => {
  // Collapse whitespace, strip control/newline chars, limit length for YAML/frontmatter safety.
  return (s || '')
    .replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}
const speakerLabel = (speaker: TranscriptLine['speaker']): 'Them' | 'You' | 'Speaker' =>
  speaker === 'them' ? 'Them' : speaker === 'you' ? 'You' : 'Speaker'
const yamlSafeTitle = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')

// Speaker Intelligence: `name` can come from a THIRD PARTY (a Teams VTT transcript — see
// main/graph-transcript.ts), not just the trusted signed-in account, so it must be sanitized before it
// ever reaches the saved markdown. Strips control/newline characters (would break the single-line
// "**[HH:MM:SS] Label (Name):**" shape below) and parentheses specifically — they're the round-trip
// delimiter recall.ts's parser depends on, so a name containing one would corrupt the parse — then caps
// length in line with the other name-shaped fields in this codebase (see ipc.ts's AsrCorrectionPairSchema).
function sanitizeSpeakerName(name: string | undefined): string {
  if (!name) return ''
  return name
    .replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/** Render one transcript line in the fixed on-disk shape recall.ts's parser reads back:
 *  `**[HH:MM:SS] Label:** text`, or `**[HH:MM:SS] Label (Name):** text` once Speaker Intelligence has
 *  resolved a display name for that line (see shared/transcript-align.ts). */
function formatTranscriptLine(l: TranscriptLine): string {
  const d = new Date(l.t)
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const name = sanitizeSpeakerName(l.name)
  const label = name ? `${speakerLabel(l.speaker)} (${name})` : speakerLabel(l.speaker)
  return `**[${t}] ${label}:** ${l.text}`
}

/** Render a full transcript body. saveMeeting and saveDraftTranscript share this exact shape so a
 *  promoted draft (see recoverOrphanDrafts) parses identically to a normally-saved meeting. */
export function formatTranscript(lines: TranscriptLine[]): string {
  return lines.map(formatTranscriptLine).join('\n\n')
}

/** Save any single Q&A / answer as a Dust-readable markdown note. Returns the file path. */
export async function saveNote(settings: Settings, n: SaveNote): Promise<string> {
  const folder = ensureMeetingsFolder(settings)
  const started = Date.now()
  const title = cleanTitle(n.title || n.question || 'Note') || 'Note'
  // Encrypted at rest → the filename must not leak the plaintext title either (see opaqueNamePart above).
  const namePart = settings.encryptTranscripts ? opaqueNamePart() : slug(title)
  let file = join(folder, `${stamp(started)}-note-${namePart}.md`)
  for (let i = 2; existsSync(file); i++) {
    file = join(folder, `${stamp(started)}-note-${namePart}-${i}.md`)
  }
  const frontmatter = [
    '---',
    'type: note',
    'source: Métis',
    `mode: "${yamlSafeTitle(cleanTitle(n.mode))}"`,
    `date: ${new Date(started).toISOString()}`,
    `title: "${yamlSafeTitle(title)}"`,
    'status: ready-for-followup',
    '---',
    ''
  ].join('\n')
  const body =
    `# ${title}\n\n_${new Date(started).toLocaleString()} · note · Métis_\n\n` +
    (n.question ? `## Question\n\n${n.question}\n\n` : '') +
    `## Answer\n\n${n.answer}\n`
  // Atomic write (encrypted at rest when enabled).
  await writeSaved(file, frontmatter + body, settings.encryptTranscripts)

  // The plaintext index.md would leak titles/dates, defeating encryption — skip it in that mode.
  if (!settings.encryptTranscripts) {
    const di = new Date(started)
    const dateStr = `${di.getFullYear()}-${pad(di.getMonth() + 1)}-${pad(di.getDate())} ${pad(di.getHours())}:${pad(di.getMinutes())}`
    appendIndexRow(folder, dateStr, title, 'note', 0, file.slice(folder.length + 1))
  }
  return file
}

/** Write a meeting as Dust-readable markdown + frontmatter. Returns the file path. */
export async function saveMeeting(settings: Settings, m: SaveMeeting): Promise<string> {
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

  // Encrypted at rest → the filename must not leak the plaintext title either (see opaqueNamePart above).
  const namePart = settings.encryptTranscripts ? opaqueNamePart() : slug(title)
  let file = join(folder, `${stamp(started)}-${namePart}.md`)
  for (let n = 2; existsSync(file); n++) {
    file = join(folder, `${stamp(started)}-${namePart}-${n}.md`)
  }

  const last = m.lines.length ? m.lines[m.lines.length - 1].t : started
  const durMin = m.lines.length ? Math.max(1, Math.round((last - started) / 60000)) : 0
  const participants = Array.from(new Set(m.lines.map((l) => speakerLabel(l.speaker))))

  const transcript = formatTranscript(m.lines)

  const frontmatter =
    [
      '---',
      'type: meeting-transcript',
      'source: Métis',
      `mode: "${yamlSafeTitle(cleanTitle(m.mode))}"`,
      `date: ${new Date(started).toISOString()}`,
      `title: "${yamlSafeTitle(title)}"`,
      `participants: [${participants.join(', ')}]`,
      `duration_min: ${durMin}`,
      `lines: ${m.lines.length}`,
      ...(tags.length ? [`topics: [${tags.map((t) => yamlSafeTitle(t)).join(', ')}]`] : []),
      'status: ready-for-followup',
      '---',
      ''
    ].join('\n')

  const body =
    `# ${title}\n\n_${new Date(started).toLocaleString()} · ${m.mode} · ${durMin} min · Métis_\n\n` +
    (m.recap ? `## Notes & follow-ups\n\n${m.recap}\n\n` : '') +
    `## Full transcript\n\n${transcript || '_No speech captured._'}\n`

  await writeSaved(file, frontmatter + body, settings.encryptTranscripts) // atomic; encrypted at rest when on

  if (!settings.encryptTranscripts) {
    const di = new Date(started)
    const dateStr = `${di.getFullYear()}-${pad(di.getMonth() + 1)}-${pad(di.getDate())} ${pad(di.getHours())}:${pad(di.getMinutes())}`
    appendIndexRow(folder, dateStr, title, m.mode, durMin, file.slice(folder.length + 1))
  }
  return file
}

/** Neutralize any line that would be parsed as a markdown heading (e.g. "## Sneaky heading") inside a
 *  user-authored debrief body. Without this, a heading-shaped line in the user's OWN text is
 *  indistinguishable from a real document section — both to appendDebrief's own replace-boundary search
 *  below and to any markdown renderer. Escaping the leading `#`s keeps the text fully visible, just not
 *  heading syntax. */
function escapeHeadingLines(s: string): string {
  return s.replace(/^(#{1,6})(\s)/gm, '\\$1$2')
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
export const DEBRIEF_HEADING = '## Debrief (off the record)'
const DEBRIEF_END_MARKER = '<!-- /debrief -->'
export async function appendDebrief(
  settings: Settings,
  file: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const folder = resolveMeetingsFolder(settings)
  const path = join(folder, basename(file))
  if (!existsSync(path)) return { ok: false, error: 'Meeting file not found.' }
  let md: string
  try {
    md = readSavedFile(path)
  } catch {
    return { ok: false, error: 'Could not read the meeting file.' }
  }
  if (!/^type: meeting-transcript$/m.test(md)) return { ok: false, error: 'Not a meeting transcript.' }
  const safeText = escapeHeadingLines(text.trim())
  const section =
    `${DEBRIEF_HEADING}\n\n_Captured right after the meeting — impressions, not transcript._\n\n` +
    `${safeText}\n${DEBRIEF_END_MARKER}\n`
  const start = md.indexOf(DEBRIEF_HEADING)
  let updated: string
  if (start < 0) {
    updated = md.trimEnd() + '\n\n' + section
  } else {
    const markerIdx = md.indexOf(DEBRIEF_END_MARKER, start + DEBRIEF_HEADING.length)
    if (markerIdx >= 0) {
      // Exact boundary: everything after the marker's own line belongs to whatever comes next.
      const afterMarker = md.indexOf('\n', markerIdx)
      updated = md.slice(0, start) + section + (afterMarker >= 0 ? md.slice(afterMarker + 1) : '')
    } else {
      // Legacy file written before this marker existed: fall back to the old heuristic.
      const next = md.indexOf('\n## ', start + DEBRIEF_HEADING.length)
      updated = md.slice(0, start) + section + (next >= 0 ? md.slice(next + 1) : '')
    }
  }
  await writeSaved(path, updated, settings.encryptTranscripts)
  return { ok: true }
}

// Keyed by the meeting's OWN startedAt (like saveMeeting's real filename), not a single fixed name.
// A fixed name would let the NEXT meeting's very first autosave tick silently overwrite a PREVIOUS
// meeting's crash-recovery copy before anyone had a chance to notice it — defeating the whole point.
// stamp() alone only has 1-second (HHMMSS) resolution, so two meetings starting in the same wall-clock
// second would still collide on it — the millisecond suffix (kept behind its own "-", so it still reads
// as "<HHMMSS>-<ms>" for recall.ts's FILENAME_TIMESTAMP retention regex, which only requires a literal
// "-" right after the 6-digit time) closes that gap down to true per-meeting uniqueness.
const draftFilename = (started: number): string =>
  `.autosave-draft-${stamp(started)}-${String(started % 1000).padStart(3, '0')}.md`

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
 */
export async function saveDraftTranscript(settings: Settings, m: SaveMeeting): Promise<void> {
  try {
    const folder = ensureMeetingsFolder(settings)
    const started = m.startedAt || Date.now()
    const file = join(folder, draftFilename(started))
    const title = cleanTitle(m.title) || `${m.mode} meeting`
const transcript = formatTranscript(m.lines)
    // Same duration_min/participants calc as saveMeeting above — without these, a draft promoted by
    // recoverOrphanDrafts (which only swaps the type:/status: lines, never adds fields) reads back with
    // durationMin 0 and an empty participants list forever, silently losing that badge on recovery.
    const last = m.lines.length ? m.lines[m.lines.length - 1].t : started
    const durMin = m.lines.length ? Math.max(1, Math.round((last - started) / 60000)) : 0
    const participants = Array.from(new Set(m.lines.map((l) => speakerLabel(l.speaker))))
    const frontmatter = [
      '---',
      'type: meeting-transcript-draft',
      'source: Métis',
      `mode: "${yamlSafeTitle(cleanTitle(m.mode))}"`,
      `date: ${new Date(started).toISOString()}`,
      `title: "${yamlSafeTitle(title)}"`,
      `participants: [${participants.join(', ')}]`,
      `duration_min: ${durMin}`,
      'status: interrupted',
      '---',
      ''
    ].join('\n')
    const body =
      `# ${title} (in progress — autosaved draft)\n\n` +
      'This is an automatic snapshot of a meeting still in progress, or one that ended without a normal ' +
      'save (crash / force quit). If Métis is still running this meeting, ignore this file — the real ' +
      'save replaces it when the meeting ends.\n\n' +
      `## Transcript so far\n\n${transcript || '_No speech captured yet._'}\n`
    await writeSaved(file, frontmatter + body, settings.encryptTranscripts)
  } catch {
    /* best-effort — an autosave failure must never interrupt the meeting */
  }
}

/** Remove one meeting's autosave draft once it ends normally (its real saveMeeting() already succeeded). */
export function clearDraftTranscript(settings: Settings, startedAt: number): void {
  try {
    const file = join(resolveMeetingsFolder(settings), draftFilename(startedAt))
    if (existsSync(file)) unlinkSync(file)
  } catch {
    /* best-effort */
  }
}

const IN_PROGRESS_SUFFIX = ' (in progress — autosaved draft)'

/**
 * Promote orphaned autosave drafts into real, visible meetings (run once at launch). A draft only
 * survives on disk when its meeting never reached a normal save — a crash or force-quit — so leaving
 * it as an invisible dot-file meant the recording of third-party speech sat outside History, outside
 * the retention sweep, and outside recovery, forever. Promotion re-enters it into the normal
 * lifecycle: it appears in History as "(recovered)", retention applies (the recovered filename keeps
 * the stamp prefix the sweep parses), and the user loses at most the final autosave interval instead
 * of the whole meeting. Runs before any Listen session starts, and drafts are keyed by their own
 * startedAt, so a live meeting's draft can never be promoted out from under it. Undecryptable drafts
 * (foreign keychain) are left in place for the device that can read them. Idempotent across repeated
 * runs: a draft whose promoted file already exists (e.g. because a prior run's unlink failed after a
 * successful write) is never re-promoted — only its stale source file is retried for cleanup — and,
 * in plaintext mode, the recovered meeting gets an index.md row exactly like a normally-saved one.
 */
export async function recoverOrphanDrafts(settings: Settings): Promise<{ recovered: number }> {
  let recovered = 0
  try {
    const folder = resolveMeetingsFolder(settings)
    if (!existsSync(folder)) return { recovered }
    for (const dirent of readdirSync(folder, { withFileTypes: true })) {
      const f = dirent.name
      if (!f.startsWith('.autosave-draft-') || !f.endsWith('.md')) continue
      if (!dirent.isFile()) continue // never follow a symlink planted with a draft-shaped name
      const draftPath = join(folder, f)
      try {
        const stampPart = f.slice('.autosave-draft-'.length, -'.md'.length)
        const primaryOut = join(folder, `${stampPart}-recovered.md`)
        if (existsSync(primaryOut)) {
          // Already promoted by a previous run — this draft only still exists because that run's
          // unlink below failed afterward (transient EBUSY/EPERM; this folder is often OneDrive-synced).
          // Re-promoting would write a second, fully duplicate "-recovered-2.md" copy of the same
          // meeting, so just retry the cleanup and move on without touching `recovered`.
          try {
            unlinkSync(draftPath)
          } catch {
            /* still stale for the next run — harmless; the existsSync(primaryOut) guard prevents a dupe */
          }
          continue
        }
        const text = decodeSaved(readFileSync(draftPath))
        if (!text) continue // undecryptable on this device — leave it alone
        const promoted = text
          .replace('type: meeting-transcript-draft', 'type: meeting-transcript')
          .replace('status: interrupted', 'status: recovered')
          .replace(IN_PROGRESS_SUFFIX, ' (recovered)')
        let out = primaryOut
        for (let n = 2; existsSync(out); n++) out = join(folder, `${stampPart}-recovered-${n}.md`)
        await writeSaved(out, promoted, settings.encryptTranscripts)
        try {
          unlinkSync(draftPath)
        } catch {
          // The promoted copy is already safely on disk; a future run will see primaryOut exists and
          // skip re-promoting this same stale draft (see the guard above), only retrying its cleanup.
        }
        recovered++

        // Mirror saveMeeting's exact plaintext-mode index.md bookkeeping (same condition, same row
        // shape) — a recovered meeting should be just as discoverable from index.md as a normal one.
        if (!settings.encryptTranscripts) {
          const lines = text.split('\n')
          const dateLine = lines.find((l) => l.startsWith('date: '))
          const modeLine = lines.find((l) => l.startsWith('mode: '))
          const h1Line = lines.find((l) => l.startsWith('# ') && l.endsWith(IN_PROGRESS_SUFFIX))
          const d = dateLine ? new Date(dateLine.slice('date: '.length)) : new Date()
          const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
          const title = h1Line ? h1Line.slice(2, -IN_PROGRESS_SUFFIX.length) : 'Recovered meeting'
          // mode is now written quoted (see saveDraftTranscript); strip the wrapping quotes so a
          // recovered meeting's index row shows the bare value, same as before that change.
          const mode = modeLine ? modeLine.slice('mode: '.length).replace(/^"|"$/g, '') : 'meeting'
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Minimal, deterministic markdown→HTML for RECAP_PROMPT's fixed shape only (## headings, "-"/"*" bullet
 * lists, plain paragraphs) — not a general markdown parser. Used solely to print a recap to PDF via
 * Electron's webContents.printToPDF(); no npm dependency needed for that one job.
 */
export function recapMarkdownToHtml(markdown: string, title?: string): string {
  const body: string[] = []
  let inList = false
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd()
    const h2 = /^##\s+(.*)/.exec(line)
    const bullet = /^[-*]\s+(.*)/.exec(line)
    if (h2) {
      if (inList) {
        body.push('</ul>')
        inList = false
      }
      body.push(`<h2>${escapeHtml(h2[1])}</h2>`)
    } else if (bullet) {
      if (!inList) {
        body.push('<ul>')
        inList = true
      }
      body.push(`<li>${escapeHtml(bullet[1])}</li>`)
    } else if (line.trim()) {
      if (inList) {
        body.push('</ul>')
        inList = false
      }
      body.push(`<p>${escapeHtml(line)}</p>`)
    }
  }
  if (inList) body.push('</ul>')
  const style =
    'body{font-family:-apple-system,Helvetica,Arial,sans-serif;color:#1a1a1a;padding:32px;line-height:1.5}' +
    'h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.02em;' +
    'color:#444;margin:20px 0 8px}ul{margin:0 0 8px;padding-left:20px}li{margin-bottom:4px}p{margin:0 0 8px}'
  const heading = title ? `<h1>${escapeHtml(title)}</h1>` : ''
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${style}</style></head><body>${heading}${body.join('\n')}</body></html>`
}

/**
 * Parse a RECAP_PROMPT markdown document into a structured export (for piping into Jira/Asana/Notion).
 * Sections come from RECAP_PROMPT's fixed "## Name:" headings; action-item owners are pulled from the
 * common "task (Owner)" / "task — Owner" / "task - Owner" trailers when present. Best-effort: unknown or
 * reworded sections fall through to empty arrays, and the full original markdown is always included so
 * nothing is ever lost.
 */
export function parseRecapMarkdown(markdown: string): RecapExport {
  const md = typeof markdown === 'string' ? markdown : ''

  // Split on "## " headings; map each heading (colon-trimmed, lowercased) to its body up to the next "## ".
  // Models sometimes emit the content INLINE on the heading line ("## Title: Renault Contract Renewal")
  // instead of on the next line — the prompt's own "## Title: 2 to 4 words…" template invites that shape.
  // For KNOWN section names, split at the first colon and treat the remainder as the body's first line;
  // unknown headings keep the strict whole-line key so a legitimate colon in prose isn't mis-split.
  const KNOWN = new Set([
    'title', 'tags', 'overview', 'topics', 'key q&a', 'key qa',
    'decisions', 'action items', 'open questions', 'notable quotes'
  ])
  const sections: Record<string, string> = {}
  for (const part of md.split(/^##\s+/m)) {
    const nl = part.indexOf('\n')
    const headRaw = (nl === -1 ? part : part.slice(0, nl)).trim()
    let body = nl === -1 ? '' : part.slice(nl + 1).trim()
    let heading = headRaw.replace(/:\s*$/, '').trim().toLowerCase()
    const colon = headRaw.indexOf(':')
    if (colon > 0 && colon < headRaw.length - 1) {
      const maybeKey = headRaw.slice(0, colon).trim().toLowerCase()
      if (KNOWN.has(maybeKey)) {
        heading = maybeKey
        const inline = headRaw.slice(colon + 1).trim()
        body = body ? `${inline}\n${body}` : inline
      }
    }
    if (heading) sections[heading] = body
  }

  const bullets = (text: string | undefined): string[] =>
    (text || '')
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, '').trim()) // strip bullet + optional [ ]/[x] checkbox
      .filter((l) => l.length > 0)

  const actionItems = bullets(sections['action items']).map((text) => {
    // "Do the thing (Alice)". Non-greedy text + a paren-free owner anchored to the end, so a stray inner
    // paren (e.g. "(Alice (boss))") degrades gracefully to owner:null rather than a wrong split.
    const paren = text.match(/^(.*?\S)\s*\(([^()]+)\)\s*$/)
    if (paren) return { text: paren[1].trim(), owner: paren[2].trim() }
    const dash = text.match(/^(.*\S)\s+[—-]\s+(.+)$/) // "Do the thing — Alice" / "Do the thing - Alice"
    if (dash) return { text: dash[1].trim(), owner: dash[2].trim() }
    return { text, owner: null as string | null }
  })

  // "## Title:" body — first line only, wrapping quotes/emphasis (models mirror the prompt's quoted
  // example) and trailing punctuation stripped, capped for filename/UI safety.
  const titleBody = (sections['title'] || '').split('\n')[0].trim()
  const title24 = titleBody
    .replace(/^["'“”*_\s]+|["'“”*_\s]+$/g, '')
    .replace(/[.!?,;:]+$/, '')
    .trim()
    .slice(0, 60)

  // "## Tags:" body — usually one comma-separated line, but tolerate the model emitting a bullet list.
  // Tags feed unquoted YAML flow-sequence frontmatter and React keys, so strip quote/bracket/backslash
  // characters, dedup case-insensitively, cap at 5.
  const tagsSection = sections['tags'] || ''
  const tagList = /^\s*[-*]/m.test(tagsSection) ? bullets(tagsSection) : [tagsSection]
  const tags: string[] = []
  const seenTags = new Set<string>()
  for (const raw of tagList.flatMap((t) => t.split(/[,\n]/))) {
    const tag = raw.replace(/["'“”\\[\]]/g, '').trim()
    if (!tag || seenTags.has(tag.toLowerCase())) continue
    seenTags.add(tag.toLowerCase())
    tags.push(tag)
    if (tags.length === 5) break
  }

  return {
    title24,
    tags,
    overview: sections['overview'] || '',
    topics: bullets(sections['topics']),
    keyQA: bullets(sections['key q&a'] || sections['key qa']),
    decisions: bullets(sections['decisions']),
    actionItems,
    openQuestions: bullets(sections['open questions']),
    notableQuotes: bullets(sections['notable quotes']),
    markdown: md
  }
}
