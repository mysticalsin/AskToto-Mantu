import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto'
import { safeStorage } from 'electron'
import {
  saveMeeting,
  readSavedFile,
  isEncryptedFile,
  parseRecapMarkdown,
  recapMarkdownToHtml,
  saveDraftTranscript,
  clearDraftTranscript,
  appendDebrief,
  DEBRIEF_HEADING
} from './transcripts'
import type { SaveMeeting, Settings } from '@shared/ipc'

const V2_MARKER = 'ATKENC2\n'
const parseEnvelope = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file).subarray(V2_MARKER.length).toString('utf8'))

vi.mock('electron')

const baseSettings = (): Settings =>
  ({
    meetingsFolder: '',
    autoSaveTranscripts: true
  } as Settings)

describe('transcripts', () => {
  let folder: string
  let settings: Settings

  beforeEach(() => {
    delete process.env.ASKTOTO_ESCROW_PUBKEY // isolate escrow tests from each other and the host env
    folder = mkdtempSync(join(tmpdir(), 'asktoto-transcripts-test-'))
    settings = { ...baseSettings(), meetingsFolder: folder }
  })

  afterEach(() => {
    delete process.env.ASKTOTO_ESCROW_PUBKEY
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
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

  it('still decrypts a legacy v1 (safeStorage-direct) file for backward compatibility', () => {
    const plain = '# Legacy transcript\n\nV1-SECRET-PAYLOAD\n'
    const v1 = Buffer.concat([Buffer.from('ATKENC1\n'), safeStorage.encryptString(plain)])
    const file = join(folder, 'legacy-v1.md')
    writeFileSync(file, v1)
    expect(isEncryptedFile(file)).toBe(true)
    expect(readSavedFile(file)).toBe(plain)
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

// Tony reported "if AskToto crashes mid-meeting the whole transcript is gone" — this exercises the
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

  it('clearDraftTranscript removes only that meeting\'s own draft', async () => {
    const other: SaveMeeting = { ...meeting, startedAt: 1_600_000_000_000 }
    await saveDraftTranscript(settings, meeting)
    await saveDraftTranscript(settings, other)
    clearDraftTranscript(settings, meeting.startedAt)
    const drafts = readdirSync(folder).filter((f) => f.startsWith('.autosave-draft-'))
    expect(drafts.length).toBe(1) // only `other`'s draft remains
  })

  it('never throws, even against an unwritable folder', async () => {
    await expect(
      saveDraftTranscript({ ...settings, meetingsFolder: '/nonexistent/\0bad' }, meeting)
    ).resolves.toBeUndefined()
    expect(() => clearDraftTranscript({ ...settings, meetingsFolder: '/nonexistent/\0bad' }, meeting.startedAt)).not.toThrow()
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
      { text: 'Send the deck', owner: 'Alice' },
      { text: 'Book the venue', owner: 'Bob' },
      { text: 'Finalize copy', owner: null }
    ])
  })

  it('degrades to owner:null on a nested-paren owner rather than mis-splitting', () => {
    const r = parseRecapMarkdown('## Action items:\n- Do the thing (Alice (boss))')
    expect(r.actionItems).toEqual([{ text: 'Do the thing (Alice (boss))', owner: null }])
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
      { text: 'Draft the partner email', owner: 'Priya' },
      { text: 'Update the pricing page', owner: 'Marco' },
      { text: 'Schedule the retro', owner: null }
    ])
    expect(r.openQuestions).toEqual(['Do we need legal sign-off on the new terms?'])
  })
})
