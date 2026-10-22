import { describe, expect, it, vi } from 'vitest'
import { CloudSpeechEventSchema, type CloudSpeechEvent } from '@shared/cloud-speech'
import {
  createMeetingContextRegistry,
  type FrameKey,
  type MeetingContextRegistryDeps,
  type MeetingScope
} from './meeting-context-registry'
import { meetingPermissions } from './wiring'
import { transcriptTailText } from './transcript-text'

const CAPTURE = '11111111-1111-4111-8111-111111111111'
const STARTED = 1_700_000_000_000
const FRAME: FrameKey = { processId: 12, routingId: 3 }
const HEX_A = 'a'.repeat(64)
const HEX_T = 'c'.repeat(64)

function segment(options: {
  sequence: number
  index: number
  text: string
  revision?: number
  track?: 'microphone' | 'system'
}): CloudSpeechEvent {
  return CloudSpeechEventSchema.parse({
    type: 'segment',
    captureId: CAPTURE,
    captureGeneration: 1,
    sequence: options.sequence,
    segment: {
      stream: { generation: 1, track: options.track ?? 'system', epoch: 1 },
      engine: 'deepgram-nova3',
      index: options.index,
      revision: options.revision ?? 1,
      final: true,
      text: options.text,
      startMs: options.index * 1_000,
      endMs: options.index * 1_000 + 500
    }
  })
}

function harness(over: Partial<MeetingContextRegistryDeps> = {}) {
  const stale = vi.fn()
  const registry = createMeetingContextRegistry({
    resolveScope: (_frame, startedAt): MeetingScope => ({
      ownerKey: HEX_A,
      scope: { tenantId: HEX_T, userId: HEX_A, sessionId: `meeting-${startedAt}` }
    }),
    permissions: () => meetingPermissions(false),
    onOutputsStale: stale,
    ...over
  })
  return { registry, stale }
}
type Harness = ReturnType<typeof harness>

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  }
}

const feed = (h: Harness, index: number, text: string, revision = 1, track: 'microphone' | 'system' = 'system') =>
  h.registry.ingestDelivered(FRAME, STARTED, segment({ sequence: index * 10 + revision, index, text, revision, track }))
const local = (h: Harness, t: number, text: string) =>
  h.registry.ingestLocalLine(FRAME, { startedAt: STARTED, t: STARTED + t, speaker: 'them', text })
const acquire = (h: Harness) => {
  const handle = h.registry.acquire(FRAME, 'conversation')
  if (!handle) throw new Error('no meeting open')
  return handle
}
const tail = (h: Harness): string => transcriptTailText(acquire(h).snapshot, 6_000)

describe('G15: a corrected line outdates the output built from it', () => {
  it('a corrected final aborts the running ask that read it, and the next request recomputes from the new text', async () => {
    const h = harness()
    feed(h, 1, 'we ship on friday')
    feed(h, 2, 'unrelated second line')
    const handle = acquire(h)
    const gate = deferred()
    let job: { signal: AbortSignal; check(): { state: string; code?: string } } | undefined
    const running = codeOf(
      handle.enqueue((active) => {
        job = active
        return gate.promise
      })
    )
    await flush()
    feed(h, 1, 'we ship on monday', 2)
    expect(job?.signal.aborted).toBe(true)
    expect(job?.check()).toEqual({ state: 'stale', code: 'LINE_CORRECTED' })
    expect(handle.check()).toEqual({ state: 'stale', code: 'LINE_CORRECTED' })
    expect(await running).toBe('TASK_INVALIDATED')
    // The next request reads the corrected revision and is current again.
    const next = acquire(h)
    expect(transcriptTailText(next.snapshot, 6_000)).toBe('THEM: we ship on monday\nTHEM: unrelated second line')
    expect(next.check().state).toBe('current')
  })

  it('a correction to a line the ask never read leaves the ask running (unrelated lines keep their output)', async () => {
    const h = harness()
    feed(h, 1, 'first line')
    const handle = acquire(h)
    feed(h, 2, 'second line arrives after the ask began')
    const gate = deferred()
    let job: { signal: AbortSignal; check(): { state: string } } | undefined
    const running = handle.enqueue((active) => {
      job = active
      return gate.promise
    })
    await flush()
    feed(h, 2, 'second line, corrected', 2)
    expect(job?.signal.aborted).toBe(false)
    expect(job?.check().state).toBe('advanced')
    expect(handle.check().state).toBe('advanced')
    gate.resolve()
    await running
  })

  it('a retraction of a line the ask read outdates it, and the next request no longer contains the line', async () => {
    const h = harness()
    local(h, 1_000, 'echo of the speakers')
    local(h, 2_000, 'a real line')
    const handle = acquire(h)
    const gate = deferred()
    const running = codeOf(handle.enqueue(() => gate.promise))
    await flush()
    expect(h.registry.retractLocalLine(FRAME, { startedAt: STARTED, t: STARTED + 1_000 })).toBe(true)
    expect(await running).toBe('TASK_INVALIDATED')
    expect(handle.check()).toEqual({ state: 'stale', code: 'LINE_CORRECTED' })
    expect(tail(h)).toBe('THEM: a real line')
    expect(acquire(h).check().state).toBe('current')
  })

  it('a speaker label that changes from one person to another outdates the ask; the first name does not', async () => {
    const h = harness()
    local(h, 1_000, 'who said this')
    const handle = acquire(h)
    // A name arriving for a line that had none is enrichment, not a correction.
    h.registry.labelLine(FRAME, { startedAt: STARTED, t: STARTED + 1_000, name: 'Alice' })
    expect(handle.check().state).toBe('advanced')
    const afterName = acquire(h)
    expect(tail(h)).toBe('THEM (Alice): who said this')
    h.registry.labelLine(FRAME, { startedAt: STARTED, t: STARTED + 1_000, name: 'Alicia' })
    expect(afterName.check()).toEqual({ state: 'stale', code: 'LINE_CORRECTED' })
    expect(tail(h)).toBe('THEM (Alicia): who said this')
  })

  it('a placeholder speaker label upgraded to a confirmed name is enrichment, not a correction', () => {
    const h = harness()
    local(h, 1_000, 'a line')
    h.registry.labelLine(FRAME, { startedAt: STARTED, t: STARTED + 1_000, name: 'Unknown speaker 1' })
    const handle = acquire(h)
    h.registry.labelLine(FRAME, { startedAt: STARTED, t: STARTED + 1_000, name: 'Alice' })
    expect(handle.check().state).toBe('advanced')
  })

  it('a partial or a repeated identical final corrects nothing', () => {
    const h = harness()
    feed(h, 1, 'steady line')
    const handle = acquire(h)
    feed(h, 1, 'steady line')
    expect(handle.check().state).toBe('current')
  })
})

describe('G15: outputs already published are reported stale once, by id, without content', () => {
  it('a corrected line reports the outputs that read it, each once, and leaves the others', () => {
    const h = harness()
    feed(h, 1, 'old claim')
    feed(h, 2, 'other topic')
    const first = acquire(h)
    first.recordOutput('ask-1')
    feed(h, 3, 'a later line')
    const later = acquire(h)
    later.recordOutput('ask-2')
    feed(h, 1, 'new claim', 2)
    expect(h.stale).toHaveBeenCalledTimes(1)
    expect(h.stale).toHaveBeenCalledWith(FRAME, ['ask-1', 'ask-2'])
    // The ask that read the corrected revision is current and is reported only for later corrections.
    const fresh = acquire(h)
    fresh.recordOutput('ask-3')
    feed(h, 1, 'newest claim', 3)
    expect(h.stale).toHaveBeenLastCalledWith(FRAME, ['ask-3'])
    feed(h, 1, 'newest claim, fixed', 4)
    expect(h.stale).toHaveBeenCalledTimes(2)
  })

  it('does not report an output whose lines were not corrected, and carries no transcript text', () => {
    const h = harness()
    feed(h, 1, 'secret-looking synthetic text')
    acquire(h).recordOutput('ask-1')
    feed(h, 2, 'a new line')
    feed(h, 2, 'a new line, corrected', 2)
    expect(h.stale).not.toHaveBeenCalled()
    feed(h, 1, 'synthetic correction', 2)
    expect(JSON.stringify(h.stale.mock.calls)).not.toContain('synthetic')
  })

  it('survives a throwing listener and forgets outputs when the meeting ends', () => {
    const throwing = harness({
      onOutputsStale: () => {
        throw new Error('listener down')
      }
    })
    feed(throwing, 1, 'line')
    acquire(throwing).recordOutput('ask-1')
    expect(() => feed(throwing, 1, 'line corrected', 2)).not.toThrow()
    expect(tail(throwing)).toBe('THEM: line corrected')

    const h = harness()
    feed(h, 1, 'line')
    const handle = acquire(h)
    handle.recordOutput('ask-1')
    h.registry.close(STARTED)
    expect(h.stale).not.toHaveBeenCalled()
  })
})
