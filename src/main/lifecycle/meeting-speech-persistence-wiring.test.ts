import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptLine } from '@shared/transcript-line'
import {
  configureMeetingSpeechLimits,
  configureMeetingSpeechPersistence,
  decodeStoredMeetingSpeechAsync,
  decryptMeetingEnvelopeAsync,
  encryptMeetingEnvelopeAsync,
  getMeetingSpeechLimits,
  getMeetingSpeechReadLimitBytes,
  isMeetingSpeechPersistenceConfigured,
  renderMeetingTranscript,
  renderMeetingTranscriptAsync
} from '../features/meetings/meeting-speech'
import { MEETING_SPEECH_LIMITS, MEETING_SPEECH_WORKER_BOUNDS } from '../features/meetings/meeting-speech-policy'
import type { MeetingSpeechWorkerPort } from '../infra/process/meeting-speech-host'
import type { MeetingSpeechRequest } from '../infra/process/meeting-speech-protocol'
import { processMeetingSpeechRequest } from '../meeting-speech-worker'
import {
  bindMeetingSpeechInvalidation,
  bootstrapMeetingSpeech,
  MEETING_SPEECH_BREAKER_WINDOW_MS,
  type MeetingSpeechBootstrap,
  type MeetingSpeechBootstrapDeps
} from './meeting-speech-persistence-wiring'

const startedAt = Date.parse('2026-10-14T04:00:00.000Z')

function speechLine(index: number): TranscriptLine {
  const text = 'Synthetic line.'
  return {
    speaker: 'them',
    text,
    t: startedAt + 125 + index,
    lang: 'English',
    speech: {
      type: 'segment',
      captureId: '11111111-1111-4111-8111-111111111111',
      captureGeneration: 2,
      sequence: 9 + index,
      segment: {
        stream: { generation: 2, track: 'system', epoch: 3 },
        engine: 'deepgram-nova3',
        index: index + 4,
        revision: 2,
        final: true,
        text,
        startMs: 0,
        endMs: 1000
      },
      languages: ['en'],
      words: [
        { text: 'Synthetic', startMs: 0, endMs: 500, language: 'en', speaker: 1 },
        { text: 'line', punctuatedWord: 'line.', startMs: 500, endMs: 1000, language: 'en', speaker: 1 }
      ]
    }
  }
}

const lines = [speechLine(0), speechLine(1)]

/** Runs the real worker codec in-process: what a healthy worker thread would answer. */
class HealthyWorker extends EventEmitter implements MeetingSpeechWorkerPort {
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

/** A worker that loads, then dies on the first request (the bytecode/asar load failure shape). */
class CrashingWorker extends EventEmitter implements MeetingSpeechWorkerPort {
  postMessage(): void {
    setImmediate(() => this.emit('error', new Error('synthetic worker crash')))
  }
  async terminate(): Promise<number> {
    this.emit('exit', 1)
    return 1
  }
}

/** A worker that accepts a request and never answers. */
class SilentWorker extends EventEmitter implements MeetingSpeechWorkerPort {
  readonly terminate = vi.fn(async () => {
    this.emit('exit', 1)
    return 1
  })
  postMessage(): void {
    /* never replies */
  }
}

const K_LOCAL = 'F:c3ludGhldGljLWtleS13cmFw'
const contentKey = (): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const iv = (): Uint8Array => Uint8Array.from({ length: 12 }, (_, i) => 100 + i)

let bootstrap: MeetingSpeechBootstrap | undefined
let enabled: boolean
let audit: ReturnType<typeof vi.fn>
let clock: number
let quitListeners: Array<() => void>

function start(overrides: Partial<MeetingSpeechBootstrapDeps> = {}): MeetingSpeechBootstrap {
  bootstrap = bootstrapMeetingSpeech({
    readWorkerEnabled: () => enabled,
    audit: audit as MeetingSpeechBootstrapDeps['audit'],
    onWillQuit: (listener) => quitListeners.push(listener),
    now: () => clock,
    ...overrides
  })
  return bootstrap
}

beforeEach(() => {
  configureMeetingSpeechPersistence(undefined)
  configureMeetingSpeechLimits(undefined)
  enabled = true
  audit = vi.fn()
  clock = 1_000_000
  quitListeners = []
})

afterEach(async () => {
  await bootstrap?.dispose()
  bootstrap = undefined
  configureMeetingSpeechPersistence(undefined)
  configureMeetingSpeechLimits(undefined)
})

describe('bootstrapMeetingSpeech', () => {
  it('installs the trusted policy and the read cap even when the worker is switched off', () => {
    enabled = false
    const workerFactory = vi.fn(() => new HealthyWorker())
    start({ workerFactory })
    expect(getMeetingSpeechLimits()).toEqual(MEETING_SPEECH_LIMITS)
    expect(getMeetingSpeechReadLimitBytes()).toBe(MEETING_SPEECH_WORKER_BOUNDS.maxInputBytes)
  })

  it('with the kill switch off never constructs a worker and runs every operation inline', async () => {
    enabled = false
    const workerFactory = vi.fn(() => new HealthyWorker())
    const speech = start({ workerFactory })
    const rendered = await renderMeetingTranscriptAsync(lines)
    expect(rendered).toBe(renderMeetingTranscript(lines))
    const envelope = await encryptMeetingEnvelopeAsync('synthetic content', contentKey(), iv(), K_LOCAL)
    expect(await decryptMeetingEnvelopeAsync(envelope.subarray('ATKENC2\n'.length), contentKey(), K_LOCAL)).toBe(
      'synthetic content'
    )
    expect(await decodeStoredMeetingSpeechAsync(rendered)).toMatchObject({ ok: true, status: 'valid' })
    expect(workerFactory).not.toHaveBeenCalled()
    expect(speech.state()).toBe('off')
    expect(audit).not.toHaveBeenCalled()
  })

  it('reads the kill switch live: turning it on starts the worker, turning it off stops using it', async () => {
    enabled = false
    const workerFactory = vi.fn(() => new HealthyWorker())
    const speech = start({ workerFactory })
    await renderMeetingTranscriptAsync(lines)
    expect(workerFactory).not.toHaveBeenCalled()
    enabled = true
    expect(await renderMeetingTranscriptAsync(lines)).toBe(renderMeetingTranscript(lines))
    expect(workerFactory).toHaveBeenCalledTimes(1)
    expect(speech.state()).toBe('running')
    enabled = false
    await renderMeetingTranscriptAsync(lines)
    expect(speech.state()).toBe('off')
    expect(workerFactory).toHaveBeenCalledTimes(1)
  })

  it('with the worker on returns the same bytes the inline codec does', async () => {
    const workerFactory = vi.fn(() => new HealthyWorker())
    start({ workerFactory })
    expect(isMeetingSpeechPersistenceConfigured()).toBe(true)
    expect(await renderMeetingTranscriptAsync(lines)).toBe(renderMeetingTranscript(lines))
    expect(workerFactory).toHaveBeenCalledTimes(1)
  })

  it('answers 20 parallel decodes, running the overflow inline instead of refusing it', async () => {
    const workerFactory = vi.fn(() => new HealthyWorker())
    start({ workerFactory })
    const text = renderMeetingTranscript(lines)
    const results = await Promise.all(Array.from({ length: 20 }, () => decodeStoredMeetingSpeechAsync(text)))
    expect(results).toHaveLength(20)
    for (const result of results) expect(result).toMatchObject({ ok: true, status: 'valid' })
    expect(audit).not.toHaveBeenCalled()
  })

  it('saves inline when the worker crashes, and stops dispatching after 3 failures in 10 minutes', async () => {
    const workerFactory = vi.fn(() => new CrashingWorker())
    const speech = start({ workerFactory })
    const expected = renderMeetingTranscript(lines)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await renderMeetingTranscriptAsync(lines)).toBe(expected)
      clock += 1000
    }
    expect(workerFactory).toHaveBeenCalledTimes(3)
    expect(speech.state()).toBe('tripped')
    expect(isMeetingSpeechPersistenceConfigured()).toBe(false)
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith('meeting.speech.worker.degraded', {
      reason: 'worker-failures',
      failures: 3,
      windowMs: MEETING_SPEECH_BREAKER_WINDOW_MS
    })
    // Tripped until relaunch: further saves still succeed inline and never touch the worker.
    expect(await renderMeetingTranscriptAsync(lines)).toBe(expected)
    expect(workerFactory).toHaveBeenCalledTimes(3)
    expect(audit).toHaveBeenCalledTimes(1)
  })

  it('does not trip when the failures are spread beyond the window', async () => {
    const workerFactory = vi.fn(() => new CrashingWorker())
    const speech = start({ workerFactory })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await renderMeetingTranscriptAsync(lines)
      clock += MEETING_SPEECH_BREAKER_WINDOW_MS
    }
    expect(workerFactory).toHaveBeenCalledTimes(4)
    expect(speech.state()).not.toBe('tripped')
    expect(audit).not.toHaveBeenCalled()
  })

  it('treats a worker that cannot be constructed as a failure and falls back inline', async () => {
    const workerFactory = vi.fn(() => {
      throw new Error('worker_threads could not load the entry')
    })
    const speech = start({ workerFactory })
    expect(await renderMeetingTranscriptAsync(lines)).toBe(renderMeetingTranscript(lines))
    expect(workerFactory).toHaveBeenCalledTimes(1)
    expect(speech.state()).not.toBe('tripped')
    await renderMeetingTranscriptAsync(lines)
    await renderMeetingTranscriptAsync(lines)
    expect(speech.state()).toBe('tripped')
    expect(audit).toHaveBeenCalledTimes(1)
  })

  it('turns the worker off up front when its entry file is missing, audits once and runs inline', async () => {
    const entryExists = vi.fn(async () => false)
    const speech = start({ entryPath: '/nonexistent/meeting-speech-worker.js', entryExists })
    await vi.waitFor(() => expect(speech.state()).toBe('tripped'))
    expect(entryExists).toHaveBeenCalledWith('/nonexistent/meeting-speech-worker.js')
    expect(isMeetingSpeechPersistenceConfigured()).toBe(false)
    expect(await renderMeetingTranscriptAsync(lines)).toBe(renderMeetingTranscript(lines))
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit.mock.calls[0]?.[1]).toMatchObject({ reason: 'entry-missing' })
    // The audit record carries enums and counts only.
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Synthetic')
  })

  it('keeps the worker when its entry file exists and does not check when a worker is injected', async () => {
    const entryExists = vi.fn(async () => true)
    const speech = start({ entryPath: '/present/meeting-speech-worker.js', entryExists })
    await Promise.resolve()
    expect(speech.state()).toBe('idle')
    const injected = vi.fn(async () => false)
    start({ workerFactory: () => new HealthyWorker(), entryExists: injected })
    expect(injected).not.toHaveBeenCalled()
  })

  it('invalidation cancels a pending request (which then runs inline) and the next call starts a fresh worker', async () => {
    const workers: SilentWorker[] = []
    const workerFactory = vi.fn(() => {
      const worker = new SilentWorker()
      workers.push(worker)
      return worker
    })
    const speech = start({ workerFactory })
    const text = renderMeetingTranscript(lines)
    const pending = decodeStoredMeetingSpeechAsync(text)
    await new Promise((resolve) => setImmediate(resolve))
    expect(workers).toHaveLength(1)
    await speech.invalidate()
    expect(workers[0]!.terminate).toHaveBeenCalled()
    expect(await pending).toMatchObject({ ok: true, status: 'valid' })
    void decodeStoredMeetingSpeechAsync(text)
    await new Promise((resolve) => setImmediate(resolve))
    expect(workerFactory).toHaveBeenCalledTimes(2)
  })

  it('stops and unconfigures the worker on will-quit, and later saves still work inline', async () => {
    const workers: SilentWorker[] = []
    start({
      workerFactory: () => {
        const worker = new SilentWorker()
        workers.push(worker)
        return worker
      }
    })
    const pending = renderMeetingTranscriptAsync(lines)
    await new Promise((resolve) => setImmediate(resolve))
    expect(quitListeners).toHaveLength(1)
    quitListeners[0]!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(workers[0]!.terminate).toHaveBeenCalled()
    expect(isMeetingSpeechPersistenceConfigured()).toBe(false)
    expect(await pending).toBe(renderMeetingTranscript(lines))
    expect(await renderMeetingTranscriptAsync(lines)).toBe(renderMeetingTranscript(lines))
  })

  it('a second bootstrap retires the first so only one worker owner exists', async () => {
    const first = start({ workerFactory: () => new HealthyWorker() })
    const second = start({ workerFactory: () => new HealthyWorker() })
    await Promise.resolve()
    expect(first.state()).not.toBe('running')
    expect(second.state()).toBe('idle')
    expect(isMeetingSpeechPersistenceConfigured()).toBe(true)
  })
})

describe('bindMeetingSpeechInvalidation', () => {
  it('invalidates the worker whenever an owner session is revoked, and never throws into the authority', async () => {
    let revoked: (() => void) | undefined
    const invalidate = vi.fn().mockRejectedValue(new Error('would not stop'))
    const dispose = bindMeetingSpeechInvalidation(
      {
        onRevoked: (cb) => {
          revoked = () => cb({} as never, 'sign-out')
          return () => undefined
        }
      },
      { invalidate }
    )
    expect(() => revoked?.()).not.toThrow()
    await Promise.resolve()
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(typeof dispose).toBe('function')
  })
})
