import { describe, expect, it, vi } from 'vitest'
import { cancelStaleLive } from './intervention-flow'
import { InterventionGate } from './intervention-gate'
import { ProactiveControls, playbookFingerprint, syncPlaybook } from './proactive-controls'

// The repo has no React render harness (vitest runs in node), so the hook's effect body is the pure
// syncPlaybook; the hook only supplies refs and the dependency list.
function setup() {
  const gate = new InterventionGate({ meetingStartMs: 1_000 })
  const controls = new ProactiveControls(() => 100_000)
  const baseline: { current: string | null } = { current: null }
  const sync = (settings: Parameters<typeof playbookFingerprint>[0]) =>
    syncPlaybook({ baseline, fingerprint: playbookFingerprint(settings), gate, controls })
  return { gate, controls, baseline, sync }
}

describe('playbook invalidation wiring (G77)', () => {
  it('first fingerprint is baseline (no bump)', () => {
    const { gate, sync } = setup()
    const generation = gate.generation
    expect(sync({ mode: 'sales', modePrompts: { sales: 'a' } })).toBe(false)
    expect(gate.generation).toBe(generation)
    expect(sync({ mode: 'sales', modePrompts: { sales: 'a' } })).toBe(false) // unchanged
    expect(gate.generation).toBe(generation)
  })

  it('fingerprint change bumps scope, clears the ring and cancels the streaming live card', async () => {
    const { gate, controls, sync } = setup()
    sync({ mode: 'sales', modePrompts: { sales: 'a' } })
    controls.commit(controls.reserve(gate.sessionId, 'questions')!, 'what is the price')
    const { snapshot } = await gate.decide('question', { shouldGenerate: true, reason: 'question-detected' }, 't1')
    const snapshotRef = { current: snapshot as typeof snapshot | null }
    const cancel = vi.fn()

    expect(sync({ mode: 'sales', modePrompts: { sales: 'b' } })).toBe(true)

    expect(controls.noveltyOf(gate.sessionId, 'what is the price')).toBe(1)
    expect(gate.isCurrent(snapshot)).toBe(false)
    expect(cancelStaleLive({ gate, snapshotRef, streaming: true, cancel })).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(gate.records().at(-1)).toMatchObject({ outcome: 'stale-drop', reason: 'live-card-invalidated' })
  })

  it('a changed playbook keeps the trigger budget', () => {
    const { gate, controls, sync } = setup()
    sync({ mode: 'general' })
    for (let i = 0; i < 6; i++) controls.commit(controls.reserve(gate.sessionId, 'questions')!, `q${i} word${i}`)
    sync({ mode: 'sales' })
    expect(controls.reserve(gate.sessionId, 'questions')).toBeNull()
  })
})
