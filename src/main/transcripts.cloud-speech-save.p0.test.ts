import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { SaveMeetingSchema, stripProvisionalLines, type Settings, type SaveMeeting } from '@shared/ipc'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import { isEncryptedFile, saveMeeting, saveDraftTranscript } from './transcripts'
import { recallRead } from './recall'
import { configureMeetingSpeechLimits, configureMeetingSpeechPersistence } from './features/meetings/meeting-speech'
import { installMeetingSpeechPolicy } from './features/meetings/meeting-speech-policy'
import { bootstrapMeetingSpeech } from './lifecycle/meeting-speech-persistence-wiring'
import type { MeetingSpeechWorkerPort } from './infra/process/meeting-speech-host'
import { EventEmitter } from 'node:events'
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
  // Same mapping as the renderer's cloudSpeechTranscriptSegment (system track -> 'them', speech: the event). It is
  // restated here because the node test project cannot type-check renderer modules.
  const event = brokerFinalEvent()
  const segment = { speaker: 'them' as const, text: event.segment.text, speech: event }
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
    // Production default configuration: main installs the trusted speech policy at boot (createOwnerSessionWiring)
    // and no persistence service is configured, so every codec runs inline.
    configureMeetingSpeechLimits(undefined)
    configureMeetingSpeechPersistence(undefined)
    installMeetingSpeechPolicy()
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

/** A worker that loads and then dies on its first request, the shape of an unproven bytecode/asar load failure. */
class CrashingWorker extends EventEmitter implements MeetingSpeechWorkerPort {
  postMessage(): void {
    setImmediate(() => this.emit('error', new Error('synthetic worker crash')))
  }
  async terminate(): Promise<number> {
    this.emit('exit', 1)
    return 1
  }
}

describe('P0: the production bootstrap keeps cloud-speech saves working whatever the worker does', () => {
  let folder: string
  let speech: ReturnType<typeof bootstrapMeetingSpeech> | undefined

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'metis-cloud-speech-p0-boot-'))
    vi.mocked(app.getPath).mockReturnValue(folder)
    settings = { meetingsFolder: folder, encryptTranscripts: true } as Settings
    useStorageForTests()
    configureMeetingSpeechLimits(undefined)
    configureMeetingSpeechPersistence(undefined)
  })

  afterEach(async () => {
    await speech?.dispose()
    speech = undefined
    configureMeetingSpeechLimits(undefined)
    configureMeetingSpeechPersistence(undefined)
    useStorageForTests()
    rmSync(folder, { recursive: true, force: true })
  })

  it.each([
    ['the worker switched off', false, () => new CrashingWorker()],
    ['a worker that crashes on every request', true, () => new CrashingWorker()]
  ])('saves, autosaves and reads back an encrypted broker-v1 meeting with %s', async (_name, enabled, workerFactory) => {
    speech = bootstrapMeetingSpeech({ readWorkerEnabled: () => enabled, audit: () => undefined, workerFactory })
    const meeting = rendererCommittedMeeting()
    meeting.lines = stripProvisionalLines(meeting.lines)

    const file = await saveMeeting(settings, meeting)
    expect(isEncryptedFile(file)).toBe(true)
    const read = await recallRead(basename(file))
    expect(read.ok).toBe(true)
    expect(read.lines?.[0]?.text).toBe(SYNTHETIC_TEXT)
    expect(await saveDraftTranscript(settings, meeting)).toEqual({ status: 'saved' })
  })
})
