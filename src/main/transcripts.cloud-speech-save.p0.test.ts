import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { SaveMeetingSchema, stripProvisionalLines, type Settings, type SaveMeeting } from '@shared/ipc'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import { cloudSpeechTranscriptSegment } from '../renderer/src/lib/cloud-speech-listen'
import { saveMeeting, saveDraftTranscript } from './transcripts'
import { recallRead } from './recall'
import { configureMeetingSpeechLimits, configureMeetingSpeechPersistence } from './features/meetings/meeting-speech'
import { useStorageForTests } from './infra/storage/meetings-storage'

vi.mock('electron')
let settings: Settings
vi.mock('./store', () => ({ getSettings: () => settings }))

const startedAt = Date.parse('2026-10-14T04:00:00.000Z')
const SYNTHETIC_TEXT = 'Synthetic broker final line.'

// A broker-v1 final segment event, the exact shape the renderer receives from the cloud speech bridge.
function brokerFinalEvent(text = SYNTHETIC_TEXT): Extract<CloudSpeechEvent, { type: 'segment' }> {
  return {
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
    languages: ['en'],
    words: [
      { text: 'Synthetic', startMs: 0, endMs: 500, language: 'en', speaker: 1 },
      { text: 'broker', punctuatedWord: 'broker', startMs: 500, endMs: 1000, language: 'en', speaker: 1 }
    ]
  }
}

/** Mirrors listen.ts applyEvent -> commitLine for a cloud final: the line carries `speech: event`. */
function rendererCommittedMeeting(): SaveMeeting {
  const segment = cloudSpeechTranscriptSegment(brokerFinalEvent())
  if (!segment) throw new Error('fixture must be a final segment')
  return SaveMeetingSchema.parse({
    title: 'Synthetic cloud speech meeting',
    mode: 'general',
    startedAt,
    lines: [
      {
        speaker: segment.speaker,
        text: segment.text,
        t: startedAt + 125,
        lang: 'English',
        speech: segment.speech
      }
    ],
    recap: ''
  })
}

describe('P0: cloud-speech meeting save in default production configuration', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'metis-cloud-speech-p0-'))
    vi.mocked(app.getPath).mockReturnValue(folder)
    settings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
    useStorageForTests()
    // Production default: no main code installs a speech budget or persistence service.
    configureMeetingSpeechLimits(undefined)
    configureMeetingSpeechPersistence(undefined)
  })

  afterEach(() => {
    configureMeetingSpeechLimits(undefined)
    configureMeetingSpeechPersistence(undefined)
    useStorageForTests()
    rmSync(folder, { recursive: true, force: true })
  })

  it('keeps the speech event on the line through the IPC schema and the provisional strip', () => {
    const meeting = rendererCommittedMeeting()
    const stripped = stripProvisionalLines(meeting.lines)
    expect(stripped[0]?.speech).toBeDefined()
  })

  it('saves a broker-v1 final line and reads the text back', async () => {
    const meeting = rendererCommittedMeeting()
    meeting.lines = stripProvisionalLines(meeting.lines) // exactly what the saveTranscript IPC handler does

    const file = await saveMeeting(settings, meeting)

    const read = await recallRead(basename(file))
    expect(read.ok).toBe(true)
    expect(read.lines?.[0]?.text).toBe(SYNTHETIC_TEXT)
  })

  it('autosaves a broker-v1 final line as a draft', async () => {
    const meeting = rendererCommittedMeeting()
    meeting.lines = stripProvisionalLines(meeting.lines) // exactly what the saveDraftTranscript IPC handler does

    const result = await saveDraftTranscript(settings, meeting)

    expect(result).toEqual({ status: 'saved' })
    expect(readdirSync(folder).some((name) => name.startsWith('.autosave-draft-'))).toBe(true)
  })
})
