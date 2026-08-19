import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync
} from 'node:fs'
import { rename as renameAsync } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto'
import { app, safeStorage } from 'electron'
import {
  saveMeeting,
  readSavedFile,
  isEncryptedFile,
  parseRecapMarkdown,
  recapMarkdownToHtml,
  saveDraftTranscript,
  clearDraftTranscript,
  appendDebrief,
  DEBRIEF_HEADING,
  recoverOrphanDrafts,
  writeSaved,
  resolveMeetingsFolder,
  formatTranscript,
  meetingDurationMin,
  decryptToTemp
} from './transcripts'
import type { SaveMeeting, Settings } from '@shared/ipc'

const V2_MARKER = 'ATKENC2\n'
const parseEnvelope = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file).subarray(V2_MARKER.length).toString('utf8'))

vi.mock('electron')

// node:fs/promises.rename is a vi.fn wrapping the real implementation by default (via renameSync,
// which node:fs is NOT mocked for) so writeSaved's EPERM/EBUSY retry can be exercised deterministically.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(async (src: string, dest: string) => renameSync(src, dest))
  }
})

const baseSettings = (): Settings =>
  ({
    meetingsFolder: '',
    autoSaveTranscripts: true
  } as Settings)

describe('formatTranscript language-switch markers', () => {
  it('inserts an italic marker paragraph where the tagged language changes, and nowhere else', () => {
    const t = Date.UTC(2026, 6, 20, 9, 0, 0)
    const body = formatTranscript([
      { speaker: 'them', text: 'Então vamos ver o contrato.', t, lang: 'Portuguese' },
      { speaker: 'you', text: 'Sim, perfeito.', t: t + 1000, lang: 'Portuguese' },
      { speaker: 'them', text: 'So, about the budget.', t: t + 2000, lang: 'English' },
      { speaker: 'you', text: 'Hmm.', t: t + 3000 }, // untagged — no marker, no language change
      { speaker: 'them', text: 'De volta ao contrato então.', t: t + 4000, lang: 'Portuguese' }
    ])
    const markers = body.match(/_\[conversation switches to [^\]]+\]_/g)
    expect(markers).toEqual(['_[conversation switches to English]_', '_[conversation switches to Portuguese]_'])
    // Marker sits as its own paragraph immediately before the line that switched.
    expect(body).toContain('_[conversation switches to English]_\n\n**')
    // The marker must NOT match the `**[HH:MM:SS] Label:**` shape recall.ts parses back — a re-parsed
    // meeting simply skips it (same regex as recall.ts's lineRe).
    const lineRe = /^\*\*\[(\d{2}):(\d{2}):(\d{2})\] (Them|You|Speaker)(?: \(([^)]*)\))?:\*\* (.+)$/gm
    const parsed = [...body.matchAll(lineRe)]
    expect(parsed).toHaveLength(5)
  })

  it('emits no markers for a single-language or untagged transcript (unchanged legacy shape)', () => {
    const t = Date.UTC(2026, 6, 20, 9, 0, 0)
    const tagged = formatTranscript([
      { speaker: 'them', text: 'Olá.', t, lang: 'Portuguese' },
      { speaker: 'you', text: 'Tudo bem.', t: t + 1000, lang: 'Portuguese' }
    ])
    const untagged = formatTranscript([
      { speaker: 'them', text: 'Olá.', t },
      { speaker: 'you', text: 'Tudo bem.', t: t + 1000 }
    ])
    expect(tagged).not.toContain('conversation switches')
    expect(untagged).not.toContain('conversation switches')
  })
})

describe('transcripts', () => {
  let folder: string
  let settings: Settings

  beforeEach(() => {
    delete process.env.ASKTOTO_ESCROW_PUBKEY // isolate escrow tests from each other and the host env
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    folder = mkdtempSync(join(tmpdir(), 'asktoto-transcripts-test-'))
    settings = { ...baseSettings(), meetingsFolder: folder }
  })

  afterEach(() => {
    delete process.env.ASKTOTO_ESCROW_PUBKEY
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    delete process.env.ASKTOTO_USERDATA
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('keeps a QA profile’s implicit meeting store inside its isolated user-data root', () => {
    const qaRoot = join(folder, 'isolated-profile')
    process.env.ASKTOTO_USERDATA = qaRoot

    expect(resolveMeetingsFolder({ ...settings, meetingsFolder: '' })).toBe(join(qaRoot, 'Métis Meetings'))
  })

  it('encrypts the transcript at rest when enabled and round-trips via readSavedFile', async () => {
    // Real base64 round-trip so "not plaintext" is meaningful (default mock only tags the value).
    vi.spyOn(safeStorage, 'encryptString').mockImplementation((v: string) =>
      Buffer.from('B64:' + Buffer.from(v, 'utf8').toString('base64'))
    )
    vi.spyOn(safeStorage, 'decryptString').mockImplementation((b: Buffer) => {
      const s = b.toString('utf8')
      return s.startsWith('B64:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s
    })
    const enc = { ...settings, encryptTranscripts: true } as Settings
    const meeting: SaveMeeting = {
      title: 'Secret board meeting',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [{ speaker: 'them', text: 'CONFIDENTIAL-DEAL-XYZ', t: 1_700_000_000_000 }],
      recap: 'TOP-SECRET-RECAP'
    }
    const file = await saveMeeting(enc, meeting)
    const raw = readFileSync(file).toString('utf8')
    expect(isEncryptedFile(file)).toBe(true)
    expect(raw).not.toContain('CONFIDENTIAL-DEAL-XYZ')
    expect(raw).not.toContain('TOP-SECRET-RECAP')
    const decrypted = readSavedFile(file)
    expect(decrypted).toContain('CONFIDENTIAL-DEAL-XYZ')
    expect(decrypted).toContain('TOP-SECRET-RECAP')
    // The plaintext index.md must not leak the meeting title in encrypted mode (no row appended).
    const idx = readdirSync(folder).includes('index.md')
      ? readFileSync(join(folder, 'index.md'), 'utf8')
      : ''
    expect(idx).not.toContain('Secret board meeting')
  })

  it('writes a v2 envelope and round-trips when no escrow key is configured (no regression)', async () => {
    delete process.env.ASKTOTO_ESCROW_PUBKEY
    const enc = { ...settings, encryptTranscripts: true } as Settings
    const file = await saveMeeting(enc, {
      title: 'Quarterly review',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [{ speaker: 'them', text: 'SECRET-NO-ESCROW', t: 1_700_000_000_000 }],
      recap: ''
    })
    const buf = readFileSync(file)
    expect(buf.subarray(0, V2_MARKER.length).toString('utf8')).toBe(V2_MARKER) // v2 magic marker
    expect(isEncryptedFile(file)).toBe(true)
    expect(buf.toString('utf8')).not.toContain('SECRET-NO-ESCROW') // ciphertext, not plaintext
    const env = parseEnvelope(file)
    expect(env.v).toBe(2)
    for (const k of ['iv', 'tag', 'ct', 'kLocal']) expect(typeof env[k]).toBe('string')
    expect(env.kEscrow).toBeUndefined() // no escrow key → local-only wrap, behavior matches today
    expect(readSavedFile(file)).toContain('SECRET-NO-ESCROW') // local keychain round-trips
  })

  it('writes a v2 escrow wrap an admin can recover with the org private key (out-of-band)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    process.env.ASKTOTO_ESCROW_PUBKEY = publicKey
    const enc = { ...settings, encryptTranscripts: true } as Settings
    const file = await saveMeeting(enc, {
      title: 'Board escrow test',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [{ speaker: 'them', text: 'ESCROW-RECOVERABLE-SECRET', t: 1_700_000_000_000 }],
      recap: ''
    })
    const env = parseEnvelope(file)
    expect(typeof env.kEscrow).toBe('string') // escrow wrap present when a pubkey is configured
    // Admin recovery path: unwrap the content key with the org PRIVATE key, then AES-GCM-decrypt — no keychain.
    const contentKey = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(env.kEscrow as string, 'base64')
    )
    const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(env.iv as string, 'base64'))
    decipher.setAuthTag(Buffer.from(env.tag as string, 'base64'))
    const recovered = Buffer.concat([
      decipher.update(Buffer.from(env.ct as string, 'base64')),
      decipher.final()
    ]).toString('utf8')
    expect(recovered).toContain('ESCROW-RECOVERABLE-SECRET')
    expect(readSavedFile(file)).toContain('ESCROW-RECOVERABLE-SECRET') // local decrypt still works too
  })

  // MQA-153 — escrow decides WHO can decrypt every future transcript, and the process environment is
  // writable by anything running as the user (HKCU\Environment, `launchctl setenv`) exactly like the
  // per-user managed-config tier this function already refuses to read. The env tier is the DEV tier.
  it('MQA-153 — a packaged build ignores ASKTOTO_ESCROW_PUBKEY so a planted env key cannot escrow transcripts', async () => {
    const { publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    process.env.ASKTOTO_ESCROW_PUBKEY = publicKey
    ;(app as unknown as { isPackaged: boolean }).isPackaged = true
    try {
      const enc = { ...settings, encryptTranscripts: true } as Settings
      const file = await saveMeeting(enc, {
        title: 'Planted escrow key',
        mode: 'meeting',
        startedAt: 1_700_000_000_000,
        lines: [{ speaker: 'them', text: 'NOT-ESCROWED-SECRET', t: 1_700_000_000_000 }],
        recap: ''
      })
      const env = parseEnvelope(file)
      expect(env.kEscrow).toBeUndefined() // no attacker-recoverable wrap written
      expect(typeof env.kLocal).toBe('string') // saving still succeeds, local-only (no regression)
    } finally {
      delete (app as unknown as { isPackaged?: boolean }).isPackaged
    }
  })

  it('still decrypts a legacy v1 (safeStorage-direct) file for backward compatibility', () => {
    const plain = '# Legacy transcript\n\nV1-SECRET-PAYLOAD\n'
    const v1 = Buffer.concat([Buffer.from('ATKENC1\n'), safeStorage.encryptString(plain)])
    const file = join(folder, 'legacy-v1.md')
    writeFileSync(file, v1)
    expect(isEncryptedFile(file)).toBe(true)
    expect(readSavedFile(file)).toBe(plain)
  })

  it('does not query Keychain for a legacy transcript while the local keystore is forced', () => {
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
    ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockClear()
    const file = join(folder, 'legacy-local-keystore.md')
    writeFileSync(file, Buffer.concat([Buffer.from('ATKENC1\n'), Buffer.from('legacy-keychain-payload')]))

    expect(readSavedFile(file)).toBe('')
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it('writes plaintext + index when encryption is off (unchanged default)', async () => {
    const file = await saveMeeting(settings, {
      title: 'Open meeting',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [],
      recap: ''
    })
    expect(isEncryptedFile(file)).toBe(false)
    expect(readFileSync(file, 'utf8')).toContain('# Open meeting')
    expect(readdirSync(folder)).toContain('index.md')
  })

  it('sanitizes a title containing quotes for YAML frontmatter', async () => {
    const meeting: SaveMeeting = {
      title: 'Said "hello" to the team',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [],
      recap: ''
    }
    const file = await saveMeeting(settings, meeting)
    const contents = readFileSync(file, 'utf8')
    expect(contents).toContain('title: "Said \\"hello\\" to the team"')
    expect(contents).not.toContain('title: "Said "hello" to the team"')
  })

  it('sanitizes newlines and control characters from the title', async () => {
    const meeting: SaveMeeting = {
      title: 'Line1\nLine2\r\n\x00\x01\x02',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [],
      recap: ''
    }
    const file = await saveMeeting(settings, meeting)
    const contents = readFileSync(file, 'utf8')
    expect(contents).toContain('# Line1 Line2')
    expect(contents).not.toContain('\nLine2')
    expect(contents).toContain('title: "Line1 Line2"')
  })

  it('generates a stable dated file path with a slug', async () => {
    const meeting: SaveMeeting = {
      title: 'Weekly Product Sync',
      mode: 'meeting',
      startedAt: new Date('2023-11-14T09:30:00Z').getTime(),
      lines: [],
      recap: ''
    }
    const file = await saveMeeting(settings, meeting)
    expect(file.startsWith(folder)).toBe(true)
    expect(file).toContain('2023-11-14_')
    expect(file).toContain('weekly-product-sync')
  })

  it('deduplicates filenames when the same title is saved twice', async () => {
    const meeting: SaveMeeting = {
      title: 'Daily Standup',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [],
      recap: ''
    }
    const file1 = await saveMeeting(settings, meeting)
    const file2 = await saveMeeting(settings, meeting)
    expect(file1).not.toBe(file2)
    expect(file2).toMatch(/daily-standup-2\.md$/)
  })

  // Tony's spec: main is the single source of truth for the final title — the recap's "## Title" beats
  // the renderer's "first 50 chars of their first sentence" heuristic whenever a recap is present.
  it('prefers the recap\'s "## Title" over the renderer-provided heuristic title', async () => {
    const meeting: SaveMeeting = {
      title: 'interview meeting', // renderer heuristic fallback
      mode: 'interview',
      startedAt: 1_700_000_000_000,
      lines: [],
      recap: '## Title:\nLATAM SAP pricing defense\n\n## Tags:\npricing, LATAM, SAP\n\n## Overview:\nx'
    }
    const file = await saveMeeting(settings, meeting)
    const contents = readFileSync(file, 'utf8')
    expect(contents).toContain('title: "LATAM SAP pricing defense"')
    expect(contents).toContain('# LATAM SAP pricing defense')
    expect(file).toContain('latam-sap-pricing-defense')
    expect(contents).not.toContain('interview meeting')
  })

  it('falls back to the renderer-provided heuristic title when there is no recap yet', async () => {
    const meeting: SaveMeeting = {
      title: 'What do you think about the roadmap',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [],
      recap: ''
    }
    const file = await saveMeeting(settings, meeting)
    const contents = readFileSync(file, 'utf8')
    expect(contents).toContain('title: "What do you think about the roadmap"')
  })

  it('falls back to the heuristic title when the recap has no Title section', async () => {
    const meeting: SaveMeeting = {
      title: 'What do you think about the roadmap',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [],
      recap: '## Overview:\nNo title section in this recap.'
    }
    const file = await saveMeeting(settings, meeting)
    const contents = readFileSync(file, 'utf8')
    expect(contents).toContain('title: "What do you think about the roadmap"')
  })

  it('writes topics into frontmatter as a yaml-safe list when the recap has Tags', async () => {
    const meeting: SaveMeeting = {
      title: 'Q3 planning',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [],
      recap: '## Title:\nQ3 roadmap planning\n\n## Tags:\npricing, "LATAM", SAP\n\n## Overview:\nx'
    }
    const file = await saveMeeting(settings, meeting)
    const contents = readFileSync(file, 'utf8')
    // Quotes are stripped at parse time so the unquoted YAML flow sequence stays clean on round-trip.
    expect(contents).toContain('topics: [pricing, LATAM, SAP]')
  })

  it('omits the topics frontmatter line when the recap has no Tags', async () => {
    const meeting: SaveMeeting = {
      title: 'Q3 planning',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [],
      recap: ''
    }
    const file = await saveMeeting(settings, meeting)
    const contents = readFileSync(file, 'utf8')
    expect(contents).not.toContain('topics:')
  })
})

// Tony reported "if Métis crashes mid-meeting the whole transcript is gone" — this exercises the
// crash-recovery autosave's real file-IO path end to end against a temp folder.
describe('appendDebrief (90-second off-record layer)', () => {
  let folder: string
  let settings: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-debrief-test-'))
    settings = { ...baseSettings(), meetingsFolder: folder }
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  const saved = async (): Promise<string> =>
    saveMeeting(settings, {
      title: 'Pricing defense',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [{ speaker: 'them', text: 'the price is high', t: 1_700_000_000_000 }],
      recap: ''
    })

  it('appends the debrief as its own section in the saved meeting', async () => {
    const file = await saved()
    const r = await appendDebrief(settings, file.split('/').pop()!, 'CFO seemed checked out; champion did the selling for us.')
    expect(r.ok).toBe(true)
    const md = readSavedFile(file)
    expect(md).toContain(DEBRIEF_HEADING)
    expect(md).toContain('CFO seemed checked out')
    expect(md.indexOf('## Full transcript')).toBeLessThan(md.indexOf(DEBRIEF_HEADING)) // appended after
  })

  it('a second save replaces the debrief instead of stacking copies', async () => {
    const file = await saved()
    const name = file.split('/').pop()!
    await appendDebrief(settings, name, 'first read')
    await appendDebrief(settings, name, 'second, better read')
    const md = readSavedFile(file)
    expect(md).not.toContain('first read')
    expect(md).toContain('second, better read')
    expect(md.match(new RegExp(DEBRIEF_HEADING.replace(/[()]/g, '\\$&'), 'g'))).toHaveLength(1)
  })

  it('a debrief containing its own "## " heading line round-trips without corrupting the rest of the file, and a re-save still replaces exactly one debrief', async () => {
    const file = await saved()
    const name = file.split('/').pop()!
    const sneaky = 'CFO seemed distracted.\n## Sneaky heading\nAlso send the follow-up email.'
    await appendDebrief(settings, name, sneaky)
    let md = readSavedFile(file)
    // The rest of the document (written before the debrief) must survive untouched.
    expect(md).toContain('## Full transcript')
    expect(md).toContain('the price is high')
    // The debrief's own content — including the heading-shaped line — must all be present...
    expect(md).toContain('CFO seemed distracted.')
    expect(md).toContain('Sneaky heading')
    expect(md).toContain('Also send the follow-up email.')
    // ...but the embedded "## " line must never be mistaken for a real section boundary: exactly two
    // real "## " headings exist in the whole file (Full transcript, Debrief), not a phantom third one.
    expect(md.match(/^## /gm)?.length).toBe(2)

    // A second save must still replace the whole debrief cleanly, with no stale tail leaking through.
    await appendDebrief(settings, name, 'Totally new, unrelated second read.')
    md = readSavedFile(file)
    expect(md).not.toContain('Sneaky heading')
    expect(md).not.toContain('CFO seemed distracted')
    expect(md).not.toContain('follow-up email')
    expect(md).toContain('Totally new, unrelated second read.')
    expect(md.match(new RegExp(DEBRIEF_HEADING.replace(/[()]/g, '\\$&'), 'g'))).toHaveLength(1)
    expect(md.match(/^## /gm)?.length).toBe(2)
  })

  it('refuses missing files and non-transcript files, and stays inside the meetings folder', async () => {
    expect((await appendDebrief(settings, 'nope.md', 'x')).ok).toBe(false)
    writeFileSync(join(folder, 'random.md'), '---\ntype: note\n---\nhello')
    expect((await appendDebrief(settings, 'random.md', 'x')).ok).toBe(false)
    const file = await saved()
    // path traversal collapses to basename → still resolves to the real meeting inside the folder
    const r = await appendDebrief(settings, `../../${file.split('/').pop()!}`, 'gut read')
    expect(r.ok).toBe(true)
    expect(readSavedFile(file)).toContain('gut read')
  })

  it('round-trips through at-rest encryption', async () => {
    vi.spyOn(safeStorage, 'encryptString').mockImplementation((v: string) =>
      Buffer.from('B64:' + Buffer.from(v, 'utf8').toString('base64'))
    )
    vi.spyOn(safeStorage, 'decryptString').mockImplementation((b: Buffer) => {
      const s = b.toString('utf8')
      return s.startsWith('B64:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s
    })
    const enc = { ...settings, encryptTranscripts: true } as Settings
    const file = await saveMeeting(enc, {
      title: 'Secret sync',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [{ speaker: 'them', text: 'hello', t: 1_700_000_000_000 }],
      recap: ''
    })
    const r = await appendDebrief(enc, file.split('/').pop()!, 'OFF-RECORD-HUNCH')
    expect(r.ok).toBe(true)
    expect(readFileSync(file).toString('utf8')).not.toContain('OFF-RECORD-HUNCH') // encrypted on disk
    expect(readSavedFile(file)).toContain('OFF-RECORD-HUNCH')
    vi.restoreAllMocks()
  })
})

describe('saveDraftTranscript / clearDraftTranscript (crash-recovery autosave)', () => {
  let folder: string
  let settings: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-draft-test-'))
    settings = { ...baseSettings(), meetingsFolder: folder }
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const meeting: SaveMeeting = {
    title: 'Standup',
    mode: 'meeting',
    startedAt: 1_700_000_000_000,
    lines: [{ speaker: 'them', text: 'Where are we on the migration?', t: 1_700_000_000_000 }],
    recap: ''
  }

  it('writes a draft marked as a draft (not a real meeting-transcript), invisible to saveMeeting', async () => {
    await saveDraftTranscript(settings, meeting)
    const files = readdirSync(folder).filter((f) => f.endsWith('.md') && f !== 'index.md' && f !== 'README.md')
    expect(files.length).toBe(1)
    const content = readFileSync(join(folder, files[0]), 'utf8')
    expect(content).toContain('type: meeting-transcript-draft')
    expect(content).toContain('Where are we on the migration?')
    // Real saveMeeting's own filename must never collide with the draft's.
    const realFile = await saveMeeting(settings, meeting)
    expect(realFile).not.toContain(files[0])
  })

  it('overwrites the SAME meeting\'s draft on repeated ticks instead of accumulating files', async () => {
    await saveDraftTranscript(settings, meeting)
    await saveDraftTranscript(settings, { ...meeting, lines: [...meeting.lines, { speaker: 'you', text: 'On track', t: 1_700_000_030_000 }] })
    const drafts = readdirSync(folder).filter((f) => f.startsWith('.autosave-draft-'))
    expect(drafts.length).toBe(1)
    expect(readFileSync(join(folder, drafts[0]), 'utf8')).toContain('On track')
  })

  it('does NOT clobber a DIFFERENT (earlier) meeting\'s crash-recovery draft', async () => {
    const crashed: SaveMeeting = { ...meeting, startedAt: 1_600_000_000_000, title: 'Crashed meeting' }
    await saveDraftTranscript(settings, crashed) // meeting A crashed, left its draft on disk
    await saveDraftTranscript(settings, meeting) // meeting B starts later, autosaves its own draft
    const drafts = readdirSync(folder).filter((f) => f.startsWith('.autosave-draft-'))
    expect(drafts.length).toBe(2) // both survive — meeting B's autosave must not overwrite meeting A's
  })

  it('does NOT clobber a different meeting\'s draft when both start within the same wall-clock second', async () => {
    // stamp()'s HHMMSS has only 1-second resolution — these two startedAt values are 500ms apart but
    // land in the identical second, which used to collide on the same draft filename.
    const meetingA: SaveMeeting = {
      ...meeting,
      startedAt: 1_700_000_000_000,
      lines: [{ speaker: 'them', text: 'AAAA content from meeting A', t: 1_700_000_000_000 }]
    }
    const meetingB: SaveMeeting = {
      ...meeting,
      startedAt: 1_700_000_000_500,
      lines: [{ speaker: 'them', text: 'BBBB content from meeting B', t: 1_700_000_000_500 }]
    }
    await saveDraftTranscript(settings, meetingA)
    await saveDraftTranscript(settings, meetingB)
    const drafts = readdirSync(folder).filter((f) => f.startsWith('.autosave-draft-'))
    expect(drafts.length).toBe(2) // distinct filenames — no collision
    const contents = drafts.map((f) => readFileSync(join(folder, f), 'utf8'))
    expect(contents.some((c) => c.includes('AAAA content from meeting A'))).toBe(true)
    expect(contents.some((c) => c.includes('BBBB content from meeting B'))).toBe(true)
  })

  it('clearDraftTranscript removes only that meeting\'s own draft', async () => {
    const other: SaveMeeting = { ...meeting, startedAt: 1_600_000_000_000 }
    await saveDraftTranscript(settings, meeting)
    await saveDraftTranscript(settings, other)
    await clearDraftTranscript(settings, meeting.startedAt)
    const drafts = readdirSync(folder).filter((f) => f.startsWith('.autosave-draft-'))
    expect(drafts.length).toBe(1) // only `other`'s draft remains
  })

  it('never throws, even against an unwritable folder', async () => {
    await expect(
      saveDraftTranscript({ ...settings, meetingsFolder: '/nonexistent/\0bad' }, meeting)
    ).resolves.toBeUndefined()
    await expect(
      clearDraftTranscript({ ...settings, meetingsFolder: '/nonexistent/\0bad' }, meeting.startedAt)
    ).resolves.toBeUndefined()
  })
})

describe('recoverOrphanDrafts (crash-recovery promotion)', () => {
  let folder: string
  let settings: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recover-test-'))
    settings = { ...baseSettings(), meetingsFolder: folder }
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const meeting: SaveMeeting = {
    title: 'Crashed standup',
    mode: 'meeting',
    startedAt: 1_700_000_000_000,
    lines: [{ speaker: 'them', text: 'Where are we on the migration?', t: 1_700_000_000_000 }],
    recap: ''
  }

  const promotedFiles = (): string[] => readdirSync(folder).filter((f) => f.includes('-recovered'))
  const draftFiles = (): string[] => readdirSync(folder).filter((f) => f.startsWith('.autosave-draft-'))

  it('promotes an orphan draft into a real, visible meeting-transcript file', async () => {
    await saveDraftTranscript(settings, meeting)
    const r = await recoverOrphanDrafts(settings)
    expect(r.recovered).toBe(1)
    expect(draftFiles().length).toBe(0)
    expect(promotedFiles().length).toBe(1)
    const content = readFileSync(join(folder, promotedFiles()[0]), 'utf8')
    expect(content).toContain('type: meeting-transcript')
    expect(content).not.toContain('type: meeting-transcript-draft')
    expect(content).toContain('Where are we on the migration?')
    expect(content).toContain('(recovered)')
  })

  it('running recovery twice on the same still-orphaned draft never creates a duplicate meeting (idempotent)', async () => {
    await saveDraftTranscript(settings, meeting)
    const r1 = await recoverOrphanDrafts(settings)
    expect(r1.recovered).toBe(1)
    const afterFirst = promotedFiles()
    expect(afterFirst.length).toBe(1)

    // Simulate the exact failure mode this guards against: the promoted copy already exists on disk
    // (written by the run above) but a draft with the SAME derived filename shows up again — the real
    // trigger is unlinkSync throwing right after a successful writeSaved, which leaves the original
    // draft in place; recreating it here reproduces the same on-disk shape without needing to mock fs.
    await saveDraftTranscript(settings, meeting)
    expect(draftFiles().length).toBe(1)
    const r2 = await recoverOrphanDrafts(settings)
    expect(r2.recovered).toBe(0) // already-promoted draft is skipped, not re-counted
    const afterSecond = promotedFiles()
    expect(afterSecond.length).toBe(1) // still exactly one meeting — no "-recovered-2.md" duplicate
    expect(afterSecond).toEqual(afterFirst) // the same single file, not a new copy
    expect(draftFiles().length).toBe(0) // the stale draft was still cleaned up on this second run
  })

  it('adds the recovered meeting to index.md in plaintext mode, mirroring saveMeeting', async () => {
    await saveDraftTranscript(settings, meeting) // settings.encryptTranscripts is unset/false here
    await recoverOrphanDrafts(settings)
    const idx = readFileSync(join(folder, 'index.md'), 'utf8')
    expect(idx).toContain('Crashed standup')
    expect(idx).toContain(promotedFiles()[0])
  })

  it('does NOT add an index.md row when encryption is on, mirroring saveMeeting', async () => {
    const enc = { ...settings, encryptTranscripts: true } as Settings
    await saveDraftTranscript(enc, meeting)
    await recoverOrphanDrafts(enc)
    const idx = readdirSync(folder).includes('index.md') ? readFileSync(join(folder, 'index.md'), 'utf8') : ''
    expect(idx).not.toContain('Crashed standup')
  })

  // MQA-076: promotion must inherit the DRAFT's own at-rest encryption, not the live toggle. Turning
  // encryption off between the crash and the next launch otherwise rewrites recorded third-party speech
  // as unmarked cleartext and appends the meeting's title to the plaintext index.
  it('MQA-076: keeps an encrypted draft encrypted when the toggle was turned off since the crash', async () => {
    const enc = { ...settings, encryptTranscripts: true } as Settings
    await saveDraftTranscript(enc, meeting)
    expect(isEncryptedFile(join(folder, draftFiles()[0]))).toBe(true)

    // Same profile, toggle since flipped off — the state recoverOrphanDrafts runs in at the next launch.
    const r = await recoverOrphanDrafts({ ...settings, encryptTranscripts: false } as Settings)

    expect(r.recovered).toBe(1)
    const out = join(folder, promotedFiles()[0])
    expect(isEncryptedFile(out)).toBe(true)
    expect(readFileSync(out).toString('utf8')).not.toContain('Where are we on the migration?')
    expect(readSavedFile(out)).toContain('Where are we on the migration?') // readable, just never in the clear
    const idx = readdirSync(folder).includes('index.md') ? readFileSync(join(folder, 'index.md'), 'utf8') : ''
    expect(idx).not.toContain('Crashed standup') // cleartext index must not carry an encrypted meeting's title
  })

  it('MQA-076: promotes a plaintext draft as plaintext even when encryption has since been turned on', async () => {
    await saveDraftTranscript(settings, meeting) // draft written while encryption was off

    await recoverOrphanDrafts({ ...settings, encryptTranscripts: true } as Settings)

    const out = join(folder, promotedFiles()[0])
    expect(isEncryptedFile(out)).toBe(false) // preserved exactly as found, in both directions
    expect(readFileSync(out, 'utf8')).toContain('Where are we on the migration?')
    expect(readFileSync(join(folder, 'index.md'), 'utf8')).toContain('Crashed standup') // row follows the file
  })
})

describe('parseRecapMarkdown', () => {
  const SAMPLE = [
    '## Title:',
    'Q3 launch budget',
    '',
    '## Tags:',
    'launch, budget, Q3, roadmap',
    '',
    '## Overview:',
    'We aligned on the Q3 launch and the budget.',
    '',
    '## Topics:',
    '- Launch timeline',
    '- Budget',
    '',
    '## Decisions:',
    '- Ship on Sept 1',
    '- Freeze scope Friday',
    '',
    '## Action items:',
    '- Send the deck (Alice)',
    '- Book the venue — Bob',
    '- Finalize copy',
    '',
    '## Open questions:',
    '- Who owns PR?',
    '',
    '## Notable quotes:',
    '- "Ship it."'
  ].join('\n')

  it('splits the fixed RECAP_PROMPT sections into structured fields', () => {
    const r = parseRecapMarkdown(SAMPLE)
    expect(r.title24).toBe('Q3 launch budget')
    expect(r.tags).toEqual(['launch', 'budget', 'Q3', 'roadmap'])
    expect(r.overview).toBe('We aligned on the Q3 launch and the budget.')
    expect(r.topics).toEqual(['Launch timeline', 'Budget'])
    expect(r.decisions).toEqual(['Ship on Sept 1', 'Freeze scope Friday'])
    expect(r.openQuestions).toEqual(['Who owns PR?'])
    expect(r.notableQuotes).toEqual(['"Ship it."'])
  })

  describe('title24 / tags', () => {
    it('strips trailing punctuation and caps length', () => {
      const r = parseRecapMarkdown('## Title:\nLATAM SAP pricing defense!!!\n\n## Overview:\nx')
      expect(r.title24).toBe('LATAM SAP pricing defense')
    })

    it('caps an overlong title to exactly 60 chars', () => {
      const long = 'A'.repeat(80)
      const r = parseRecapMarkdown(`## Title:\n${long}\n\n## Overview:\nx`)
      expect(r.title24).toBe('A'.repeat(60))
    })

    it('strips the wrapping quotes/emphasis models mirror from the prompt example', () => {
      const r = parseRecapMarkdown('## Title:\n"LATAM SAP pricing defense"\n\n## Overview:\nx')
      expect(r.title24).toBe('LATAM SAP pricing defense')
      const bold = parseRecapMarkdown('## Title:\n**Q3 budget lock**\n\n## Overview:\nx')
      expect(bold.title24).toBe('Q3 budget lock')
    })

    it('strips quote/bracket junk from tags and dedupes them case-insensitively', () => {
      const r = parseRecapMarkdown('## Tags:\npricing, Pricing, "LATAM", [SAP], pricing, budget\n\n## Overview:\nx')
      expect(r.tags).toEqual(['pricing', 'LATAM', 'SAP', 'budget'])
    })

    it('returns empty string when the Title section is absent', () => {
      const r = parseRecapMarkdown('## Overview:\nJust an overview, no title section.')
      expect(r.title24).toBe('')
    })

    it('only reads the first line of the Title body', () => {
      const r = parseRecapMarkdown('## Title:\nReal title\nExtra stray line\n\n## Overview:\nx')
      expect(r.title24).toBe('Real title')
    })

    it('parses a comma-separated Tags line, trimmed and capped to 5', () => {
      const r = parseRecapMarkdown('## Tags:\n one , two ,three,four,five,six \n\n## Overview:\nx')
      expect(r.tags).toEqual(['one', 'two', 'three', 'four', 'five'])
    })

    it('tolerates the model emitting Tags as a bullet list instead of a comma line', () => {
      const r = parseRecapMarkdown('## Tags:\n- pricing\n- LATAM\n- SAP\n\n## Overview:\nx')
      expect(r.tags).toEqual(['pricing', 'LATAM', 'SAP'])
    })

    it('returns an empty array when the Tags section is absent', () => {
      const r = parseRecapMarkdown('## Overview:\nNo tags here.')
      expect(r.tags).toEqual([])
    })

    // Regression: real models emit the content INLINE on the heading line ("## Title: Renault Contract
    // Renewal"), mirroring the prompt's own template shape. The first live run produced exactly this and
    // title24 came back empty, so the saved file silently fell back to the first-words heuristic name.
    it('parses inline heading content ("## Title: X" on one line), the shape real models emit', () => {
      const md = '## Title: Renault Contract Renewal\n## Tags: Renault, procurement, contract renewal, data migration, pricing\n## Overview: A working discussion on renewing the contract.'
      const r = parseRecapMarkdown(md)
      expect(r.title24).toBe('Renault Contract Renewal')
      expect(r.tags).toEqual(['Renault', 'procurement', 'contract renewal', 'data migration', 'pricing'])
      expect(r.overview).toBe('A working discussion on renewing the contract.')
    })

    it('parses an inline final section with no trailing newline', () => {
      const r = parseRecapMarkdown('## Overview: x\n## Tags: alpha, beta')
      expect(r.tags).toEqual(['alpha', 'beta'])
    })

    it('does not colon-split unknown headings (a colon inside prose-style headings stays intact)', () => {
      const r = parseRecapMarkdown('## Note: not a known section\nBody here\n## Overview:\nx')
      expect(r.overview).toBe('x')
      // The unknown heading keeps its whole-line key; nothing leaks into known sections.
      expect(r.title24).toBe('')
    })
  })

  it('extracts action-item owners from "(Owner)" and "— Owner", leaving plain items unowned', () => {
    const r = parseRecapMarkdown(SAMPLE)
    expect(r.actionItems).toEqual([
      { text: 'Send the deck', owner: 'Alice', dueDateText: null },
      { text: 'Book the venue', owner: 'Bob', dueDateText: null },
      { text: 'Finalize copy', owner: null, dueDateText: null }
    ])
  })

  it('degrades to owner:null on a nested-paren owner rather than mis-splitting', () => {
    const r = parseRecapMarkdown('## Action items:\n- Do the thing (Alice (boss))')
    expect(r.actionItems).toEqual([{ text: 'Do the thing (Alice (boss))', owner: null, dueDateText: null }])
  })

  describe('actionItems dueDateText — best-effort trailing "by <phrase>"', () => {
    it('extracts a due-date phrase from a plain item with no owner', () => {
      const r = parseRecapMarkdown('## Action items:\n- Send the deck by Friday')
      expect(r.actionItems).toEqual([{ text: 'Send the deck', owner: null, dueDateText: 'Friday' }])
    })

    it('extracts a due-date phrase alongside a "(Owner)" trailer', () => {
      const r = parseRecapMarkdown('## Action items:\n- Send the deck by June 5 (Alice)')
      expect(r.actionItems).toEqual([{ text: 'Send the deck', owner: 'Alice', dueDateText: 'June 5' }])
    })

    it('extracts a due-date phrase alongside a "— Owner" trailer', () => {
      const r = parseRecapMarkdown('## Action items:\n- Book the venue by next week — Bob')
      expect(r.actionItems).toEqual([{ text: 'Book the venue', owner: 'Bob', dueDateText: 'next week' }])
    })

    it('is null when no trailing "by" clause is present', () => {
      const r = parseRecapMarkdown('## Action items:\n- Finalize copy')
      expect(r.actionItems).toEqual([{ text: 'Finalize copy', owner: null, dueDateText: null }])
    })

    it('does not mistake "by" appearing mid-sentence as a hint absent an actual trailing clause split', () => {
      // The regex is intentionally greedy/simple — this documents the accepted best-effort behavior
      // rather than a stricter NLP-level extraction (RECAP_PROMPT never asks the model for structured
      // dates, so this stays a display string, not a parser to get perfectly right).
      const r = parseRecapMarkdown('## Action items:\n- Stand by for the client call')
      expect(r.actionItems).toEqual([{ text: 'Stand', owner: null, dueDateText: 'for the client call' }])
    })
  })

  it('always preserves the full original markdown and never throws on junk input', () => {
    expect(parseRecapMarkdown(SAMPLE).markdown).toBe(SAMPLE)
    const empty = parseRecapMarkdown('not even markdown')
    expect(empty.overview).toBe('')
    expect(empty.decisions).toEqual([])
    expect(empty.markdown).toBe('not even markdown')
  })

  describe('recapMarkdownToHtml', () => {
    it('converts headings and bullets to structured HTML, escaping unsafe characters', () => {
      const html = recapMarkdownToHtml(SAMPLE, 'Q3 Planning <sync>')
      expect(html).toContain('<h1>Q3 Planning &lt;sync&gt;</h1>')
      expect(html).toContain('<h2>Overview:</h2>')
      expect(html).toContain('<p>We aligned on the Q3 launch and the budget.</p>')
      expect(html).toContain('<li>Launch timeline</li>')
      expect(html).toContain('<li>Book the venue — Bob</li>')
      expect(html).not.toContain('<script')
    })

    it('closes every opened <ul> and never throws on junk input', () => {
      const html = recapMarkdownToHtml('## Action items:\n- one\n- two\n\nplain line')
      expect(html.match(/<ul>/g)?.length).toBe(1)
      expect(html.match(/<\/ul>/g)?.length).toBe(1)
      expect(() => recapMarkdownToHtml('')).not.toThrow()
      expect(recapMarkdownToHtml('')).toContain('<body>')
    })
  })

  // Real model output drifts from the prompt's exact format — headings sometimes drop the colon, action
  // items arrive as checkboxes, owners use a dash. The parser must tolerate these without losing data.
  it('tolerates real-output drift: no-colon headings, checkbox bullets, dash + paren owners', () => {
    const real = [
      '## Overview',
      'The team reviewed launch readiness and resolved the pricing question.',
      '',
      '## Decisions',
      '- [ ] Ship the beta to the design partners on Monday',
      '* Lock pricing at $49/mo',
      '',
      '## Action items',
      '- [ ] Draft the partner email — Priya',
      '- Update the pricing page (Marco)',
      '- Schedule the retro',
      '',
      '## Open questions',
      '- Do we need legal sign-off on the new terms?'
    ].join('\n')
    const r = parseRecapMarkdown(real)
    expect(r.overview).toBe('The team reviewed launch readiness and resolved the pricing question.')
    expect(r.decisions).toEqual([
      'Ship the beta to the design partners on Monday',
      'Lock pricing at $49/mo'
    ])
    expect(r.actionItems).toEqual([
      { text: 'Draft the partner email', owner: 'Priya', dueDateText: null },
      { text: 'Update the pricing page', owner: 'Marco', dueDateText: null },
      { text: 'Schedule the retro', owner: null, dueDateText: null }
    ])
    expect(r.openQuestions).toEqual(['Do we need legal sign-off on the new terms?'])
  })
})

describe('writeSaved', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-writesaved-test-'))
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('retries a rename that fails once with EPERM (e.g. OneDrive/AV holding the file open)', async () => {
    const target = join(folder, 'note.md')
    let calls = 0
    vi.mocked(renameAsync).mockImplementationOnce(async () => {
      calls++
      const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    })

    await writeSaved(target, 'hello world', false)

    expect(calls).toBe(1) // first rename failed transiently, retry (the default real impl) succeeded
    expect(readFileSync(target, 'utf8')).toBe('hello world')
  })

  it('does not retry and rethrows on a non-transient error', async () => {
    const target = join(folder, 'note.md')
    vi.mocked(renameAsync).mockImplementation(async () => {
      const err = new Error('ENOENT: no such file or directory, rename') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })

    await expect(writeSaved(target, 'hello world', false)).rejects.toThrow('ENOENT')
  })
})

// T7 7a/7b: old meetings encrypted before commit 486227d forced the local keystore wrapped their
// content key directly with safeStorage ('S:'). The forced keystore then made decryptEnvelopeV2 refuse
// those envelopes on every read, even though this device's own Keychain item can still unwrap them.
describe('old-meeting Keychain recovery (T7): allowKeychainRecovery + self-healing rewrap', () => {
  let folder: string
  let tempDir: string
  let settings: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recovery-test-'))
    tempDir = mkdtempSync(join(tmpdir(), 'asktoto-recovery-temp-'))
    settings = { ...baseSettings(), meetingsFolder: folder }
    // The 'writeSaved' suite above leaves a permanent ENOENT mockImplementation on the shared
    // node:fs/promises.rename mock (vi.restoreAllMocks() doesn't undo .mockImplementation() on a
    // factory-vended vi.fn() — only on a real vi.spyOn) — re-establish the real-rename default so
    // saveMeeting below isn't sabotaged by a prior test's leftover override.
    vi.mocked(renameAsync).mockImplementation(async (src: string, dest: string) => renameSync(src, dest))
    // decryptToTemp writes its plaintext copy under app.getPath('temp') — route that to a real,
    // per-test directory instead of the shared default mock path, which nothing here creates on disk.
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'temp') return tempDir
      if (name === 'userData') return '/tmp/asktoto-test-userdata'
      if (name === 'documents') return '/tmp/asktoto-test-documents'
      return `/tmp/asktoto-${name}`
    })
  })

  afterEach(() => {
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    rmSync(folder, { recursive: true, force: true })
    rmSync(tempDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // Writes a v2 envelope the way a packaged build wrapped it BEFORE 486227d forced the local keystore —
  // kLocal 'S:' (safeStorage-direct), no forced-keystore env yet. This is the exact on-disk shape of a
  // real pre-486227d meeting sitting on a user's disk today.
  const writeOldKeychainMeeting = async (): Promise<string> => {
    ;(app as unknown as { isPackaged: boolean }).isPackaged = true
    const enc = { ...settings, encryptTranscripts: true } as Settings
    const file = await saveMeeting(enc, {
      title: 'Pre-486227d board meeting',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [{ speaker: 'them', text: 'OLD-KEYCHAIN-SECRET', t: 1_700_000_000_000 }],
      recap: ''
    })
    ;(app as unknown as { isPackaged: boolean }).isPackaged = false
    expect((parseEnvelope(file).kLocal as string).startsWith('S:')).toBe(true) // sanity: real 'S:' envelope
    return file
  }

  it('recovery flag off: an old "S:" meeting still fails to decrypt while the local keystore is forced (unchanged bulk-read behavior)', async () => {
    const file = await writeOldKeychainMeeting()
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
    // readSavedFile -> decodeSaved never sets allowKeychainRecovery — the bulk list/search path stays
    // exactly as fail-closed as it is today; 486227d's boot-prompt fix is untouched.
    expect(readSavedFile(file)).toBe('')
  })

  it('recovery flag on + safeStorage available: the explicit single-file Open path recovers the same meeting', async () => {
    const file = await writeOldKeychainMeeting()
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
    const tmp = decryptToTemp(file) // the only caller that opts into allowKeychainRecovery
    expect(readFileSync(tmp, 'utf8')).toContain('OLD-KEYCHAIN-SECRET')
  })

  it('a successful recovery rewraps kLocal to "F:" in place, leaving iv/tag/ct byte-identical', async () => {
    const file = await writeOldKeychainMeeting()
    const before = parseEnvelope(file)
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
    decryptToTemp(file)
    const after = parseEnvelope(file)
    expect((before.kLocal as string).startsWith('S:')).toBe(true)
    expect((after.kLocal as string).startsWith('F:')).toBe(true)
    expect(after.iv).toBe(before.iv)
    expect(after.tag).toBe(before.tag)
    expect(after.ct).toBe(before.ct)
    // Converged: a later BULK read (allowKeychainRecovery=false) now succeeds without touching the Keychain.
    expect(readSavedFile(file)).toContain('OLD-KEYCHAIN-SECRET')
  })
})

// T7 7c: the pre-rebrand "AskToto Meetings" folder sits next to wherever the resolved folder lives
// today, and is never scanned by the normal Recall/list paths — copyForwardLegacyMeetingsOnce pulls its
// files in exactly once, additively, without ever touching the original.
describe('copy-forward: pre-rebrand "AskToto Meetings" sibling folder (T7 7c)', () => {
  let base: string
  let userDataDir: string
  let folder: string
  let legacy: string
  let settings: Settings

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'asktoto-copyfwd-base-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'asktoto-copyfwd-userdata-'))
    folder = join(base, 'Métis Meetings')
    legacy = join(base, 'AskToto Meetings')
    mkdirSync(legacy, { recursive: true })
    settings = { ...baseSettings(), meetingsFolder: folder }
    // Route the run-once marker to a per-test userData dir so this suite's marker can never leak into
    // (or be polluted by) any other test's use of the default mocked userData path.
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userDataDir : `/tmp/asktoto-${name}`
    )
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('copies only files missing at the destination, never overwrites, and never touches the legacy source', () => {
    writeFileSync(join(legacy, 'kept-meeting.md'), 'LEGACY-CONTENT-A')
    writeFileSync(join(legacy, 'already-there.md'), 'LEGACY-CONTENT-B')
    writeFileSync(join(legacy, 'README.md'), 'legacy readme — bookkeeping, never copied')
    writeFileSync(join(legacy, 'index.md'), 'legacy index — bookkeeping, never copied')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'already-there.md'), 'CURRENT-CONTENT') // pre-existing at the destination

    expect(resolveMeetingsFolder(settings)).toBe(folder)

    expect(readFileSync(join(folder, 'kept-meeting.md'), 'utf8')).toBe('LEGACY-CONTENT-A') // copied in
    expect(readFileSync(join(folder, 'already-there.md'), 'utf8')).toBe('CURRENT-CONTENT') // NOT overwritten
    expect(existsSync(join(folder, 'README.md'))).toBe(false) // bookkeeping files never copied
    expect(existsSync(join(folder, 'index.md'))).toBe(false)
    // Source untouched — copy-forward never deletes or modifies the original.
    expect(readdirSync(legacy).sort()).toEqual(
      ['README.md', 'already-there.md', 'index.md', 'kept-meeting.md'].sort()
    )
    expect(readFileSync(join(legacy, 'kept-meeting.md'), 'utf8')).toBe('LEGACY-CONTENT-A')
  })

  it('runs only once: a file added to the legacy folder after the run-once marker is written is never pulled in', () => {
    writeFileSync(join(legacy, 'first.md'), 'FIRST')
    resolveMeetingsFolder(settings) // first call: copies first.md, writes the marker
    expect(readFileSync(join(folder, 'first.md'), 'utf8')).toBe('FIRST')

    writeFileSync(join(legacy, 'second.md'), 'SECOND')
    resolveMeetingsFolder(settings) // marker already present — must be a no-op
    expect(existsSync(join(folder, 'second.md'))).toBe(false)
  })
})

// MQA-111 (docs/qa/BUG-LEDGER.md): duration must be the transcript's own SPAN (last line minus first),
// correct whether line.t is a 0-based offset (imports) or a wall-clock timestamp (the live renderer).
// The old last-minus-startedAt formula turned an offset t into a huge negative that clamped to 1 minute,
// corrupting conversationMinutes and the time-saved total for every import.
describe('meetingDurationMin — span is correct under both timestamp conventions (MQA-111)', () => {
  it('offset-based t (0-based, the import convention) gives the real span, not 1', () => {
    const startedAt = Date.now()
    const m = { startedAt, lines: [{ t: 0 }, { t: 30_000 }, { t: 25 * 60_000 }] } // 25-minute span
    expect(meetingDurationMin(m)).toBe(25)
  })

  it('wall-clock t (the live-renderer convention) still gives the real elapsed span', () => {
    const start = 1_700_000_000_000
    const m = { startedAt: start, lines: [{ t: start }, { t: start + 12 * 60_000 }] } // 12 minutes
    expect(meetingDurationMin(m)).toBe(12)
  })

  it('a single-line meeting is a zero span, floored to 1; an empty meeting is 0', () => {
    expect(meetingDurationMin({ startedAt: 1, lines: [{ t: 5_000 }] })).toBe(1)
    expect(meetingDurationMin({ startedAt: 1, lines: [] })).toBe(0)
  })
})
