import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { app } from 'electron'
import type { SaveMeeting, Settings, TranscriptLine } from '@shared/ipc'
import { SaveMeetingSchema } from '@shared/ipc'
import {
  configureMeetingSpeechLimits,
  configureMeetingSpeechPersistence,
  getMeetingSpeechLimits,
  renderMeetingTranscriptAsync,
  decodeStoredMeetingSpeechAsync
} from './features/meetings/meeting-speech'
import {
  createMeetingSpeechPersistenceService,
  type MeetingSpeechServiceBounds,
  type MeetingSpeechWorkerPort
} from './infra/process/meeting-speech-host'
import type { MeetingSpeechRequest } from './infra/process/meeting-speech-protocol'
import { processMeetingSpeechRequest } from './meeting-speech-worker'
import { decodeSavedMeetingAsync, saveMeeting, saveDraftTranscript } from './transcripts'
import { recallRead } from './recall'
import { readSavedMeeting } from './history-actions'
import { useStorageForTests } from './infra/storage/meetings-storage'

vi.mock('electron')
let settings: Settings
vi.mock('./store', () => ({ getSettings: () => settings }))

/** A declared synthetic workload, not a duration-derived bound or live speech acceptance. */
const manifest = Object.freeze({
  durationMs: 14_400_000,
  tracks: 2,
  segmentDurationMs: 5_000,
  wordsPerSegment: 12,
  records: 5_760,
  words: 69_120,
  textBytes: 443_520
})
const startedAt = Date.parse('2026-10-14T04:00:00.000Z')
const testBudget = Object.freeze({
  maxRecords: 6_000,
  maxWords: 70_000,
  maxFieldBytes: 10_000,
  maxRecordBytes: 20_000,
  maxPayloadBytes: 128 * 1024 * 1024
})
const measurements: Record<string, unknown>[] = []
let service: ReturnType<typeof createMeetingSpeechPersistenceService> | undefined

const testServiceBounds: MeetingSpeechServiceBounds = {
  maxInputBytes: 128 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
  operationDeadlineMs: 60_000,
  shutdownDeadlineMs: 5_000
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

function workload(): SaveMeeting {
  const lines: TranscriptLine[] = []
  for (let index = 0; index < manifest.durationMs / manifest.segmentDurationMs; index++) {
    for (const track of ['system', 'microphone'] as const) {
      const startMs = index * manifest.segmentDurationMs
      const words = Array.from({ length: manifest.wordsPerSegment }, (_, word) => ({
        text: word % 2 === 0 ? 'bonjour' : 'team',
        language: word % 2 === 0 ? 'fr' : 'en',
        startMs: startMs + Math.floor((word * manifest.segmentDurationMs) / manifest.wordsPerSegment),
        endMs: startMs + Math.floor(((word + 1) * manifest.segmentDurationMs) / manifest.wordsPerSegment)
      }))
      const text = words.map((word) => word.text).join(' ')
      lines.push({
        speaker: track === 'system' ? 'them' : 'you',
        text,
        t: startedAt + startMs + 125,
        lang: 'French',
        speech: {
          type: 'segment',
          captureId: '11111111-1111-4111-8111-111111111111',
          captureGeneration: 2,
          sequence: index * 6 + (track === 'system' ? 9 : 12),
          segment: {
            stream: { generation: 2, track, epoch: 1 },
            engine: 'deepgram-nova3',
            index: index + 1,
            revision: 1,
            final: true,
            text,
            startMs,
            endMs: startMs + manifest.segmentDurationMs
          },
          languages: ['fr', 'en'],
          words
        }
      })
    }
  }
  return {
    title: 'Synthetic declared four hour workload',
    mode: 'general',
    startedAt,
    durationMs: manifest.durationMs,
    lines,
    recap: ''
  }
}

afterEach(async () => {
  configureMeetingSpeechPersistence(undefined)
  await service?.dispose()
  service = undefined
  useStorageForTests()
  configureMeetingSpeechLimits(undefined)
})

describe('inline speech worker fixture protocol', () => {
  it('processes a posted request asynchronously and emits exactly one reply', async () => {
    const worker = new InlineSpeechWorker()
    const onMessage = vi.fn()
    worker.on('message', onMessage)
    worker.postMessage({
      protocol: 1,
      id: 17,
      generation: 3,
      operation: 'render',
      policy: { limits: testBudget, ...testServiceBounds },
      input: [{ speaker: 'you', text: 'Synthetic protocol fixture', t: startedAt }]
    })
    expect(onMessage).not.toHaveBeenCalled()
    await yieldImmediate()
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith({
      protocol: 1,
      id: 17,
      generation: 3,
      result: { ok: true, value: expect.stringContaining('You:** Synthetic protocol fixture') }
    })
    await yieldImmediate()
    expect(onMessage).toHaveBeenCalledTimes(1)
  })
})

describe('actual declared speech persistence resource measurements', () => {
  it.each([false, true])('measures actual save/encryption/read without truncation, encrypted=%s', async (encrypted) => {
    const folder = mkdtempSync(join(tmpdir(), 'metis-speech-resource-'))
    const delay = monitorEventLoopDelay({ resolution: 10 })
    delay.enable()
    try {
      vi.mocked(app.getPath).mockReturnValue(folder)
      settings = { meetingsFolder: folder, encryptTranscripts: encrypted } as Settings
      useStorageForTests()
      configureMeetingSpeechLimits(testBudget)
      const timings: Record<string, number[]> = Object.create(null) as Record<string, number[]>
      service = createMeetingSpeechPersistenceService({
        readLimits: getMeetingSpeechLimits,
        readBounds: () => testServiceBounds,
        onTiming: ({ name, durationMs }) => {
          const values = timings[name] ?? []
          values.push(durationMs)
          timings[name] = values
        },
        ...(process.env.METIS_SPEECH_ACTUAL_WORKER === '1'
          ? { entryPath: join(process.cwd(), 'out/main/meeting-speech-worker.js') }
          : { workerFactory: () => new InlineSpeechWorker() })
      })
      configureMeetingSpeechPersistence(service)
      await yieldImmediate()
      const before = process.memoryUsage()
      const fixtureStart = performance.now()
      const input = SaveMeetingSchema.parse(workload())
      const fixtureMs = performance.now() - fixtureStart
      expect(input.lines).toHaveLength(manifest.records)
      expect(input.lines.reduce((count, line) => count + (line.speech?.words?.length ?? 0), 0)).toBe(manifest.words)
      const textBytes = input.lines.reduce((count, line) => count + Buffer.byteLength(line.text), 0)
      expect(textBytes).toBe(manifest.textBytes)
      const codecStart = performance.now()
      const encoded = await renderMeetingTranscriptAsync(input.lines)
      const codecMs = performance.now() - codecStart
      const saveStart = performance.now()
      const file = await saveMeeting(settings, input)
      const saveMs = performance.now() - saveStart
      const raw = await readFile(file)
      const decryptStart = performance.now()
      const decodedDocument = await decodeSavedMeetingAsync(raw, false, file)
      expect(decodedDocument.ok).toBe(true)
      const internalDocument = decodedDocument.ok ? decodedDocument.text : ''
      const publicReopen = await readSavedMeeting(folder, basename(file))
      expect(publicReopen).toContain('## Full transcript')
      const decryptReadMs = performance.now() - decryptStart
      const recallStart = performance.now()
      const recalled = await recallRead(basename(file))
      const recallMs = performance.now() - recallStart
      expect(recalled.ok).toBe(true)
      expect(recalled.lines).toEqual(input.lines)
      expect(recalled.speechProvenance).toBe('valid')
      const draftStart = performance.now()
      await saveDraftTranscript(settings, input)
      const draftSaveMs = performance.now() - draftStart
      const draftNames = readdirSync(folder).filter((name) =>
        /^\.autosave-draft-\d{4}-\d{2}-\d{2}_\d{6}-\d{3}\.md$/.test(name)
      )
      expect(draftNames).toHaveLength(1)
      const draftFile = join(folder, draftNames[0])
      const draftRaw = await readFile(draftFile)
      const draftReadStart = performance.now()
      const decodedDraft = await decodeSavedMeetingAsync(draftRaw, false, draftFile)
      expect(decodedDraft.ok).toBe(true)
      const draftDocument = decodedDraft.ok ? decodedDraft.text : ''
      const draftReadMs = performance.now() - draftReadStart
      const draftDecodeStart = performance.now()
      const draftDecoded = await decodeStoredMeetingSpeechAsync(draftDocument)
      const draftDecodeMs = performance.now() - draftDecodeStart
      expect(draftDecoded.ok && draftDecoded.status).toBe('valid')
      if (draftDecoded.ok && draftDecoded.status === 'valid') expect(draftDecoded.lines).toEqual(input.lines)
      await yieldImmediate()
      const after = process.memoryUsage()
      const metrics = {
        host: process.platform,
        encrypted,
        manifest,
        textBytes,
        memoryScope:
          process.env.METIS_SPEECH_ACTUAL_WORKER === '1'
            ? 'worker-thread-shared-process'
            : 'inline-test-driver-cumulative',
        privatePayloadBytes: Buffer.byteLength(
          encoded.split('<!-- metis-speech-provenance:v1 -->\n')[1].split('\n<!-- /metis-speech-provenance -->')[0]
        ),
        encodedTranscriptBytes: Buffer.byteLength(encoded),
        documentBytes: Buffer.byteLength(internalDocument),
        storedBytes: raw.length,
        fixtureMs,
        codecMs,
        saveMs,
        decryptReadMs,
        recallMs,
        draftSaveMs,
        draftReadMs,
        draftDecodeMs,
        draftDocumentBytes: Buffer.byteLength(draftDocument),
        draftStoredBytes: draftRaw.length,
        rssBefore: before.rss,
        rssAfter: after.rss,
        heapBefore: before.heapUsed,
        heapAfter: after.heapUsed,
        processMaxRssNativeUnits: process.resourceUsage().maxRSS,
        mainAdmissionPreflightMs: (timings['admission-preflight'] ?? []).reduce((sum, value) => sum + value, 0),
        inputSnapshotMs: (timings['input-snapshot'] ?? []).reduce((sum, value) => sum + value, 0),
        queueWaitMs: (timings['queue-wait'] ?? []).reduce((sum, value) => sum + value, 0),
        workerRoundTripMs: (timings['worker-round-trip'] ?? []).reduce((sum, value) => sum + value, 0),
        workerExecutionMs: (timings['worker-execution'] ?? []).reduce((sum, value) => sum + value, 0),
        mockNativeKeyWrapMs: (timings['mock-native-key-wrap'] ?? []).reduce((sum, value) => sum + value, 0),
        nativeKeyWrapBackend: 'vitest-mocked-electron-safeStorage',
        roundTripOverheadMs: Math.max(
          0,
          (timings['worker-round-trip'] ?? []).reduce((sum, value) => sum + value, 0) -
            (timings['worker-execution'] ?? []).reduce((sum, value) => sum + value, 0)
        ),
        eventLoopMaxMs: delay.max / 1e6,
        eventLoopP99Ms: delay.percentile(99) / 1e6
      }
      expect(
        Object.values(metrics)
          .filter((value) => typeof value === 'number')
          .every((value) => Number.isFinite(value) && value >= 0)
      ).toBe(true)
      measurements.push(metrics)
      const report = process.env.METIS_SPEECH_RESOURCE_REPORT
      if (report)
        writeFileSync(report, JSON.stringify({ schema: 2, workloadOnly: true, measurements }) + '\n', { mode: 0o600 })
      console.log('Declared speech workload measurements', JSON.stringify(metrics))
    } finally {
      delay.disable()
      await rm(folder, { recursive: true, force: true })
    }
  })
})
