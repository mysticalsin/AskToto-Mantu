import { app, safeStorage } from 'electron'
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, createCipheriv, createDecipheriv, publicEncrypt, constants } from 'node:crypto'
import type { SaveMeeting, SaveNote, Settings, RecapExport } from '@shared/ipc'

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

/** Machine-wide org-policy managed-config location IT can deploy (mirrors auth.ts / store.ts). */
function adminManagedConfigPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/AskToto/managed-config.json'
  if (process.platform === 'win32')
    return join(process.env.ProgramData || 'C:\\ProgramData', 'AskToto', 'managed-config.json')
  return '/etc/asktoto/managed-config.json'
}

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
    const machine = resolveEscrowPem(readEscrowFromManaged(adminManagedConfigPath()))
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

/** Build the v2 envelope on-disk buffer (marker + JSON). May throw if the keychain is unavailable; callers
 *  guard with safeStorage.isEncryptionAvailable() and fall back to plaintext, preserving today's behavior. */
function encryptEnvelopeV2(content: string): Buffer {
  const contentKey = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
  const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // LOCAL wrap: the OS keychain encrypts the content key so this device can always decrypt (current UX).
  const kLocal = safeStorage.encryptString(contentKey.toString('base64'))
  const env: EnvelopeV2 = {
    v: 2,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
    kLocal: kLocal.toString('base64')
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
      console.warn('AskToto: escrow public key configured but unusable; wrote transcript without escrow wrap')
    }
  }
  return Buffer.concat([ENC_MARKER_V2, Buffer.from(JSON.stringify(env), 'utf8')])
}

/** Decrypt a v2 envelope via the local keychain. Throws on malformed/foreign-keychain input so
 *  tryDecodeSaved degrades to the UNDECRYPTABLE path instead of crashing a read. */
function decryptEnvelopeV2(buf: Buffer): string {
  const env = JSON.parse(buf.subarray(MARKER_LEN).toString('utf8')) as EnvelopeV2
  const contentKey = Buffer.from(safeStorage.decryptString(Buffer.from(env.kLocal, 'base64')), 'base64')
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

/** True if the file on disk is one of AskToto's encrypted transcripts. */
export function isEncryptedFile(path: string): boolean {
  try {
    const head = readFileSync(path).subarray(0, MARKER_LEN)
    return head.equals(ENC_MARKER) || head.equals(ENC_MARKER_V2)
  } catch {
    return false
  }
}

/** Atomic write; encrypts at rest when `encrypt` and the keychain is available. Cleans up temp on failure. */
async function writeSaved(file: string, content: string, encrypt: boolean): Promise<void> {
  let data: Buffer = Buffer.from(content, 'utf8')
  if (encrypt) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        // v2 envelope: per-file AES-256-GCM content key, safeStorage-wrapped (+ optional org escrow wrap).
        data = encryptEnvelopeV2(content)
      }
    } catch {
      /* keychain unavailable — fall back to plaintext below */
    }
  }
  const tmp = `${file}.tmp`
  try {
    await writeFile(tmp, data, { mode: 0o600 }) // async: off the main-process event loop
    await rename(tmp, file)
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

/** Decrypt an encrypted transcript to a temp plaintext file so it can be opened in an editor.
 *  Owner-only (0o600), randomized name, and unlinked on app quit. */
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

const README = `# AskToto — Meeting transcripts

This folder is created and maintained by **AskToto**. Every meeting you run the copilot in is
saved here automatically as one markdown file: AI notes + the full timestamped transcript, with
frontmatter (\`type: meeting-transcript\`, \`status: ready-for-followup\`).

## For your Dust agents
- Read **index.md** for the running list of meetings, or scan the \`*.md\` files directly.
- Each file is tagged \`status: ready-for-followup\` — generate follow-ups, then update the status.
- Filenames are \`YYYY-MM-DD_HHMMSS-<slug>.md\`; frontmatter carries date, mode, participants, duration.

Do not rename this folder — AskToto and your agents read from here.
`

const INDEX_HEADER = `# AskToto Meetings — Index

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
    appendFileSync(index, `| ${dateStr} | ${safeTitle} | ${mode} | ${durMin} min | [open](${fileName}) |\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

/** Find the user's OneDrive root. Cross-platform (macOS / Windows / Linux). */
export function detectOneDrive(): string {
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
  const base = detectOneDrive() || app.getPath('documents')
  return join(base, 'AskToto Meetings')
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
const cleanTitle = (s: string): string => {
  // Collapse whitespace, strip control/newline chars, limit length for YAML/frontmatter safety.
  return (s || '')
    .replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}
const yamlSafeTitle = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')

/** Save any single Q&A / answer as a Dust-readable markdown note. Returns the file path. */
export async function saveNote(settings: Settings, n: SaveNote): Promise<string> {
  const folder = ensureMeetingsFolder(settings)
  const started = Date.now()
  const title = cleanTitle(n.title || n.question || 'Note') || 'Note'
  let file = join(folder, `${stamp(started)}-note-${slug(title)}.md`)
  for (let i = 2; existsSync(file); i++) {
    file = join(folder, `${stamp(started)}-note-${slug(title)}-${i}.md`)
  }
  const frontmatter = [
    '---',
    'type: note',
    'source: AskToto',
    `mode: ${n.mode}`,
    `date: ${new Date(started).toISOString()}`,
    `title: "${yamlSafeTitle(title)}"`,
    'status: ready-for-followup',
    '---',
    ''
  ].join('\n')
  const body =
    `# ${title}\n\n_${new Date(started).toLocaleString()} · note · AskToto_\n\n` +
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

  const started = m.startedAt || Date.now()
  const title = cleanTitle(m.title) || `${m.mode} meeting`
  let file = join(folder, `${stamp(started)}-${slug(title)}.md`)
  for (let n = 2; existsSync(file); n++) {
    file = join(folder, `${stamp(started)}-${slug(title)}-${n}.md`)
  }

  const last = m.lines.length ? m.lines[m.lines.length - 1].t : started
  const durMin = m.lines.length ? Math.max(1, Math.round((last - started) / 60000)) : 0
  const participants = Array.from(new Set(m.lines.map((l) => (l.speaker === 'them' ? 'Them' : 'You'))))

  const transcript = m.lines
    .map((l) => {
      const d = new Date(l.t)
      const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      return `**[${t}] ${l.speaker === 'them' ? 'Them' : 'You'}:** ${l.text}`
    })
    .join('\n\n')

  const frontmatter =
    [
      '---',
      'type: meeting-transcript',
      'source: AskToto',
      `mode: ${m.mode}`,
      `date: ${new Date(started).toISOString()}`,
      `title: "${yamlSafeTitle(title)}"`,
      `participants: [${participants.join(', ')}]`,
      `duration_min: ${durMin}`,
      `lines: ${m.lines.length}`,
      'status: ready-for-followup',
      '---',
      ''
    ].join('\n')

  const body =
    `# ${title}\n\n_${new Date(started).toLocaleString()} · ${m.mode} · ${durMin} min · AskToto_\n\n` +
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
  const sections: Record<string, string> = {}
  for (const part of md.split(/^##\s+/m)) {
    const nl = part.indexOf('\n')
    if (nl === -1) continue
    const heading = part.slice(0, nl).replace(/:\s*$/, '').trim().toLowerCase()
    if (heading) sections[heading] = part.slice(nl + 1).trim()
  }

  const bullets = (text: string | undefined): string[] =>
    (text || '')
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s+/, '').trim()) // strip a leading bullet marker
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

  return {
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
