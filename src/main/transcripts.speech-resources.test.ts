import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { app } from 'electron'
import type { SaveMeeting, Settings, TranscriptLine } from '@shared/ipc'
import { SaveMeetingSchema } from '@shared/ipc'
import { configureMeetingSpeechLimits } from './features/meetings/meeting-speech'
import { encodeSpeechTranscript } from './features/meetings/speech-provenance'
import { readSavedFile, saveMeeting } from './transcripts'
import { recallRead } from './recall'
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

afterEach(() => {
  configureMeetingSpeechLimits(undefined)
  useStorageForTests()
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
      await setImmediate()
      const before = process.memoryUsage()
      const fixtureStart = performance.now()
      const input = SaveMeetingSchema.parse(workload())
      const fixtureMs = performance.now() - fixtureStart
      expect(input.lines).toHaveLength(manifest.records)
      expect(input.lines.reduce((count, line) => count + (line.speech?.words?.length ?? 0), 0)).toBe(manifest.words)
      const textBytes = input.lines.reduce((count, line) => count + Buffer.byteLength(line.text), 0)
      expect(textBytes).toBe(manifest.textBytes)
      const codecStart = performance.now()
      const encoded = encodeSpeechTranscript(input.lines, testBudget)
      const codecMs = performance.now() - codecStart
      const saveStart = performance.now()
      const file = await saveMeeting(settings, input)
      const saveMs = performance.now() - saveStart
      const raw = readFileSync(file)
      const decryptStart = performance.now()
      const internalDocument = readSavedFile(file)
      const decryptReadMs = performance.now() - decryptStart
      const recallStart = performance.now()
      const recalled = await recallRead(basename(file))
      const recallMs = performance.now() - recallStart
      expect(recalled.ok).toBe(true)
      expect(recalled.lines).toEqual(input.lines)
      expect(recalled.speechProvenance).toBe('valid')
      await setImmediate()
      const after = process.memoryUsage()
      const metrics = {
        host: process.platform,
        encrypted,
        manifest,
        textBytes,
        memoryScope: 'worker-process-cumulative',
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
        rssBefore: before.rss,
        rssAfter: after.rss,
        heapBefore: before.heapUsed,
        heapAfter: after.heapUsed,
        processMaxRssKiB: process.resourceUsage().maxRSS,
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
        writeFileSync(report, JSON.stringify({ schema: 1, workloadOnly: true, measurements }) + '\n', { mode: 0o600 })
      console.log('Declared speech workload measurements', JSON.stringify(metrics))
    } finally {
      delay.disable()
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
