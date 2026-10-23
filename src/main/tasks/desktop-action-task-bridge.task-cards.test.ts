import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import { TASK_CARD_DONE_LINGER_MS, TASK_CARD_NOT_DONE_LINGER_MS, TaskCardListSchema } from '@shared/task-card'
import { actionEnvelope, type ActionEnvelope } from '../action-guard'
import type { CommandExecutionContext } from '../command-control'
import { DesktopActionTaskBridge, type DesktopActionTaskBridgeDeps } from './desktop-action-task-bridge'
import type { TaskStateStore } from './encrypted-task-file-store'
import type { TaskStateReadResult } from './task-persistence'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic private title' } }
const OPEN: DesktopActionRequest = { id: 'desktop.open_notes', args: {} }

class MemoryStore implements TaskStateStore {
  serialized: string | null = null
  async read(): Promise<TaskStateReadResult> {
    return this.serialized === null ? { kind: 'not-found' } : { kind: 'found', serialized: this.serialized }
  }
  async write(serialized: string): Promise<void> {
    this.serialized = serialized
  }
  async quarantine(): Promise<void> {
    this.serialized = null
  }
}

const ctx = (proposalId: string, request: DesktopActionRequest, webContentsId = 7): CommandExecutionContext => ({
  proposalId,
  owner: { webContentsId, revision: 1 },
  ...actionEnvelope(proposalId, request),
  dependsOn: []
})
const verified = (request: DesktopActionRequest, envelope: ActionEnvelope): DesktopActionResult => ({
  id: request.id,
  ok: true,
  outcome: 'verified',
  receipt: { ...envelope, observation: 'The action is visible in its app' }
})

interface Gate {
  promise: Promise<void>
  open: () => void
}
function gate(): Gate {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

function make(overrides: Partial<DesktopActionTaskBridgeDeps> = {}) {
  let id = 0
  let cardId = 0
  const clock = { now: 1_000_000 }
  const execute = vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) => verified(request, envelope))
  const bridge = new DesktopActionTaskBridge({
    execute,
    store: new MemoryStore(),
    authSessionGeneration: () => 1,
    newId: () => `id-${(id += 1)}`,
    newCardId: () => (cardId += 1).toString(16).padStart(32, '0'),
    now: () => clock.now,
    ...overrides
  })
  return { bridge, execute, clock }
}

const O7 = 'webContents:7'
const phases = (bridge: DesktopActionTaskBridge, owner = O7): string[] => bridge.cards(owner).map((c) => c.phase)

describe('DesktopActionTaskBridge task cards (G33)', () => {
  it('shows queued then running then done for a task, and the done card leaves after its linger', async () => {
    const hold = gate()
    const { bridge, clock } = make({
      execute: async (request, envelope) => {
        await hold.promise
        return verified(request, envelope)
      }
    })
    const seen: string[][] = []
    bridge.onCardsChanged(() => seen.push(phases(bridge)))
    const first = bridge.execute(NOTE, ctx('p1', NOTE))
    const second = bridge.execute(OPEN, ctx('p2', OPEN))
    await vi.waitFor(() => expect(phases(bridge)).toEqual(['running', 'queued']))
    expect(bridge.cards(O7).map((c) => [c.stoppable, c.dismissible])).toEqual([
      [true, false],
      [true, false]
    ])

    hold.open()
    await Promise.all([first, second])
    expect(phases(bridge)).toEqual(['done', 'done'])
    expect(seen.flat()).toContain('queued')

    clock.now += TASK_CARD_DONE_LINGER_MS - 1
    expect(phases(bridge)).toEqual(['done', 'done'])
    clock.now += 1
    expect(bridge.cards(O7)).toEqual([])
  })

  it('stopping a queued card cancels it before it starts: not_done, stopped_before_start, never executed', async () => {
    const hold = gate()
    const { bridge, execute } = make({
      execute: vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) => {
        await hold.promise
        return verified(request, envelope)
      })
    })
    const first = bridge.execute(NOTE, ctx('p1', NOTE))
    const second = bridge.execute(OPEN, ctx('p2', OPEN))
    await vi.waitFor(() => expect(phases(bridge)).toEqual(['running', 'queued']))
    const queued = bridge.cards(O7)[1]

    expect(bridge.stopCard(O7, queued.cardId)).toBe(true)
    await expect(second).resolves.toMatchObject({ ok: false, outcome: 'cancelled' })
    expect(bridge.cards(O7)[1]).toMatchObject({
      phase: 'not_done',
      reason: 'stopped_before_start',
      stoppable: false,
      dismissible: true
    })
    hold.open()
    await first
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('stopping a running card shows stopping until the step settles, then classifies by receipt', async () => {
    const hold = gate()
    const { bridge } = make({
      execute: async (request, _envelope, signal) => {
        await hold.promise
        return { id: request.id, ok: false, outcome: signal?.aborted ? 'cancelled' : 'failed' }
      }
    })
    const run = bridge.execute(NOTE, ctx('p1', NOTE))
    await vi.waitFor(() => expect(phases(bridge)).toEqual(['running']))
    const card = bridge.cards(O7)[0]

    expect(bridge.stopCard(O7, card.cardId)).toBe(true)
    expect(bridge.cards(O7)[0]).toMatchObject({ phase: 'stopping', stoppable: false, dismissible: false })
    expect(bridge.stopCard(O7, card.cardId)).toBe(false)
    hold.open()
    await run
    expect(bridge.cards(O7)[0]).toMatchObject({ phase: 'not_done', dismissible: true })
  })

  it('a stopped running step whose effect cannot be proven stays uncertain until dismissed', async () => {
    const hold = gate()
    const { bridge, clock } = make({
      execute: async () => {
        await hold.promise
        throw new Error('adapter lost the app')
      }
    })
    const run = bridge.execute(NOTE, ctx('p1', NOTE))
    await vi.waitFor(() => expect(phases(bridge)).toEqual(['running']))
    const { cardId } = bridge.cards(O7)[0]
    bridge.stopCard(O7, cardId)
    hold.open()
    await run
    expect(bridge.cards(O7)[0]).toMatchObject({ phase: 'uncertain', stoppable: false, dismissible: true })

    clock.now += 10 * TASK_CARD_NOT_DONE_LINGER_MS
    expect(phases(bridge)).toEqual(['uncertain'])
    expect(bridge.stopCard(O7, cardId)).toBe(false)
    expect(bridge.dismissCard(O7, cardId)).toBe(true)
    expect(bridge.cards(O7)).toEqual([])
    expect(bridge.dismissCard(O7, cardId)).toBe(false)
  })

  it('a refused task shows not_done and leaves after the not-done linger or on dismiss', async () => {
    const { bridge, clock } = make()
    await bridge.execute(NOTE, ctx('p1', NOTE))
    await bridge.execute(NOTE, ctx('p1', NOTE)) // replay: refused as a duplicate
    const cards = bridge.cards(O7)
    expect(cards.map((c) => c.phase)).toEqual(['not_done'])
    expect(cards[0].reason).toBe('refused')

    clock.now += TASK_CARD_NOT_DONE_LINGER_MS
    expect(bridge.cards(O7)).toEqual([])
  })

  it('a done card cannot be dismissed, and Stop on it does nothing', async () => {
    const { bridge } = make()
    await bridge.execute(OPEN, ctx('p1', OPEN))
    const { cardId } = bridge.cards(O7)[0]
    expect(bridge.dismissCard(O7, cardId)).toBe(false)
    expect(bridge.stopCard(O7, cardId)).toBe(false)
  })

  it('scopes cards to their owner: another owner sees none and cannot stop or dismiss them', async () => {
    const hold = gate()
    const { bridge } = make({
      execute: async (request, envelope) => {
        await hold.promise
        return verified(request, envelope)
      }
    })
    const run = bridge.execute(NOTE, ctx('p1', NOTE))
    await vi.waitFor(() => expect(phases(bridge)).toEqual(['running']))
    const { cardId } = bridge.cards(O7)[0]

    expect(bridge.cards('webContents:8')).toEqual([])
    expect(bridge.stopCard('webContents:8', cardId)).toBe(false)
    expect(bridge.dismissCard('webContents:8', cardId)).toBe(false)
    expect(phases(bridge)).toEqual(['running'])
    hold.open()
    await run
  })

  it('uses opaque card ids and leaks no task id, grant, args hash, owner or argument', async () => {
    const hold = gate()
    const { bridge } = make({
      execute: async (request, envelope) => {
        await hold.promise
        return verified(request, envelope)
      }
    })
    const run = bridge.execute(NOTE, ctx('proposal-secret-1', NOTE))
    await vi.waitFor(() => expect(phases(bridge)).toEqual(['running']))
    const cards = bridge.cards(O7)
    expect(TaskCardListSchema.safeParse(cards).success).toBe(true)
    const json = JSON.stringify(cards)
    for (const leak of [
      'proposal-secret-1',
      'desktop-action:',
      'Synthetic private title',
      'id-',
      'webContents',
      'argsHash'
    ]) {
      expect(json).not.toContain(leak)
    }
    hold.open()
    await run
  })

  it('Stop-all moves queued cards to not_done and running cards to stopping', async () => {
    const hold = gate()
    const { bridge } = make({
      execute: async (request, envelope) => {
        await hold.promise
        return verified(request, envelope)
      }
    })
    const first = bridge.execute(NOTE, ctx('p1', NOTE))
    const second = bridge.execute(OPEN, ctx('p2', OPEN))
    await vi.waitFor(() => expect(phases(bridge)).toEqual(['running', 'queued']))
    bridge.stop()
    await second
    expect(phases(bridge)).toEqual(['stopping', 'not_done'])
    hold.open()
    await first
  })

  it('the default card id is 32 random hex characters', async () => {
    const { bridge } = make({ newCardId: undefined })
    await bridge.execute(OPEN, ctx('p1', OPEN))
    expect(bridge.cards(O7)[0].cardId).toMatch(/^[0-9a-f]{32}$/)
  })
})
