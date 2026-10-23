import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudSpeechEventSchema, type CloudSpeechEvent } from '@shared/cloud-speech'
import { ContractError } from '@shared/kernel/contract-data'
import { IPC } from '@shared/ipc'
import {
  ANSWER_TIMEOUT_MESSAGE,
  QUEUE_BUSY_MESSAGE,
  STALE_ANSWER_MESSAGE,
  SUGGEST_JOB_TIMEOUT_MS,
  askStartFailureMessage,
  createAskTurns,
  stopReasonOf,
  type AskTurn
} from './ask-turn'
import { createMeetingContextRegistry, type ContextHandle, type FrameKey } from './meeting-context-registry'
import { meetingPermissions } from './wiring'

const FRAME: FrameKey = { processId: 7, routingId: 2 }
const STARTED = 1_700_000_000_000
const HEX = 'a'.repeat(64)

function final(index: number, text: string): CloudSpeechEvent {
  return CloudSpeechEventSchema.parse({
    type: 'segment',
    captureId: '11111111-1111-4111-8111-111111111111',
    captureGeneration: 1,
    sequence: index,
    segment: {
      stream: { generation: 1, track: 'system', epoch: 1 },
      engine: 'deepgram-nova3',
      index,
      revision: 1,
      final: true,
      text,
      startMs: index * 1_000,
      endMs: index * 1_000 + 500
    }
  })
}

interface Sent {
  channel: string
  payload: Record<string, unknown>
}

function world() {
  const permissions = { current: meetingPermissions(false) }
  const registry = createMeetingContextRegistry({
    resolveScope: (_frame, startedAt) => ({
      ownerKey: HEX,
      scope: { tenantId: 'c'.repeat(64), userId: HEX, sessionId: `meeting-${startedAt}` }
    }),
    permissions: () => permissions.current
  })
  registry.ingestDelivered(FRAME, STARTED, final(1, 'synthetic opening line.'))
  const sent: Sent[] = []
  const streams = new Map<string, { abort: () => void }>()
  const turns = createAskTurns({
    send: (channel, payload) => void sent.push({ channel, payload: payload as Record<string, unknown> }),
    streams
  })
  const handle = (): ContextHandle => {
    const next = registry.acquire(FRAME, 'conversation')
    if (!next) throw new Error('no meeting open')
    return next
  }
  /** A provider stream the main process registered for an ask: what `askCancel` and a stale turn abort. */
  const stream = (id: string): ReturnType<typeof vi.fn> => {
    const abort = vi.fn()
    streams.set(id, { abort })
    return abort
  }
  const errors = (id: string): string[] =>
    sent.filter((s) => s.channel === IPC.streamError && s.payload.id === id).map((s) => String(s.payload.message))
  const delivered = (id: string, channel: string): number =>
    sent.filter((s) => s.channel === channel && s.payload.id === id).length
  return { registry, permissions, turns, sent, streams, handle, stream, errors, delivered }
}

const begin = (w: ReturnType<typeof world>, id: string, mode = 'answer') =>
  w.turns.begin({ id, mode, handle: w.handle() })
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const need = (turn: AskTurn | null): AskTurn => {
  if (!turn) throw new Error('expected a turn')
  return turn
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a stale snapshot never publishes', () => {
  it('publishes while current, then drops every later chunk, final answer and meta once the context is stale', async () => {
    const w = world()
    const turn = need(await begin(w, 'a'))
    const abort = w.stream('a')
    expect(turn.send(IPC.streamMeta, { id: 'a', provider: 'synthetic' })).toBe(true)
    expect(turn.send(IPC.streamDelta, { id: 'a', text: 'first chunk' })).toBe(true)
    // Private View goes on: the permission set the snapshot carries changes.
    w.permissions.current = meetingPermissions(true)
    expect(turn.send(IPC.streamDelta, { id: 'a', text: 'stale chunk' })).toBe(false)
    expect(turn.send(IPC.streamDone, { id: 'a' })).toBe(false)
    expect(turn.send(IPC.streamMeta, { id: 'a', provider: 'synthetic' })).toBe(false)
    expect(w.delivered('a', IPC.streamDelta)).toBe(1)
    expect(w.delivered('a', IPC.streamDone)).toBe(0)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(w.streams.has('a')).toBe(false)
    // The renderer owns the id, so it is told exactly once, inline; never a second time, never a thrown error.
    expect(w.errors('a')).toEqual([STALE_ANSWER_MESSAGE])
  })

  it('drops a final answer the context outdated between the last chunk and the done event', async () => {
    const w = world()
    const turn = need(await begin(w, 'a'))
    turn.send(IPC.streamDelta, { id: 'a', text: 'the whole answer' })
    w.registry.close(STARTED)
    expect(turn.send(IPC.streamDone, { id: 'a', outputTokens: 4 })).toBe(false)
    expect(w.delivered('a', IPC.streamDone)).toBe(0)
  })

  it('does not stop for a new transcript line: the answer is for the moment it was asked', async () => {
    const w = world()
    const turn = need(await begin(w, 'a'))
    w.registry.ingestDelivered(FRAME, STARTED, final(2, 'synthetic later line.'))
    expect(turn.send(IPC.streamDelta, { id: 'a', text: 'still current' })).toBe(true)
    expect(turn.send(IPC.streamDone, { id: 'a' })).toBe(true)
    expect(w.errors('a')).toEqual([])
  })

  it('a suggestion card is gated like an answer', async () => {
    const w = world()
    const turn = need(await begin(w, 's', 'suggest'))
    w.permissions.current = meetingPermissions(true)
    expect(turn.send(IPC.streamDelta, { id: 's', text: 'Ask about the budget.' })).toBe(false)
    expect(w.delivered('s', IPC.streamDelta)).toBe(0)
  })

  it('an ask that waited behind another is dropped, not run, when the context went stale meanwhile', async () => {
    const w = world()
    need(await begin(w, 'first'))
    const second = begin(w, 'second')
    await flush()
    w.permissions.current = meetingPermissions(true)
    w.handle() // the next freshness read notices the permission change
    expect(await second).toBeNull()
    expect(w.errors('second')).toEqual([STALE_ANSWER_MESSAGE])
    expect(w.errors('first')).toEqual([STALE_ANSWER_MESSAGE])
  })
})

describe('the queue admits one ask and two waiting, then refuses', () => {
  it('a third pending ask is refused with a clear message, and the earlier ones are untouched', async () => {
    const w = world()
    const first = need(await begin(w, 'one'))
    let secondTurn: AskTurn | null | undefined
    let thirdTurn: AskTurn | null | undefined
    void begin(w, 'two').then((t) => (secondTurn = t))
    void begin(w, 'three').then((t) => (thirdTurn = t))
    await flush()
    expect(secondTurn).toBeUndefined()
    expect(thirdTurn).toBeUndefined()
    const fourth = await begin(w, 'four')
    expect(fourth).toBeNull()
    expect(w.errors('four')).toEqual([QUEUE_BUSY_MESSAGE])
    expect(w.errors('one')).toEqual([])
    expect(w.errors('two')).toEqual([])
    first.send(IPC.streamDone, { id: 'one' })
    await flush()
    expect(secondTurn).not.toBeNull()
    expect(thirdTurn).toBeUndefined()
  })

  it('a finished ask hands its turn to the next one in order', async () => {
    const w = world()
    const first = need(await begin(w, 'one'))
    const order: string[] = []
    const second = begin(w, 'two').then((t) => {
      order.push('two')
      return t
    })
    const third = begin(w, 'three').then((t) => {
      order.push('three')
      return t
    })
    await flush()
    expect(order).toEqual([])
    first.send(IPC.streamDone, { id: 'one' })
    const secondTurn = need(await second)
    await flush()
    expect(order).toEqual(['two'])
    secondTurn.send(IPC.streamError, { id: 'two', message: 'synthetic provider failure' })
    need(await third)
    expect(order).toEqual(['two', 'three'])
  })

  it('an error terminal also frees the slot', async () => {
    const w = world()
    const first = need(await begin(w, 'one'))
    const second = begin(w, 'two')
    first.send(IPC.streamError, { id: 'one', message: 'synthetic provider failure' })
    need(await second)
  })

  it('a start failure sends one error and frees the slot', async () => {
    const w = world()
    need(await begin(w, 'one'))
    const second = begin(w, 'two')
    w.turns.fail('one', 'Could not start the answer.')
    need(await second)
    expect(w.errors('one')).toEqual(['Could not start the answer.'])
  })
})

describe('cancel from the renderer', () => {
  it('aborts the running ask and its provider stream, sends nothing, and frees the slot', async () => {
    const w = world()
    const turn = need(await begin(w, 'one'))
    const abort = w.stream('one')
    const next = begin(w, 'two')
    w.turns.cancel('one')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(w.streams.has('one')).toBe(false)
    expect(turn.send(IPC.streamDelta, { id: 'one', text: 'late chunk' })).toBe(false)
    expect(w.sent).toEqual([])
    need(await next)
  })

  it('a cancel while the ask still waits for its turn drops it silently and never runs it', async () => {
    const w = world()
    const first = need(await begin(w, 'one'))
    const waiting = begin(w, 'two')
    const after = begin(w, 'three')
    await flush()
    w.turns.cancel('two')
    expect(await waiting).toBeNull()
    first.send(IPC.streamDone, { id: 'one' })
    need(await after)
    expect(w.errors('two')).toEqual([])
  })

  it('a cancelled ask no longer counts against the pending limit once its turn passes', async () => {
    const w = world()
    const first = need(await begin(w, 'one'))
    void begin(w, 'two')
    void begin(w, 'three')
    await flush()
    w.turns.cancel('two')
    w.turns.cancel('three')
    first.send(IPC.streamDone, { id: 'one' })
    await flush()
    await flush()
    need(await begin(w, 'four'))
  })

  it('a second ask with the same id supersedes the first without telling anyone', async () => {
    const w = world()
    const old = need(await begin(w, 'same'))
    const next = need(await begin(w, 'same'))
    expect(old.send(IPC.streamDelta, { id: 'same', text: 'old' })).toBe(false)
    expect(next.send(IPC.streamDelta, { id: 'same', text: 'new' })).toBe(true)
    expect(w.errors('same')).toEqual([])
  })
})

describe('the end of a meeting', () => {
  it('disposes the queue: the running ask is stopped and its stream aborted, waiting asks are told, new ones are refused', async () => {
    const w = world()
    const running = need(await begin(w, 'one'))
    const abort = w.stream('one')
    const waiting = begin(w, 'two')
    await flush()
    w.registry.close(STARTED)
    expect(await waiting).toBeNull()
    expect(abort).toHaveBeenCalledTimes(1)
    expect(running.send(IPC.streamDelta, { id: 'one', text: 'after the meeting' })).toBe(false)
    expect(w.errors('one')).toEqual([STALE_ANSWER_MESSAGE])
    expect(w.errors('two')).toEqual([STALE_ANSWER_MESSAGE])
  })

  it('a revoked owner session stops the running ask the same way', async () => {
    const w = world()
    const running = need(await begin(w, 'one'))
    const abort = w.stream('one')
    w.registry.closeFrame(`${FRAME.processId}:${FRAME.routingId}`)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(running.send(IPC.streamDelta, { id: 'one', text: 'late' })).toBe(false)
  })
})

describe('deadlines', () => {
  it('a suggestion that has not finished by its deadline is stopped, its stream aborted, and the renderer told', async () => {
    vi.useFakeTimers()
    const w = world()
    const turn = need(await begin(w, 's', 'suggest'))
    const abort = w.stream('s')
    vi.advanceTimersByTime(SUGGEST_JOB_TIMEOUT_MS - 1)
    expect(turn.send(IPC.streamDelta, { id: 's', text: 'on time' })).toBe(true)
    vi.advanceTimersByTime(2)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(turn.send(IPC.streamDelta, { id: 's', text: 'too late' })).toBe(false)
    expect(w.errors('s')).toEqual([ANSWER_TIMEOUT_MESSAGE])
  })

  it('an answer outlives the suggestion deadline', async () => {
    vi.useFakeTimers()
    const w = world()
    const turn = need(await begin(w, 'a', 'answer'))
    vi.advanceTimersByTime(SUGGEST_JOB_TIMEOUT_MS * 3)
    expect(turn.send(IPC.streamDelta, { id: 'a', text: 'a long deep answer' })).toBe(true)
  })
})

describe('an ask with no live meeting behind it', () => {
  it('runs straight away and publishes directly', async () => {
    const w = world()
    const turn = need(await w.turns.begin({ id: 'typed', mode: 'answer', handle: null }))
    expect(turn.send(IPC.streamDelta, { id: 'typed', text: 'hello' })).toBe(true)
    expect(turn.send(IPC.streamDone, { id: 'typed' })).toBe(true)
    expect(w.delivered('typed', IPC.streamDelta)).toBe(1)
    need(await begin(w, 'meeting'))
  })

  it('cancel and fail of an unknown id are harmless', () => {
    const w = world()
    expect(() => w.turns.cancel('nope')).not.toThrow()
    w.turns.fail('nope', 'Could not start the answer.')
    expect(w.errors('nope')).toEqual(['Could not start the answer.'])
  })
})

describe('stop reasons and messages', () => {
  it('maps queue refusals to stop reasons', () => {
    const reason = (code: ConstructorParameters<typeof ContractError>[0]) => stopReasonOf(new ContractError(code))
    expect(reason('QUEUE_FULL')).toBe('full')
    expect(reason('TASK_TIMEOUT')).toBe('timeout')
    expect(reason('QUEUE_CLOSED')).toBe('closed')
    expect(reason('SESSION_STOPPED')).toBe('closed')
    expect(reason('TASK_CANCELLED')).toBe('cancelled')
    expect(reason('TASK_INVALIDATED')).toBe('stale')
    expect(reason('STALE_PERMISSIONS')).toBe('stale')
    expect(stopReasonOf(new Error('anything else'))).toBe('stale')
  })

  it('a start failure names nothing but a skill integrity error', () => {
    expect(askStartFailureMessage(new Error('provider said something private'))).toBe('Could not start the answer.')
  })
})

describe('G15: a corrected line outdates a running turn and a finished one is recorded for it', () => {
  const correction = (text: string): CloudSpeechEvent =>
    CloudSpeechEventSchema.parse({
      type: 'segment',
      captureId: '11111111-1111-4111-8111-111111111111',
      captureGeneration: 1,
      sequence: 99,
      segment: {
        stream: { generation: 1, track: 'system', epoch: 1 },
        engine: 'deepgram-nova3',
        index: 1,
        revision: 2,
        final: true,
        text,
        startMs: 1_000,
        endMs: 1_500
      }
    })

  it('drops the rest of an answer built from a line that was then corrected, and tells the renderer once', async () => {
    const w = world()
    const turn = need(await begin(w, 'a'))
    const abort = w.stream('a')
    expect(turn.send(IPC.streamDelta, { id: 'a', text: 'first chunk' })).toBe(true)
    w.registry.ingestDelivered(FRAME, STARTED, correction('synthetic corrected opening line.'))
    expect(turn.send(IPC.streamDelta, { id: 'a', text: 'late chunk' })).toBe(false)
    expect(turn.send(IPC.streamDone, { id: 'a' })).toBe(false)
    expect(w.delivered('a', IPC.streamDelta)).toBe(1)
    expect(w.delivered('a', IPC.streamDone)).toBe(0)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(w.errors('a')).toEqual([STALE_ANSWER_MESSAGE])
  })

  it('a finished answer is recorded against the lines it read, so a later correction reports it stale', async () => {
    const w = world()
    const reports: string[][] = []
    const registry = createMeetingContextRegistry({
      resolveScope: (_frame, startedAt) => ({
        ownerKey: HEX,
        scope: { tenantId: 'c'.repeat(64), userId: HEX, sessionId: `meeting-${startedAt}` }
      }),
      permissions: () => meetingPermissions(false),
      onOutputsStale: (_owner, ids) => void reports.push([...ids])
    })
    registry.ingestDelivered(FRAME, STARTED, final(1, 'synthetic opening line.'))
    const turns = createAskTurns({ send: () => undefined, streams: w.streams })
    const handle = registry.acquire(FRAME, 'conversation')
    if (!handle) throw new Error('no meeting open')
    const turn = need(await turns.begin({ id: 'done-1', mode: 'suggest', handle }))
    expect(turn.send(IPC.streamDelta, { id: 'done-1', text: 'a suggestion' })).toBe(true)
    expect(reports).toEqual([])
    expect(turn.send(IPC.streamDone, { id: 'done-1' })).toBe(true)
    registry.ingestDelivered(FRAME, STARTED, correction('synthetic corrected opening line.'))
    expect(reports).toEqual([['done-1']])
  })

  it('an answer that ended in an error is never recorded', async () => {
    const reports: string[][] = []
    const registry = createMeetingContextRegistry({
      resolveScope: (_frame, startedAt) => ({
        ownerKey: HEX,
        scope: { tenantId: 'c'.repeat(64), userId: HEX, sessionId: `meeting-${startedAt}` }
      }),
      permissions: () => meetingPermissions(false),
      onOutputsStale: (_owner, ids) => void reports.push([...ids])
    })
    registry.ingestDelivered(FRAME, STARTED, final(1, 'synthetic opening line.'))
    const turns = createAskTurns({ send: () => undefined, streams: new Map() })
    const handle = registry.acquire(FRAME, 'conversation')
    if (!handle) throw new Error('no meeting open')
    const turn = need(await turns.begin({ id: 'err-1', mode: 'answer', handle }))
    expect(turn.send(IPC.streamError, { id: 'err-1', message: 'provider down' })).toBe(true)
    registry.ingestDelivered(FRAME, STARTED, correction('synthetic corrected opening line.'))
    expect(reports).toEqual([])
  })
})

describe('G27: the observer hears what the renderer hears, and can never change it', () => {
  function observed(observe: (event: unknown) => void) {
    const sent: Sent[] = []
    const streams = new Map<string, { abort: () => void }>()
    const turns = createAskTurns({
      send: (channel, payload) => void sent.push({ channel, payload: payload as Record<string, unknown> }),
      streams,
      observe
    })
    return { turns, sent }
  }

  it('reports the begin of an ask with its mode, then every event delivered to the renderer, after the delivery', async () => {
    const events: unknown[] = []
    const { turns, sent } = observed((event) => events.push({ event, deliveredSoFar: sent.length }))
    const turn = need(await turns.begin({ id: 'typed', mode: 'answer', handle: null }))
    turn.send(IPC.streamDelta, { id: 'typed', text: 'hello' })
    turn.send(IPC.streamDone, { id: 'typed' })
    expect(events).toEqual([
      { event: { type: 'begin', id: 'typed', mode: 'answer' }, deliveredSoFar: 0 },
      {
        event: { type: 'event', id: 'typed', channel: IPC.streamDelta, payload: { id: 'typed', text: 'hello' } },
        deliveredSoFar: 1
      },
      { event: { type: 'event', id: 'typed', channel: IPC.streamDone, payload: { id: 'typed' } }, deliveredSoFar: 2 }
    ])
  })

  it('hears exactly what a stale turn still delivered: the stale chunk is never reported, the one stale notice is', async () => {
    const w = world()
    const events: Array<{ type: string; channel?: string }> = []
    const turns = createAskTurns({
      send: () => undefined,
      streams: w.streams,
      observe: (event) => events.push(event as { type: string; channel?: string })
    })
    const turn = need(await turns.begin({ id: 'a', mode: 'answer', handle: w.handle() }))
    turn.send(IPC.streamDelta, { id: 'a', text: 'first chunk' })
    w.permissions.current = meetingPermissions(true)
    turn.send(IPC.streamDelta, { id: 'a', text: 'stale chunk' })
    turn.send(IPC.streamDone, { id: 'a' })
    expect(events.map((e) => `${e.type}:${e.channel ?? ''}`)).toEqual([
      'begin:',
      `event:${IPC.streamDelta}`,
      `event:${IPC.streamError}`
    ])
  })

  it('hears a start failure and a renderer cancel', async () => {
    const events: Array<{ type: string; channel?: string; id: string }> = []
    const { turns } = observed((event) => events.push(event as { type: string; channel?: string; id: string }))
    turns.fail('x', 'Could not start the answer.')
    turns.cancel('y')
    expect(events).toEqual([
      {
        type: 'event',
        id: 'x',
        channel: IPC.streamError,
        payload: { id: 'x', message: 'Could not start the answer.' }
      },
      { type: 'cancel', id: 'y' }
    ])
  })

  it('a throwing observer changes nothing: the renderer still gets every event and the turn still ends', async () => {
    const { turns, sent } = observed(() => {
      throw new Error('observer bug')
    })
    const turn = need(await turns.begin({ id: 'typed', mode: 'answer', handle: null }))
    expect(turn.send(IPC.streamDelta, { id: 'typed', text: 'hello' })).toBe(true)
    expect(turn.send(IPC.streamDone, { id: 'typed' })).toBe(true)
    expect(sent.map((s) => s.channel)).toEqual([IPC.streamDelta, IPC.streamDone])
  })
})
