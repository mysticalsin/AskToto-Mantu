import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto'
import { safeStorage } from 'electron'
import { saveMeeting, readSavedFile, isEncryptedFile, parseRecapMarkdown } from './transcripts'
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
})

describe('parseRecapMarkdown', () => {
  const SAMPLE = [
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
    expect(r.overview).toBe('We aligned on the Q3 launch and the budget.')
    expect(r.topics).toEqual(['Launch timeline', 'Budget'])
    expect(r.decisions).toEqual(['Ship on Sept 1', 'Freeze scope Friday'])
    expect(r.openQuestions).toEqual(['Who owns PR?'])
    expect(r.notableQuotes).toEqual(['"Ship it."'])
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
})
