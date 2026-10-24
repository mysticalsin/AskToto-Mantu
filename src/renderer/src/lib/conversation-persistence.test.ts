import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatTurn } from '@shared/ipc'
import { createConversationPersistence, type ConversationBridge } from './conversation-persistence'

const CID = `c_${'a'.repeat(32)}`
const CID2 = `c_${'b'.repeat(32)}`
const view = (id: string) => ({
  id,
  assistantId: 'sys-general',
  status: 'live' as const,
  deadReason: null,
  linkedFrom: null,
  supersededBy: null,
  updatedAt: 1,
  turnCount: 0
})
const turn = (n: number, role: 'user' | 'assistant', text: string, at = 1000 + n) => ({
  id: `t_${String(n).repeat(32)}`,
  seq: n,
  role,
  text,
  at
})

function rig(overrides: Partial<ConversationBridge> = {}, memory = true) {
  const bridge: ConversationBridge = {
    open: vi.fn(async () => ({ ok: true as const, conversation: view(CID), created: false })),
    history: vi.fn(async () => ({
      ok: true as const,
      turns: [turn(1, 'user', 'q1'), turn(2, 'assistant', 'a1', 5000)],
      nextBefore: null,
      latestSeq: 2,
      anchor: null,
      status: 'live' as const,
      deadReason: null
    })),
    append: vi.fn(async (input) => ({
      ok: true as const,
      conversationId: input.conversationId,
      linkedFrom: null,
      deadReason: null,
      lastSeq: 4
    })),
    draftGet: vi.fn(async () => ({ ok: true as const, text: 'half-typed', updatedAt: 1 })),
    draftSet: vi.fn(async () => ({ ok: true as const })),
    ...overrides
  }
  const state = {
    input: '',
    history: { current: [] as ChatTurn[] },
    lastTurnAt: { current: 0 },
    ids: [] as Array<string | null>
  }
  const controller = createConversationPersistence({
    bridge,
    getInput: () => state.input,
    setInput: (text) => (state.input = text),
    history: state.history,
    lastTurnAt: state.lastTurnAt,
    memoryEnabled: () => memory,
    onActiveId: (id) => state.ids.push(id)
  })
  return { bridge, state, controller }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('conversation persistence for the Ask surface (G49)', () => {
  it('restores the draft into an empty input, but never over what the person already typed', async () => {
    const a = rig()
    await a.controller.start('sys-general')
    expect(a.state.input).toBe('half-typed')
    const b = rig()
    b.state.input = 'already typing'
    await b.controller.start('sys-general')
    expect(b.state.input).toBe('already typing')
  })

  it('seeds an empty follow-up memory from the last page, and keeps a memory the session already has', async () => {
    const a = rig()
    await a.controller.start('sys-general')
    expect(a.state.history.current).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' }
    ])
    expect(a.state.lastTurnAt.current).toBe(5000)
    expect(a.bridge.history).toHaveBeenCalledWith(CID, { limit: 12 })
    const b = rig()
    b.state.history.current = [{ role: 'user', content: 'this session' }]
    await b.controller.start('sys-general')
    expect(b.state.history.current).toEqual([{ role: 'user', content: 'this session' }])
  })

  it('reads and records no turns while follow-up memory is off, but still restores the draft', async () => {
    const r = rig({}, false)
    await r.controller.start('sys-general')
    expect(r.bridge.history).not.toHaveBeenCalled()
    expect(r.state.input).toBe('half-typed')
    await r.controller.record('sys-general', 'run1', 'q', 'a')
    expect(r.bridge.append).not.toHaveBeenCalled()
  })

  it('debounces the draft save and sends only the last text', async () => {
    const r = rig()
    await r.controller.start('sys-general')
    r.controller.inputChanged('h')
    r.controller.inputChanged('he')
    r.controller.inputChanged('hello')
    await vi.advanceTimersByTimeAsync(399)
    expect(r.bridge.draftSet).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(r.bridge.draftSet).toHaveBeenCalledTimes(1)
    expect(r.bridge.draftSet).toHaveBeenCalledWith(CID, 'hello')
  })

  it('records a completed turn with its run id and adopts the successor id after a linked append', async () => {
    const r = rig({
      append: vi.fn(async () => ({
        ok: true as const,
        conversationId: CID2,
        linkedFrom: CID,
        deadReason: 'remote-lost' as const,
        lastSeq: 2
      }))
    })
    await r.controller.start('sys-general')
    await r.controller.record('sys-general', 'run-9', 'question', 'answer')
    expect(r.bridge.append).toHaveBeenCalledWith({
      conversationId: CID,
      assistantId: 'sys-general',
      runId: 'run-9',
      turns: [
        { role: 'user', text: 'question' },
        { role: 'assistant', text: 'answer' }
      ]
    })
    expect(r.state.ids.at(-1)).toBe(CID2)
  })

  it('clears the visible memory and the restored draft when main answers signed-out, and sends nothing more', async () => {
    const r = rig()
    await r.controller.start('sys-general')
    expect(r.state.input).toBe('half-typed')
    ;(r.bridge.append as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, reason: 'signed-out' })
    await r.controller.record('sys-general', 'run-1', 'q', 'a')
    expect(r.state.history.current).toEqual([])
    expect(r.state.input).toBe('')
    expect(r.state.ids.at(-1)).toBeNull()
    r.controller.inputChanged('typed after sign-out')
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.bridge.draftSet).not.toHaveBeenCalled()
  })

  it('drops a late reply from an earlier start (a mode change in flight)', async () => {
    let release: (v: Awaited<ReturnType<ConversationBridge['open']>>) => void = () => undefined
    const slow = new Promise<Awaited<ReturnType<ConversationBridge['open']>>>((resolve) => (release = resolve))
    const r = rig({
      open: vi
        .fn()
        .mockReturnValueOnce(slow)
        .mockResolvedValue({ ok: true, conversation: view(CID2), created: false })
    })
    const first = r.controller.start('sys-sales')
    await r.controller.start('sys-general')
    release({ ok: true, conversation: view(CID), created: false })
    await first
    expect(r.state.ids.at(-1)).toBe(CID2)
  })

  it('starts a fresh empty thread on New chat and forgets the follow-up memory', async () => {
    const r = rig({ open: vi.fn(async () => ({ ok: true as const, conversation: view(CID2), created: true })) })
    r.state.history.current = [{ role: 'user', content: 'old' }]
    await r.controller.newThread('sys-general')
    expect(r.bridge.open).toHaveBeenCalledWith('sys-general', undefined, true)
    expect(r.state.history.current).toEqual([])
    expect(r.state.ids.at(-1)).toBe(CID2)
  })
})
