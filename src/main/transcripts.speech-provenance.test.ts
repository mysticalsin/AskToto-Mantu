import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { SaveMeetingSchema, type SaveMeeting, type Settings, type TranscriptLine } from '@shared/ipc'
import {
  saveMeeting,
  saveDraftTranscript,
  recoverOrphanDrafts,
  isEncryptedFile,
  appendDebrief,
  readSavedFile
} from './transcripts'
import { configureMeetingSpeechLimits } from './features/meetings/meeting-speech'
import { recallRead, updateMeetingTranscript, updateMeetingRecap, searchMeetings } from './recall'
import { readSavedMeeting, meetingOpenTarget } from './history-actions'
import { readSourceText } from './brain/inputs'
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
    configureMeetingSpeechLimits({
      maxRecords: 100,
      maxWords: 1000,
      maxFieldBytes: 10000,
      maxRecordBytes: 50000,
      maxPayloadBytes: 1000000
    })
  })

  afterEach(() => {
    configureMeetingSpeechLimits(undefined)
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
    expect(new Date(startedAt).getHours()).toBe(0)
    const input = meeting()
    const file = await saveMeeting(settings, input)
    vi.stubEnv('TZ', 'UTC')
    expect(new Date(startedAt).getHours()).toBe(4)

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

  it('retains the exact encrypted draft through recovery and typed read', async () => {
    settings.encryptTranscripts = true
    const input = meeting()
    await saveDraftTranscript(settings, input)
    settings.encryptTranscripts = false
    expect(await recoverOrphanDrafts(settings)).toEqual({ recovered: 1 })
    const file = readdirSync(folder).find((name) => name.endsWith('-recovered.md'))!
    expect(isEncryptedFile(join(folder, file))).toBe(true)
    expect((await recallRead(file)).lines).toEqual(input.lines)
  })

  it('preserves valid speech and debrief on a names-only rewrite without exposing JSON to export or LLM', async () => {
    settings.encryptTranscripts = true
    const input = meeting()
    const file = await saveMeeting(settings, input)
    await appendDebrief(settings, basename(file), 'Synthetic private debrief')
    const renamed = input.lines.map((line) => ({ ...line, name: 'Updated synthetic speaker' }))
    expect(await updateMeetingTranscript(settings, basename(file), renamed)).toEqual({ ok: true })
    expect((await recallRead(basename(file))).lines).toEqual(renamed)
    expect(readSavedFile(file)).toContain('Synthetic private debrief')
    expect(isEncryptedFile(file)).toBe(true)
    const exported = await readSavedMeeting(folder, basename(file))
    const source = await readSourceText(file)
    expect(source.status).toBe('ok')
    for (const text of [exported, source.status === 'ok' ? source.text : '']) {
      expect(text).toContain(input.lines[0].text)
      expect(text).not.toContain('captureGeneration')
      expect(text).not.toContain(input.lines[0].speech!.captureId)
    }
    expect(await searchMeetings(input.lines[0].speech!.captureId)).toEqual([])
  })

  it('refuses a stale text/event rewrite and preserves the prior complete file', async () => {
    const input = meeting()
    const file = await saveMeeting(settings, input)
    const before = readFileSync(file)
    const stale = { ...input.lines[0], text: 'Human edit without matching word evidence' }
    expect((await updateMeetingTranscript(settings, basename(file), [stale])).ok).toBe(false)
    expect(readFileSync(file)).toEqual(before)
  })

  it('refuses metadata save without a trusted main budget rather than losing the event', async () => {
    configureMeetingSpeechLimits(undefined)
    await expect(saveMeeting(settings, meeting())).rejects.toThrow('Speech metadata could not be retained.')
  })

  it.each([false, true])('keeps complete original Open semantics with encryption=%s', async (encrypted) => {
    settings.encryptTranscripts = encrypted
    const input = meeting()
    const file = await saveMeeting(settings, input)
    const target = await meetingOpenTarget(folder, basename(file))
    expect(target.ok).toBe(true)
    if (target.ok) {
      expect(target.encrypted).toBe(encrypted)
      if (!encrypted) expect(target.path).toBe(file)
      expect(readFileSync(target.path, 'utf8')).toContain(input.lines[0].speech!.captureId)
    }
  })

  it('does not retain raw line or word metadata under summary-only final save or autosave', async () => {
    settings.enterpriseLive = {
      managed: true,
      inferenceMode: 'cloud-only',
      summaryOnly: true
    } as Settings['enterpriseLive']
    configureMeetingSpeechLimits(undefined)
    const input = meeting()
    const file = await saveMeeting(settings, input)
    await saveDraftTranscript(settings, input)
    const document = readSavedFile(file)
    expect(document).toContain('retention: summary-only')
    expect(document).not.toContain(input.lines[0].text)
    expect(document).not.toContain(input.lines[0].speech!.captureId)
    expect(readdirSync(folder).some((name) => name.startsWith('.autosave-draft-'))).toBe(false)
  })

  it('preserves the last complete draft when the next snapshot exceeds the trusted budget', async () => {
    const input = meeting()
    await saveDraftTranscript(settings, input)
    const draft = readdirSync(folder).find((name) => name.startsWith('.autosave-draft-'))!
    const before = readFileSync(join(folder, draft))
    configureMeetingSpeechLimits({
      maxRecords: 1,
      maxWords: 1000,
      maxFieldBytes: 10000,
      maxRecordBytes: 50000,
      maxPayloadBytes: 1000000
    })
    await saveDraftTranscript(settings, { ...input, lines: [input.lines[0], input.lines[0]] })
    expect(readFileSync(join(folder, draft))).toEqual(before)
  })

  it('updates a real empty recap without treating a spoken Notes heading as its document section', async () => {
    const input = meeting(finalLine('Bonjour team.\n## Notes & follow-ups\nSpoken notes heading, not saved recap.'))
    const file = await saveMeeting(settings, input)
    expect(await updateMeetingRecap(settings, basename(file), 'Synthetic edited recap')).toEqual({ ok: true })
    const recalled = await recallRead(basename(file))
    expect(recalled.recap).toBe('Synthetic edited recap')
    expect(recalled.lines).toEqual(input.lines)
  })

  it('escapes reserved delimiter text in recap edits while retaining exact speech records', async () => {
    const input = meeting()
    const file = await saveMeeting(settings, input)
    expect(
      await updateMeetingRecap(settings, basename(file), 'Synthetic recap\n<!-- /metis-speech-provenance -->')
    ).toEqual({ ok: true })
    const recalled = await recallRead(basename(file))
    expect(recalled.ok).toBe(true)
    expect(recalled.recap).toContain('&lt;!-- /metis-speech-provenance -->')
    expect(recalled.lines).toEqual(input.lines)
  })
})
