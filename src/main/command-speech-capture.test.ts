import type { TrustedInputOwner } from '@shared/input-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPEECH_MAX_SECONDS } from '@shared/command-speech'
import {
  COMMAND_SPEECH_MAX_FRAME_SAMPLES,
  COMMAND_SPEECH_MAX_FRAMES,
  COMMAND_SPEECH_MAX_SAMPLES,
  COMMAND_SPEECH_SAMPLE_RATE,
  CommandSpeechCapture,
  type CommandSpeechResult
} from './command-speech-capture'

const owner: TrustedInputOwner = {
  webContentsId: 7,
  frameId: '12:3',
  isTopFrame: true,
  authSessionGeneration: 5,
  contextRevision: 11
}
const sessionId = 'a'.repeat(48)
const otherSessionId = 'b'.repeat(48)

function fill(n: number, value = 0.25): Float32Array {
  return new Float32Array(n).fill(value)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('CommandSpeechCapture', () => {
  let current: boolean
  let clock: number
  let isCurrent: ReturnType<typeof vi.fn<(owner: TrustedInputOwner, sessionId: string) => boolean>>
  let transcribe: ReturnType<typeof vi.fn<(samples: Float32Array) => Promise<string>>>
  let ingestTranscript: ReturnType<typeof vi.fn<(text: string) => void>>
  let onExpired: ReturnType<typeof vi.fn<(sessionId: string) => void>>
  let capture: CommandSpeechCapture

  beforeEach(() => {
    vi.useFakeTimers()
    current = true
    clock = 0
    isCurrent = vi.fn(() => current)
    transcribe = vi.fn(async (_samples: Float32Array): Promise<string> => '')
    ingestTranscript = vi.fn((_text: string): void => undefined)
    onExpired = vi.fn((_id: string): void => undefined)
    capture = new CommandSpeechCapture({ isCurrent, transcribe, ingestTranscript, onExpired, now: () => clock })
  })

  afterEach(() => {
    capture.cancelAll()
    vi.useRealTimers()
  })

  function advance(ms: number): void {
    clock += ms
    vi.advanceTimersByTime(ms)
  }

  function restart(): void {
    capture.cancelAll()
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
  }

  it('caps capture at fifteen seconds of 16 kHz mono, with every limit derived from that one constant', () => {
    expect(COMMAND_SPEECH_MAX_SECONDS).toBe(15)
    expect(COMMAND_SPEECH_MAX_SAMPLES).toBe(COMMAND_SPEECH_SAMPLE_RATE * COMMAND_SPEECH_MAX_SECONDS)
    expect(COMMAND_SPEECH_MAX_SAMPLES).toBe(240_000)
    expect(COMMAND_SPEECH_MAX_FRAMES).toBe(Math.ceil(COMMAND_SPEECH_MAX_SAMPLES / COMMAND_SPEECH_MAX_FRAME_SAMPLES))
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
    let sequence = 0
    let total = 0
    while (total + COMMAND_SPEECH_MAX_FRAME_SAMPLES <= COMMAND_SPEECH_MAX_SAMPLES) {
      expect(capture.frame(owner, sessionId, sequence++, fill(COMMAND_SPEECH_MAX_FRAME_SAMPLES))).toEqual({ ok: true })
      total += COMMAND_SPEECH_MAX_FRAME_SAMPLES
    }
    expect(sequence).toBe(117)
    const remainder = COMMAND_SPEECH_MAX_SAMPLES - total
    expect(remainder).toBe(384)
    expect(capture.frame(owner, sessionId, sequence++, fill(remainder))).toEqual({ ok: true })
    expect(capture.frame(owner, sessionId, sequence++, fill(1))).toEqual({ ok: false, reason: 'invalid' })
    expect(capture.frame(owner, sessionId, sequence++, fill(1))).toEqual({ ok: false, reason: 'stale' })
  })

  it('rejects stale, replayed and out-of-range frames', () => {
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
    expect(capture.frame(owner, otherSessionId, 0, fill(8))).toEqual({ ok: false, reason: 'stale' })
    expect(capture.frame({ ...owner, contextRevision: 12 }, sessionId, 0, fill(8))).toEqual({
      ok: false,
      reason: 'stale'
    })
    // Stale refusals must not clear the real capture.
    expect(capture.frame(owner, sessionId, 0, fill(8))).toEqual({ ok: true })

    const invalid: CommandSpeechResult = { ok: false, reason: 'invalid' }

    restart()
    expect(capture.frame(owner, sessionId, 0, fill(8))).toEqual({ ok: true })
    expect(capture.frame(owner, sessionId, 0, fill(8))).toEqual(invalid)

    restart()
    expect(capture.frame(owner, sessionId, 0, fill(8))).toEqual({ ok: true })
    expect(capture.frame(owner, sessionId, 2, fill(8))).toEqual(invalid)

    restart()
    expect(capture.frame(owner, sessionId, 0, fill(8, 1.5))).toEqual(invalid)

    restart()
    expect(capture.frame(owner, sessionId, 0, fill(8, Number.NaN))).toEqual(invalid)

    restart()
    expect(capture.frame(owner, sessionId, 0, [0.1])).toEqual(invalid)

    restart()
    expect(capture.frame(owner, sessionId, 0, new Float32Array(0))).toEqual(invalid)

    restart()
    expect(capture.frame(owner, sessionId, 0, fill(COMMAND_SPEECH_MAX_FRAME_SAMPLES + 1))).toEqual(invalid)
  })

  it('stops the physical mic before recognition starts', async () => {
    const first = new Float32Array([0.1, 0.2, 0.3])
    const second = new Float32Array([-0.4, 0.5])
    let seen: Float32Array | null = null
    let snapshot: number[] = []
    let inFlight: CommandSpeechResult | null = null
    transcribe.mockImplementationOnce(async (pcm) => {
      seen = pcm
      snapshot = Array.from(pcm)
      inFlight = capture.frame(owner, sessionId, 2, new Float32Array([0.1]))
      return 'open notes'
    })
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
    expect(capture.frame(owner, sessionId, 0, first)).toEqual({ ok: true })
    expect(capture.frame(owner, sessionId, 1, second)).toEqual({ ok: true })

    const result = await capture.finish(owner, sessionId, 2)

    expect(inFlight).toEqual({ ok: false, reason: 'stale' })
    expect(seen).not.toBeNull()
    expect(snapshot).toHaveLength(first.length + second.length)
    expect(snapshot).toEqual([...Array.from(first), ...Array.from(second)])
    // The late frame cleared the capture, so the recognition result is discarded.
    expect(result).toEqual({ ok: false, reason: 'stale' })
    expect(ingestTranscript).not.toHaveBeenCalled()
    const pcm = seen as unknown as Float32Array
    expect(pcm.every((v) => v === 0)).toBe(true)
  })

  it('returns no_speech for empty recognition', async () => {
    let seen: Float32Array | null = null
    transcribe.mockImplementationOnce(async (pcm) => {
      seen = pcm
      return '   '
    })
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
    expect(capture.frame(owner, sessionId, 0, fill(64))).toEqual({ ok: true })

    const result = await capture.finish(owner, sessionId, 1)

    expect(result).toEqual({ ok: false, reason: 'no_speech' })
    expect(ingestTranscript).not.toHaveBeenCalled()
    const pcm = seen as unknown as Float32Array
    expect(pcm.length).toBe(64)
    expect(pcm.every((v) => v === 0)).toBe(true)
  })

  it('fails closed on managed cloud-only profiles', async () => {
    let seen: Float32Array | null = null
    transcribe.mockImplementationOnce(async (pcm) => {
      seen = pcm
      throw new Error('command_policy_blocked')
    })
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
    expect(capture.frame(owner, sessionId, 0, fill(128))).toEqual({ ok: true })

    const result = await capture.finish(owner, sessionId, 1)

    expect(result).toEqual({ ok: false, reason: 'recognition_unavailable' })
    expect(ingestTranscript).not.toHaveBeenCalled()
    const pcm = seen as unknown as Float32Array
    expect(pcm.length).toBeGreaterThan(0)
    expect(pcm.every((v) => v === 0)).toBe(true)
  })

  it('delayed cleanup of an old capture does not advance the shared generation', async () => {
    const pending = deferred<string>()
    transcribe.mockImplementationOnce(() => pending.promise)
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
    expect(capture.frame(owner, sessionId, 0, fill(32))).toEqual({ ok: true })
    const finishA = capture.finish(owner, sessionId, 1)

    capture.cancelForLease(sessionId)
    expect(capture.start(owner, otherSessionId)).toEqual({ ok: true })

    pending.resolve('stale text')
    expect(await finishA).toEqual({ ok: false, reason: 'stale' })

    expect(capture.frame(owner, otherSessionId, 0, fill(32))).toEqual({ ok: true })
    transcribe.mockImplementationOnce(async () => 'open notes')
    expect(await capture.finish(owner, otherSessionId, 1)).toEqual({ ok: true })
    expect(ingestTranscript).toHaveBeenCalledTimes(1)
    expect(ingestTranscript).toHaveBeenCalledWith('open notes')
  })

  it('expires an idle capture two seconds after the cap and calls onExpired', () => {
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
    advance(COMMAND_SPEECH_MAX_SECONDS * 1_000 + 1_999)
    expect(onExpired).not.toHaveBeenCalled()
    advance(1)
    expect(onExpired).toHaveBeenCalledWith(sessionId)
    expect(capture.frame(owner, sessionId, 0, fill(8))).toEqual({ ok: false, reason: 'stale' })
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
  })

  it('finish with zero frames is invalid', async () => {
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
    expect(await capture.finish(owner, sessionId, 0)).toEqual({ ok: false, reason: 'invalid' })
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('busy while a capture is active', () => {
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
    expect(capture.start(owner, sessionId)).toEqual({ ok: false, reason: 'busy' })
    expect(capture.start(owner, otherSessionId)).toEqual({ ok: false, reason: 'busy' })
  })

  it('start is stale when isCurrent is false', () => {
    current = false
    expect(capture.start(owner, sessionId)).toEqual({ ok: false, reason: 'stale' })
    current = true
    expect(capture.start(owner, sessionId)).toEqual({ ok: true })
  })

  describe('onFinished', () => {
    const makeWith = (onFinished: (sessionId: string, result: CommandSpeechResult) => void) =>
      new CommandSpeechCapture({ isCurrent, transcribe, ingestTranscript, onExpired, onFinished, now: () => clock })

    it('reports a successful recognition once, after the transcript was ingested', async () => {
      const seen: Array<[string, CommandSpeechResult]> = []
      const reporting = makeWith((id, result) => {
        expect(ingestTranscript).toHaveBeenCalledTimes(1)
        seen.push([id, result])
      })
      transcribe.mockImplementationOnce(async () => 'open notes')
      expect(reporting.start(owner, sessionId)).toEqual({ ok: true })
      expect(reporting.frame(owner, sessionId, 0, fill(64))).toEqual({ ok: true })
      expect(await reporting.finish(owner, sessionId, 1)).toEqual({ ok: true })
      expect(seen).toEqual([[sessionId, { ok: true }]])
      reporting.cancelAll()
    })

    it('reports no_speech, recognition_unavailable and a stale finish with the same result the renderer gets', async () => {
      const seen: CommandSpeechResult[] = []
      const reporting = makeWith((_id, result) => void seen.push(result))
      transcribe.mockImplementationOnce(async () => ' ')
      reporting.start(owner, sessionId)
      reporting.frame(owner, sessionId, 0, fill(8))
      expect(await reporting.finish(owner, sessionId, 1)).toEqual({ ok: false, reason: 'no_speech' })
      transcribe.mockImplementationOnce(async () => {
        throw new Error('model missing')
      })
      reporting.start(owner, sessionId)
      reporting.frame(owner, sessionId, 0, fill(8))
      expect(await reporting.finish(owner, sessionId, 1)).toEqual({ ok: false, reason: 'recognition_unavailable' })
      current = false
      reporting.start(owner, sessionId)
      current = true
      reporting.start(owner, sessionId)
      current = false
      expect(await reporting.finish(owner, sessionId, 0)).toEqual({ ok: false, reason: 'stale' })
      expect(seen).toEqual([
        { ok: false, reason: 'no_speech' },
        { ok: false, reason: 'recognition_unavailable' },
        { ok: false, reason: 'stale' }
      ])
      reporting.cancelAll()
    })

    it('a throwing observer never changes what the renderer is told', async () => {
      const reporting = makeWith(() => {
        throw new Error('observer failed')
      })
      transcribe.mockImplementationOnce(async () => 'open notes')
      reporting.start(owner, sessionId)
      reporting.frame(owner, sessionId, 0, fill(8))
      expect(await reporting.finish(owner, sessionId, 1)).toEqual({ ok: true })
      reporting.cancelAll()
    })
  })
})
