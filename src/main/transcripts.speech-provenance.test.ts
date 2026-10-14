import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { SaveMeetingSchema, type SaveMeeting, type Settings, type TranscriptLine } from '@shared/ipc'
import { saveMeeting, isEncryptedFile } from './transcripts'
import { recallRead } from './recall'
import { useStorageForTests } from './infra/storage/meetings-storage'

vi.mock('electron')
let settings: Settings
vi.mock('./store', () => ({ getSettings: () => settings }))

const startedAt = Date.parse('2026-10-14T04:00:00.000Z')

function finalLine(text = 'Bonjour team.'): TranscriptLine {
  return {
    speaker: 'them',
    text,
    t: startedAt + 125,
    name: 'Synthetic speaker',
    lang: 'French',
    speech: {
      type: 'segment',
      captureId: '11111111-1111-4111-8111-111111111111',
      captureGeneration: 2,
      sequence: 9,
      segment: {
        stream: { generation: 2, track: 'system', epoch: 3 },
        engine: 'deepgram-nova3',
        index: 4,
        revision: 2,
        final: true,
        text,
        startMs: 0,
        endMs: 1000
      },
      languages: ['fr', 'en'],
      words: [
        { text: 'Bonjour', startMs: 0, endMs: 500, language: 'fr', speaker: 1 },
        { text: 'team', punctuatedWord: 'team.', startMs: 500, endMs: 1000, language: 'en', speaker: 1 }
      ]
    }
  }
}

function meeting(line = finalLine()): SaveMeeting {
  return SaveMeetingSchema.parse({
    title: 'Synthetic retained speech',
    mode: 'general',
    startedAt,
    lines: [line],
    recap: ''
  })
}

describe('actual saved final speech provenance', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'metis-speech-provenance-'))
    vi.mocked(app.getPath).mockReturnValue(folder)
    settings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
    useStorageForTests()
  })

  afterEach(() => {
    useStorageForTests()
    vi.unstubAllEnvs()
    rmSync(folder, { recursive: true, force: true })
  })

  it.each([
    false,
    true
  ])('round-trips per-word languages and exact final identity with encryption=%s', async (encrypted) => {
    settings.encryptTranscripts = encrypted
    const input = meeting()
    const file = await saveMeeting(settings, input)
    expect(isEncryptedFile(file)).toBe(encrypted)
    if (encrypted) expect(readFileSync(file).includes(Buffer.from(input.lines[0].text))).toBe(false)

    const read = await recallRead(basename(file))

    expect(read.ok).toBe(true)
    expect(read.lines?.[0]?.speech).toEqual(input.lines[0].speech)
    expect(read.lines).toEqual(input.lines)
  })

  it('reopens exact saved timestamps and word metadata after a timezone change', async () => {
    vi.stubEnv('TZ', 'America/New_York')
    const input = meeting()
    const file = await saveMeeting(settings, input)
    vi.stubEnv('TZ', 'UTC')

    const read = await recallRead(basename(file))

    expect(read.ok).toBe(true)
    expect(read.lines).toEqual(input.lines)
  })

  it('retains multiline speech containing transcript and debrief headings as speech', async () => {
    const input = meeting(finalLine('Bonjour team.\n## Full transcript\nSynthetic heading inside speech.\n## Debrief'))
    const file = await saveMeeting(settings, input)

    const read = await recallRead(basename(file))

    expect(read.ok).toBe(true)
    expect(read.lines).toEqual(input.lines)
  })
})
