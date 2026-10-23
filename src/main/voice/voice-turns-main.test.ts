import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { VOICE_ACTIONS_IPC } from '@shared/voice/voice-turn'
import { WALKTHROUGH_IPC } from '@shared/walkthrough-view'
import type { CommandImmediateRunGate } from '../command-confirmation'
import { createMainVoiceTurns } from './voice-turns-main'
import type { VoiceTurnClaim } from './voice-session'

vi.mock('../logger', () => ({ auditLog: vi.fn() }))
vi.mock('../tasks/desktop-action-task-runtime', () => ({
  desktopActionTaskDeps: () => ({ execute: vi.fn(), recoverTasks: vi.fn() })
}))

const claim = (): VoiceTurnClaim => {
  let used = false
  return {
    turnId: 'turn-1',
    valid: () => !used,
    consume: () => (used ? false : (used = true))
  }
}

const OPEN: CommandImmediateRunGate = {
  authenticated: true,
  listenEntitled: true,
  ownerPresent: true,
  ownerVisible: true,
  onboardingExclusive: false,
  lifecycleHooksReady: true,
  ownerWebContentsId: 7
}

function make(gate: () => CommandImmediateRunGate, meeting = false, walkthroughEnabled?: () => boolean) {
  const execute = vi.fn(async (request: DesktopActionRequest, _context?: unknown) => ({
    id: request.id,
    ok: true,
    outcome: 'unknown' as const
  }))
  const propose = vi.fn(async () => ({ proposalId: 'p'.repeat(32), nonce: 'n'.repeat(64), argsHash: 'h'.repeat(64) }))
  const send = vi.fn()
  const outcomes: unknown[] = []
  const turns = createMainVoiceTurns({
    commandControl: { immediateRunGate: gate, proposeChecked: propose } as never,
    authority: { hasMeetingReservation: meeting },
    window: () => ({ isDestroyed: () => false, webContents: { id: 7, send } }),
    platform: 'darwin',
    execute: execute as never,
    walkthroughEnabled,
    onOutcome: (outcome) => void outcomes.push(outcome)
  })
  return { turns, execute, propose, send, outcomes }
}

describe('main voice turn composition', () => {
  it('runs an immediate action through the shared task bridge executor with the owner from CommandControl', async () => {
    const h = make(() => OPEN)
    h.turns.handle('open notes', claim())
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1))
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(h.execute.mock.calls[0][1]).toMatchObject({ owner: { webContentsId: 7 } })
  })

  it('proposes a create action in CommandControl for the owner window', async () => {
    const h = make(() => OPEN)
    h.turns.handle('create a note called Plan', claim())
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1))
    expect(h.propose).toHaveBeenCalledWith(
      { webContentsId: 7, revision: 1 },
      { id: 'desktop.create_note', args: { title: 'Plan' } }
    )
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('sends a question to the renderer on the ask channel', async () => {
    const h = make(() => OPEN)
    h.turns.handle('what is the capital of Portugal', claim())
    await vi.waitFor(() => expect(h.send).toHaveBeenCalled())
    expect(h.send).toHaveBeenCalledWith(VOICE_ACTIONS_IPC.ask, {
      turnId: 'turn-1',
      text: 'what is the capital of Portugal'
    })
  })

  it('a meeting that is recording refuses every action', async () => {
    const h = make(() => OPEN, true)
    h.turns.handle('open notes', claim())
    h.turns.handle('create a note called Plan', claim())
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(2))
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.propose).not.toHaveBeenCalled()
  })

  it('a gate that throws, or an owner that has no id, is a denial', async () => {
    const throwing = make(() => {
      throw new Error('gate bug')
    })
    throwing.turns.handle('open notes', claim())
    const noId = make(() => ({ ...OPEN, ownerWebContentsId: null }))
    noId.turns.handle('open notes', claim())
    await vi.waitFor(() => expect(throwing.outcomes).toHaveLength(1))
    await vi.waitFor(() => expect(noId.outcomes).toHaveLength(1))
    expect(throwing.execute).not.toHaveBeenCalled()
    expect(noId.execute).not.toHaveBeenCalled()
  })

  it('every gate input failing closed refuses the run', async () => {
    for (const override of [
      { authenticated: false },
      { listenEntitled: false },
      { ownerVisible: false },
      { onboardingExclusive: true },
      { lifecycleHooksReady: false }
    ]) {
      const h = make(() => ({ ...OPEN, ...override }))
      h.turns.handle('open notes', claim())
      await vi.waitFor(() => expect(h.outcomes).toHaveLength(1))
      expect(h.execute, JSON.stringify(override)).not.toHaveBeenCalled()
    }
  })

  describe('walkthrough start intent (G44)', () => {
    it('is off by default outside the QA build: the words go to the Ask path and nothing is guided', async () => {
      const h = make(() => OPEN)
      h.turns.handle('walk me through saving a file', claim())
      await vi.waitFor(() => expect(h.outcomes).toHaveLength(1))
      expect(h.outcomes[0]).toMatchObject({ kind: 'ask' })
    })

    it('with the flag on it guides only: with no planner bound it says so and runs no action', async () => {
      const h = make(
        () => OPEN,
        false,
        () => true
      )
      h.turns.handle('walk me through saving a file', claim())
      await vi.waitFor(() => expect(h.outcomes).toHaveLength(1))
      expect(h.outcomes[0]).toMatchObject({
        kind: 'walkthrough',
        status: 'no_plan',
        view: { phase: 'abandoned', stopReason: 'no_plan' }
      })
      expect(h.execute).not.toHaveBeenCalled()
      expect(h.propose).not.toHaveBeenCalled()
    })

    it('does not start while a meeting holds the reservation', async () => {
      const h = make(
        () => OPEN,
        true,
        () => true
      )
      h.turns.handle('walk me through saving a file', claim())
      await vi.waitFor(() => expect(h.outcomes).toHaveLength(1))
      expect(h.outcomes[0]).toMatchObject({ kind: 'walkthrough', status: 'meeting' })
    })

    it('pushes each walkthrough view to the live owner window and exposes the surface for the IPC', async () => {
      const h = make(
        () => OPEN,
        false,
        () => true
      )
      h.turns.handle('walk me through saving a file', claim())
      await vi.waitFor(() => expect(h.outcomes).toHaveLength(1))
      const pushed = h.send.mock.calls.filter(([channel]) => channel === WALKTHROUGH_IPC.view)
      expect(pushed.length).toBeGreaterThan(0)
      expect(pushed.at(-1)?.[1]).toMatchObject({ phase: 'abandoned', stopReason: 'no_plan' })
      expect(h.turns.walkthrough?.view()).toMatchObject({ phase: 'abandoned' })
    })

    it('pushes nothing when the owner is not the window the turns use', async () => {
      const h = make(
        () => ({ ...OPEN, ownerWebContentsId: 99 }),
        false,
        () => true
      )
      h.turns.handle('walk me through saving a file', claim())
      await vi.waitFor(() => expect(h.outcomes).toHaveLength(1))
      expect(h.send.mock.calls.filter(([channel]) => channel === WALKTHROUGH_IPC.view)).toHaveLength(0)
    })
  })
})
