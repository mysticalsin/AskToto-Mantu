import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TranscriptLine } from '@shared/transcript-line'
import {
  configureMeetingSpeechLimits,
  configureMeetingSpeechPersistence,
  decodeStoredMeetingSpeech,
  decodeStoredMeetingSpeechAsync,
  decryptMeetingEnvelopeAsync,
  encryptMeetingEnvelopeAsync,
  getMeetingSpeechLimits,
  publicMeetingText,
  publicMeetingTextAsync,
  renderMeetingTranscript,
  renderMeetingTranscriptAsync,
  rewrapMeetingEnvelopeAsync,
  rewriteStoredSpeechTranscript,
  rewriteStoredSpeechTranscriptAsync
} from './meeting-speech'
import { installMeetingSpeechPolicy, MEETING_SPEECH_WORKER_BOUNDS } from './meeting-speech-policy'
import {
  createMeetingSpeechPersistenceService,
  type MeetingSpeechPersistenceService,
  type MeetingSpeechWorkerPort
} from '../../infra/process/meeting-speech-host'
import type { MeetingSpeechFailureCode, MeetingSpeechRequest } from '../../infra/process/meeting-speech-protocol'
import { processMeetingSpeechRequest } from '../../meeting-speech-worker'

const startedAt = Date.parse('2026-10-14T04:00:00.000Z')

function speechLine(text: string, index: number): TranscriptLine {
  return {
    speaker: 'them',
    text,
    t: startedAt + 125 + index,
    name: 'Synthetic speaker',
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

const lines = [speechLine('Synthetic line.', 0), speechLine('Synthetic line.', 1)]

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

function failingService(code: MeetingSpeechFailureCode): MeetingSpeechPersistenceService {
  const fail = (): Promise<never> => Promise.reject(Object.assign(new Error(`stub ${code}`), { name: code }))
  return {
    reportTiming: () => undefined,
    readLimitBytes: () => MEETING_SPEECH_WORKER_BOUNDS.maxInputBytes,
    render: fail,
    decode: fail,
    rewrite: fail,
    project: fail,
    encryptEnvelopeV2: fail,
    decryptEnvelopeV2: fail,
    rewrapEnvelopeV2: fail,
    canonicalizeIncrementalRecord: fail,
    invalidateCurrent: () => Promise.resolve(),
    dispose: () => Promise.resolve()
  }
}

const FALLBACK_CODES: MeetingSpeechFailureCode[] = ['UNCONFIGURED', 'QUEUE_FULL', 'CANCELLED', 'WORKER_FAILED']

const contentKey = (): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const iv = (): Uint8Array => Uint8Array.from({ length: 12 }, (_, i) => 100 + i)
const K_LOCAL = 'F:c3ludGhldGljLWtleS13cmFw'

interface Outputs {
  render: string
  decode: unknown
  rewrite: string | null
  project: string
  envelope: Buffer
  decrypted: string
  rewrapped: Buffer
}

async function runAll(): Promise<Outputs> {
  const render = await renderMeetingTranscriptAsync(lines)
  const decode = await decodeStoredMeetingSpeechAsync(render)
  const edited = [{ ...lines[0]!, name: 'Renamed speaker' }, lines[1]!]
  const rewrite = await rewriteStoredSpeechTranscriptAsync(render, edited)
  const project = await publicMeetingTextAsync(render)
  const envelope = await encryptMeetingEnvelopeAsync('synthetic content', contentKey(), iv(), K_LOCAL, 'RSA-field')
  const json = envelope.subarray('ATKENC2\n'.length)
  const decrypted = await decryptMeetingEnvelopeAsync(json, contentKey(), K_LOCAL)
  const rewrapped = await rewrapMeetingEnvelopeAsync(json, 'F:bmV3LXdyYXA=')
  return { render, decode, rewrite, project, envelope, decrypted, rewrapped }
}

beforeEach(() => {
  configureMeetingSpeechPersistence(undefined)
  installMeetingSpeechPolicy()
})

afterEach(() => {
  configureMeetingSpeechPersistence(undefined)
  configureMeetingSpeechLimits(undefined)
})

describe('inline fallback of the async meeting speech wrappers', () => {
  it('with no service equals the synchronous codecs', async () => {
    const out = await runAll()
    expect(out.render).toBe(renderMeetingTranscript(lines))
    expect(out.decode).toEqual(decodeStoredMeetingSpeech(out.render))
    expect(out.rewrite).toBe(
      rewriteStoredSpeechTranscript(out.render, [{ ...lines[0]!, name: 'Renamed speaker' }, lines[1]!])
    )
    expect(out.project).toBe(publicMeetingText(out.render))
    expect(out.decrypted).toBe('synthetic content')
    expect(out.decode).toMatchObject({ ok: true, status: 'valid' })
    expect(out.rewrite).not.toBeNull()
  })

  it.each(FALLBACK_CODES)('on worker failure %s returns the same bytes as the worker path', async (code) => {
    const real = createMeetingSpeechPersistenceService({
      readLimits: getMeetingSpeechLimits,
      readBounds: () => MEETING_SPEECH_WORKER_BOUNDS,
      workerFactory: () => new InlineSpeechWorker()
    })
    configureMeetingSpeechPersistence(real)
    const viaWorker = await runAll()
    await real.dispose()

    configureMeetingSpeechPersistence(failingService(code))
    const fallback = await runAll()

    expect(fallback.render).toBe(viaWorker.render)
    expect(fallback.decode).toEqual(viaWorker.decode)
    expect(fallback.rewrite).toBe(viaWorker.rewrite)
    expect(fallback.project).toBe(viaWorker.project)
    expect(Buffer.compare(fallback.envelope, viaWorker.envelope)).toBe(0)
    expect(fallback.decrypted).toBe(viaWorker.decrypted)
    expect(Buffer.compare(fallback.rewrapped, viaWorker.rewrapped)).toBe(0)
  })

  it('never falls back on RESOURCE_LIMIT, which is a real refusal', async () => {
    configureMeetingSpeechPersistence(failingService('RESOURCE_LIMIT'))
    const framed = renderMeetingTranscript(lines)
    await expect(renderMeetingTranscriptAsync(lines)).rejects.toMatchObject({ name: 'RESOURCE_LIMIT' })
    await expect(decodeStoredMeetingSpeechAsync(framed)).rejects.toMatchObject({ name: 'RESOURCE_LIMIT' })
    await expect(rewriteStoredSpeechTranscriptAsync(framed, lines)).rejects.toMatchObject({ name: 'RESOURCE_LIMIT' })
    await expect(publicMeetingTextAsync(framed)).rejects.toThrow('Meeting text could not be projected safely.')
    await expect(encryptMeetingEnvelopeAsync('x', contentKey(), iv(), K_LOCAL)).rejects.toMatchObject({
      name: 'RESOURCE_LIMIT'
    })
    await expect(decryptMeetingEnvelopeAsync(new Uint8Array([1]), contentKey(), K_LOCAL)).rejects.toMatchObject({
      name: 'RESOURCE_LIMIT'
    })
    await expect(rewrapMeetingEnvelopeAsync(new Uint8Array([1]), K_LOCAL)).rejects.toMatchObject({
      name: 'RESOURCE_LIMIT'
    })
  })

  it('a refused projection keeps its generic message but stays recognisable as a resource refusal', async () => {
    configureMeetingSpeechPersistence(failingService('RESOURCE_LIMIT'))
    const framed = renderMeetingTranscript(lines)
    await expect(publicMeetingTextAsync(framed)).rejects.toMatchObject({
      name: 'RESOURCE_LIMIT',
      message: 'Meeting text could not be projected safely.'
    })
    configureMeetingSpeechPersistence(failingService('WORKER_FAILED'))
    await expect(publicMeetingTextAsync(framed)).resolves.toEqual(expect.any(String))
    await expect(publicMeetingTextAsync('<!-- /metis-speech-provenance -->')).rejects.toMatchObject({
      name: 'Error'
    })
  })

  it('does not swallow a non-worker error such as a wrong-key decrypt', async () => {
    const { envelope } = await runAll()
    const json = envelope.subarray('ATKENC2\n'.length)
    await expect(decryptMeetingEnvelopeAsync(json, new Uint8Array(32), K_LOCAL)).rejects.toThrow()
  })

  it('still refuses speech metadata when the trusted policy is deliberately absent', async () => {
    configureMeetingSpeechLimits(undefined)
    await expect(renderMeetingTranscriptAsync(lines)).rejects.toThrow('Speech metadata could not be retained.')
    configureMeetingSpeechPersistence(failingService('WORKER_FAILED'))
    await expect(renderMeetingTranscriptAsync(lines)).rejects.toThrow('Speech metadata could not be retained.')
  })
})
