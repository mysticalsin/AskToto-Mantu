import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'
import { EventEmitter } from 'node:events'
import { SaveMeetingSchema, type SaveMeeting, type Settings, type TranscriptLine } from '@shared/ipc'
import {
  saveMeeting,
  saveDraftTranscript,
  recoverOrphanDrafts,
  isEncryptedFile,
  appendDebrief,
  readSavedFile,
  writeSaved
} from './transcripts'
import {
  configureMeetingSpeechLimits,
  configureMeetingSpeechPersistence,
  getMeetingSpeechLimits
} from './features/meetings/meeting-speech'
import {
  createMeetingSpeechPersistenceService,
  type MeetingSpeechWorkerPort,
  type MeetingSpeechServiceBounds
} from './infra/process/meeting-speech-host'
import type { MeetingSpeechRequest } from './infra/process/meeting-speech-protocol'
import { processMeetingSpeechRequest } from './meeting-speech-worker'
import {
  recallRead,
  updateMeetingTranscript,
  updateMeetingRecap,
  searchMeetings,
  renameMeeting,
  listMeetings
} from './recall'
import { readSavedMeeting, meetingOpenTarget } from './history-actions'
import { readSourceText } from './brain/inputs'
import { useStorageForTests } from './infra/storage/meetings-storage'

vi.mock('electron')
let settings: Settings
let service: ReturnType<typeof createMeetingSpeechPersistenceService> | undefined
vi.mock('./store', () => ({ getSettings: () => settings }))

const testServiceBounds: MeetingSpeechServiceBounds = {
  maxInputBytes: 1_000_000,
  maxOutputBytes: 1_000_000,
  operationDeadlineMs: 10_000,
  shutdownDeadlineMs: 2_000
}

class InlineSpeechWorker extends EventEmitter implements MeetingSpeechWorkerPort {
  postMessage(request: MeetingSpeechRequest): void {
    setImmediate(() => {
      const reply = processMeetingSpeechRequest(request)
      if (reply) this.emit('message', reply)
    })
  }
  async terminate(): Promise<number> {
    this.emit('exit', 1)
    return 1
  }
}

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
    service = createMeetingSpeechPersistenceService({
      readLimits: getMeetingSpeechLimits,
      readBounds: () => testServiceBounds,
      ...(process.env.METIS_SPEECH_ACTUAL_WORKER === '1'
        ? { entryPath: join(process.cwd(), 'out/main/meeting-speech-worker.js') }
        : { workerFactory: () => new InlineSpeechWorker() })
    })
    configureMeetingSpeechPersistence(service)
  })

  afterEach(async () => {
    configureMeetingSpeechPersistence(undefined)
    await service?.dispose()
    service = undefined
    useStorageForTests()
    configureMeetingSpeechLimits(undefined)
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

  it('wipes and refuses an encrypted speech envelope when native key wrapping fails before worker or file admission', async () => {
    const target = join(folder, 'wrap-refused.md')
    const refusal = new Error('native key wrapping refused')
    const packagedDescriptor = Object.getOwnPropertyDescriptor(app, 'isPackaged')
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    const encryptSpy = vi.spyOn(safeStorage, 'encryptString').mockImplementation(() => {
      throw refusal
    })
    const workerEncryptSpy = vi.spyOn(service!, 'encryptEnvelopeV2')
    const beforeReplace = vi.fn()
    try {
      await expect(writeSaved(target, '<!-- metis-speech-provenance:v1 -->', true, beforeReplace)).rejects.toBe(refusal)
      expect(workerEncryptSpy).not.toHaveBeenCalled()
      expect(beforeReplace).not.toHaveBeenCalled()
      expect(readdirSync(folder)).toEqual([])
    } finally {
      encryptSpy.mockRestore()
      workerEncryptSpy.mockRestore()
      if (packagedDescriptor) Object.defineProperty(app, 'isPackaged', packagedDescriptor)
      else Reflect.deleteProperty(app, 'isPackaged')
    }
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

  it('refuses reserved syntax in new titles and renames without corrupting an existing speech file', async () => {
    const input = meeting()
    const file = await saveMeeting(settings, input)
    const before = readFileSync(file)
    const title = 'Synthetic <!-- metis-speech-provenance:v1 --> title'
    await expect(saveMeeting(settings, { ...input, title })).rejects.toThrow(
      'Meeting text contains reserved storage syntax.'
    )
    expect((await renameMeeting(settings, basename(file), title)).ok).toBe(false)
    expect(readFileSync(file)).toEqual(before)
    await saveDraftTranscript(settings, input)
    const draft = readdirSync(folder).find((name) => name.startsWith('.autosave-draft-'))!
    const draftBefore = readFileSync(join(folder, draft))
    await saveDraftTranscript(settings, { ...input, title })
    expect(readFileSync(join(folder, draft))).toEqual(draftBefore)
  })

  it('retains original displayed clocks during names-only rewrite after a timezone change', async () => {
    vi.stubEnv('TZ', 'America/New_York')
    const input = meeting()
    const file = await saveMeeting(settings, input)
    expect(readSavedFile(file)).toContain('**[00:00:00]')
    vi.stubEnv('TZ', 'UTC')
    const renamed = input.lines.map((line) => ({ ...line, name: 'Updated name after timezone change' }))
    expect(await updateMeetingTranscript(settings, basename(file), renamed)).toEqual({ ok: true })
    expect(readSavedFile(file)).toContain('**[00:00:00]')
    expect(readSavedFile(file)).not.toContain('**[04:00:00]')
    expect((await recallRead(basename(file))).lines).toEqual(renamed)
  })

  it('keeps ambiguous private documents visible as unavailable without exposing their payload', async () => {
    const input = meeting()
    const file = await saveMeeting(settings, input)
    writeFileSync(file, readSavedFile(file) + '\n<!-- /metis-speech-provenance -->\n')
    const before = readFileSync(file)
    const rows = await listMeetings()
    expect(rows.some((row) => row.file === basename(file))).toBe(true)
    expect(rows.find((row) => row.file === basename(file))?.unavailable).toBe(true)
    expect((await recallRead(basename(file))).ok).toBe(false)
    await expect(readSavedMeeting(folder, basename(file))).rejects.toThrow(
      'Meeting text could not be projected safely.'
    )
    expect((await readSourceText(file)).status).toBe('unreadable')
    expect(await searchMeetings(input.lines[0].speech!.captureId)).toEqual([])
    expect(readFileSync(file)).toEqual(before)
  })

  it('retries a transient public projection refusal without caching an unavailable row', async () => {
    const file = await saveMeeting(settings, meeting())
    const before = readFileSync(file)
    const project = vi.spyOn(service!, 'project').mockRejectedValueOnce(new Error('transient worker refusal'))
    try {
      const first = (await listMeetings()).find((row) => row.file === basename(file))
      expect(first && 'unavailable' in first).toBe(true)

      const restored = (await listMeetings()).find((row) => row.file === basename(file))
      expect(restored?.title).toBe('Synthetic retained speech')
      expect(restored && 'unavailable' in restored).toBe(false)
      expect(readFileSync(file)).toEqual(before)
    } finally {
      project.mockRestore()
    }
  })
})
