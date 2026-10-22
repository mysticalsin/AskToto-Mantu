import { describe, expect, it, vi } from 'vitest'
import { CloudSpeechEventSchema, type CloudSpeechEvent } from '@shared/cloud-speech'
import { IPC } from '@shared/ipc'
import type { CounterMetricId } from '@shared/responsiveness-metrics'
import { createAskTurns, type AskTurn } from './ask-turn'
import { createTurnLedger } from './ask-handoff'
import { createMeetingContextRegistry, type ContextHandle, type FrameKey } from './meeting-context-registry'
import { meetingPermissions } from './wiring'

const FRAME: FrameKey = { processId: 9, routingId: 4 }
const STARTED = 1_700_000_000_000
const HEX = 'a'.repeat(64)
const GOAL = { mode: 'answer', prompt: 'What did we agree on the budget?' }

function final(index: number, text: string, revision = 1): CloudSpeechEvent {
  return CloudSpeechEventSchema.parse({
    type: 'segment',
    captureId: '11111111-1111-4111-8111-111111111111',
    captureGeneration: 1,
    sequence: index * 10 + revision,
    segment: {
      stream: { generation: 1, track: 'system', epoch: 1 },
      engine: 'deepgram-nova3',
      index,
      revision,
      final: true,
      text,
      startMs: index * 1_000,
      endMs: index * 1_000 + 500
    }
  })
}

function world(options: { metrics?: { increment(id: CounterMetricId): void } } = {}) {
  const permissions = { current: meetingPermissions(false) }
  const stale = vi.fn()
  const registry = createMeetingContextRegistry({
    resolveScope: (_frame, startedAt) => ({
      ownerKey: HEX,
      scope: { tenantId: 'c'.repeat(64), userId: HEX, sessionId: `meeting-${startedAt}` }
    }),
    permissions: () => permissions.current,
    onOutputsStale: (_frame, ids) => stale([...ids])
  })
  registry.ingestDelivered(FRAME, STARTED, final(1, 'synthetic opening line.'))
  const sent: { channel: string; payload: Record<string, unknown> }[] = []
  const streams = new Map<string, { abort: () => void }>()
  const ledger = createTurnLedger()
  const counts: CounterMetricId[] = []
  const turns = createAskTurns({
    send: (channel, payload) => void sent.push({ channel, payload: payload as Record<string, unknown> }),
    streams,
    ledger,
    metrics: options.metrics ?? { increment: (id) => void counts.push(id) }
  })
  const handle = (): ContextHandle => {
    const next = registry.acquire(FRAME, 'conversation')
    if (!next) throw new Error('no meeting open')
    return next
  }
  const stream = (id: string): ReturnType<typeof vi.fn> => {
    const abort = vi.fn()
    streams.set(id, { abort })
    return abort
  }
  const errors = (id: string): string[] =>
    sent.filter((s) => s.channel === IPC.streamError && s.payload.id === id).map((s) => String(s.payload.message))
  return { registry, permissions, turns, sent, streams, ledger, counts, stale, handle, stream, errors }
}
type World = ReturnType<typeof world>

const need = (turn: AskTurn | null): AskTurn => {
  if (!turn) throw new Error('expected a turn')
  return turn
}
const fast = (w: World, id: string) => w.turns.begin({ id, mode: 'answer', handle: w.handle(), ask: GOAL })
const deep = (w: World, id: string) =>
  w.turns.begin({ id, mode: 'answer', handle: w.handle(), ask: { ...GOAL, depth: 'deeper' } })
const deliver = (turn: AskTurn, id: string): void => {
  turn.send(IPC.streamDelta, { id, text: 'synthetic words' })
  turn.send(IPC.streamDone, { id })
}

describe('G29: a fast answer upgraded to a deep one is one turn with two stages', () => {
  it('keeps the turn identity, goal, owner and grants, and links the stages', async () => {
    const w = world()
    deliver(need(await fast(w, 'fast-1')), 'fast-1')
    need(await deep(w, 'deep-1'))
    const view = w.ledger.turnOf('deep-1')
    expect(view?.turnId).toBe('fast-1')
    expect(view?.stages.map((s) => [s.id, s.stage, s.outcome, s.supersededBy])).toEqual([
      ['fast-1', 'fast', 'delivered', 'deep-1'],
      ['deep-1', 'deep', 'running', null]
    ])
    expect(new Set(view?.stages.map((s) => s.anchor.owner)).size).toBe(1)
    expect(new Set(view?.stages.map((s) => s.anchor.permissionFingerprint)).size).toBe(1)
    expect(w.counts).toEqual(['handoff_started', 'handoff_superseded'])
  })

  it('supersedes the fast output instead of duplicating it: a later correction names the deep output only', async () => {
    const w = world()
    deliver(need(await fast(w, 'fast-1')), 'fast-1')
    const deepTurn = need(await deep(w, 'deep-1'))
    deliver(deepTurn, 'deep-1')
    w.registry.ingestDelivered(FRAME, STARTED, final(1, 'a corrected opening line.', 2))
    expect(w.stale).toHaveBeenCalledTimes(1)
    expect(w.stale).toHaveBeenCalledWith(['deep-1'])
  })

  it('without a handoff both outputs would be named: a plain second ask keeps the first', async () => {
    const w = world()
    deliver(need(await fast(w, 'one')), 'one')
    deliver(need(await fast(w, 'two')), 'two')
    w.registry.ingestDelivered(FRAME, STARTED, final(1, 'a corrected opening line.', 2))
    expect(w.stale.mock.calls.flat(2).sort()).toEqual(['one', 'two'])
  })

  it('a fast stage still streaming is stopped silently and its stream aborted, and the deep stage gets the turn', async () => {
    const w = world()
    const fastTurn = need(await fast(w, 'fast-1'))
    const abort = w.stream('fast-1')
    const deepTurn = need(await deep(w, 'deep-1'))
    expect(abort).toHaveBeenCalledTimes(1)
    expect(w.streams.has('fast-1')).toBe(false)
    expect(fastTurn.send(IPC.streamDelta, { id: 'fast-1', text: 'late fast chunk' })).toBe(false)
    expect(w.errors('fast-1')).toEqual([])
    expect(deepTurn.send(IPC.streamDelta, { id: 'deep-1', text: 'deep chunk' })).toBe(true)
    expect(w.counts).toEqual(['handoff_started', 'handoff_superseded'])
  })

  it('a plain ask is not a handoff and counts nothing', async () => {
    const w = world()
    deliver(need(await fast(w, 'one')), 'one')
    need(await fast(w, 'two'))
    expect(w.counts).toEqual([])
  })

  it('an ask without goal information opens no turn (callers that pass none are unchanged)', async () => {
    const w = world()
    need(await w.turns.begin({ id: 'plain', mode: 'answer', handle: w.handle() }))
    expect(w.ledger.size()).toBe(0)
  })
})

describe('G29: a handoff that cannot keep its promises runs fresh and says so in the counts', () => {
  it('changed grants (Private View on) refuse the handoff: the deep ask is its own turn', async () => {
    const w = world()
    deliver(need(await fast(w, 'fast-1')), 'fast-1')
    w.permissions.current = meetingPermissions(true)
    need(await deep(w, 'deep-1'))
    expect(w.ledger.turnOf('deep-1')?.turnId).toBe('deep-1')
    expect(w.ledger.turnOf('fast-1')?.stages[0].supersededBy).toBeNull()
    expect(w.counts).toEqual(['handoff_refused'])
  })

  it('a fast stage that failed is not handed off', async () => {
    const w = world()
    const turn = need(await fast(w, 'fast-1'))
    turn.send(IPC.streamError, { id: 'fast-1', message: 'synthetic provider failure' })
    need(await deep(w, 'deep-1'))
    expect(w.ledger.turnOf('deep-1')?.turnId).toBe('deep-1')
    expect(w.counts).toEqual(['handoff_refused'])
  })

  it('a fast stage the renderer cancelled is not handed off', async () => {
    const w = world()
    need(await fast(w, 'fast-1'))
    w.turns.cancel('fast-1')
    need(await deep(w, 'deep-1'))
    expect(w.counts).toEqual(['handoff_refused'])
  })

  it('a deeper ask with no earlier turn runs fresh', async () => {
    const w = world()
    need(await deep(w, 'deep-1'))
    expect(w.counts).toEqual(['handoff_refused'])
  })
})

describe('G29: asks with no live meeting hand off too', () => {
  it('keeps the turn and aborts a fast stream that is still running', async () => {
    const w = world()
    const first = need(await w.turns.begin({ id: 'fast-1', mode: 'answer', handle: null, ask: GOAL }))
    const abort = w.stream('fast-1')
    need(await w.turns.begin({ id: 'deep-1', mode: 'answer', handle: null, ask: { ...GOAL, depth: 'deeper' } }))
    expect(abort).toHaveBeenCalledTimes(1)
    expect(w.ledger.turnOf('deep-1')?.turnId).toBe('fast-1')
    expect(first).toBeDefined()
    expect(w.errors('fast-1')).toEqual([])
  })

  it('a delivered fast answer is handed off without touching any stream', async () => {
    const w = world()
    const first = need(await w.turns.begin({ id: 'fast-1', mode: 'answer', handle: null, ask: GOAL }))
    first.send(IPC.streamDone, { id: 'fast-1' })
    need(await w.turns.begin({ id: 'deep-1', mode: 'answer', handle: null, ask: { ...GOAL, depth: 'deeper' } }))
    expect(w.ledger.turnOf('deep-1')?.stages.map((s) => s.outcome)).toEqual(['delivered', 'running'])
    expect(w.counts).toEqual(['handoff_started', 'handoff_superseded'])
  })
})

describe('G29: metrics are counts only and never break an ask', () => {
  it('a metrics sink that throws does not stop the handoff', async () => {
    const w = world({
      metrics: {
        increment: () => {
          throw new Error('synthetic sink failure')
        }
      }
    })
    deliver(need(await fast(w, 'fast-1')), 'fast-1')
    need(await deep(w, 'deep-1'))
    expect(w.ledger.turnOf('deep-1')?.turnId).toBe('fast-1')
  })
})
