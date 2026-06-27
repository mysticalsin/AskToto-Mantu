import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { safeStorage } from 'electron'
import { saveMeeting, readSavedFile, isEncryptedFile } from './transcripts'
import type { SaveMeeting, Settings } from '@shared/ipc'

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
    folder = mkdtempSync(join(tmpdir(), 'asktoto-transcripts-test-'))
    settings = { ...baseSettings(), meetingsFolder: folder }
  })

  afterEach(() => {
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
