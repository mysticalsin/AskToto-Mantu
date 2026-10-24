import { describe, expect, it, vi } from 'vitest'
import type { QuietAction } from '@shared/quiet-mode-settings'
import { InterventionGate } from './intervention-gate'
import { ProactiveControls } from './proactive-controls'
import {
  cancelStaleLive,
  existingRulesForQuestion,
  existingRulesForShadow,
  runQuestionFlow,
  runShadowFlow,
  type QuestionFlowDeps,
  type ShadowFlowDeps
} from './intervention-flow'

const READY = { autoSuggest: true, providerReady: true, suggestEverySec: 8 }

function questionDeps(over: Partial<QuestionFlowDeps> = {}) {
  const gate = new InterventionGate({ meetingStartMs: 1_000 })
  const deps: QuestionFlowDeps = {
    gate,
    nowMs: () => 100_000,
    lastSuggestAtRef: { current: 0 },
    settings: READY,
    suggestStreaming: () => false,
    focusCopilot: vi.fn(),
    readySpeculative: () => null,
    showSpeculative: vi.fn(),
    runSuggest: vi.fn(),
    offerQuiet: vi.fn(async (): Promise<QuietAction> => 'allow'),
    controls: new ProactiveControls(() => 100_000),
    triggerText: 'what is the price',
    ...over
  }
  return { gate, deps }
}

describe('existing rules (today’s gates, unchanged)', () => {
  const base = { settings: READY, streaming: false, nowMs: 100_000, lastSuggestAtMs: 0 }
  it('question path: autoSuggest, provider, streaming, cooldown, then generate', () => {
    expect(existingRulesForQuestion({ ...base, settings: { ...READY, autoSuggest: false } })).toEqual({
      shouldGenerate: false,
      reason: 'auto-suggest-off'
    })
    expect(existingRulesForQuestion({ ...base, settings: { autoSuggest: true } })).toEqual({
      shouldGenerate: false,
      reason: 'provider-not-ready'
    })
    expect(
      existingRulesForQuestion({ ...base, settings: { autoSuggest: true, localFallbackReady: true } }).shouldGenerate
    ).toBe(true)
    expect(existingRulesForQuestion({ ...base, streaming: true })).toEqual({
      shouldGenerate: false,
      reason: 'streaming'
    })
    expect(existingRulesForQuestion({ ...base, lastSuggestAtMs: 100_000 - 7_999 })).toEqual({
      shouldGenerate: false,
      reason: 'cooldown'
    })
    expect(existingRulesForQuestion({ ...base, lastSuggestAtMs: 100_000 - 8_000 })).toEqual({
      shouldGenerate: true,
      reason: 'question-detected'
    })
  })

  it('autoSuggest defaults on and the cooldown defaults to 8 s when settings have not loaded', () => {
    expect(existingRulesForQuestion({ ...base, settings: { providerReady: true } }).shouldGenerate).toBe(true)
    expect(existingRulesForQuestion({ ...base, settings: null }).reason).toBe('provider-not-ready')
  })

  it('shadow path: listening, instantSuggestions, provider, last speaker, watermark, cooldown, streaming', () => {
    const s = {
      listening: true,
      settings: { instantSuggestions: true, providerReady: true, suggestEverySec: 8 },
      lastSpeaker: 'them' as const,
      lineCount: 3,
      watermark: { lineCount: 2, at: 0 },
      nowMs: 100_000,
      anyStreaming: false
    }
    expect(existingRulesForShadow(s).shouldGenerate).toBe(true)
    expect(existingRulesForShadow({ ...s, listening: false }).reason).toBe('not-listening')
    expect(existingRulesForShadow({ ...s, settings: { ...s.settings, instantSuggestions: false } }).reason).toBe(
      'instant-suggestions-off'
    )
    expect(existingRulesForShadow({ ...s, settings: { instantSuggestions: true } }).reason).toBe('provider-not-ready')
    expect(existingRulesForShadow({ ...s, lastSpeaker: 'you' }).reason).toBe('last-speaker-not-them')
    expect(existingRulesForShadow({ ...s, watermark: { lineCount: 3, at: 0 } }).reason).toBe('no-new-line')
    expect(existingRulesForShadow({ ...s, watermark: { lineCount: 2, at: 95_000 } }).reason).toBe('cooldown')
    expect(existingRulesForShadow({ ...s, anyStreaming: true }).reason).toBe('streaming')
  })
})

describe('proactive controls in the question path (G77)', () => {
  const ASK = 'what is the price for the enterprise plan'
  const decideSpy = (gate: InterventionGate) => vi.spyOn(gate, 'decide')

  it('manual mode holds with mode-manual and never calls decide', async () => {
    const { gate, deps } = questionDeps({ settings: { ...READY, interruptionMode: 'manual' } })
    const spy = decideSpy(gate)
    expect(await runQuestionFlow(deps, 't1')).toBe('hold')
    expect(spy).not.toHaveBeenCalled()
    expect(deps.runSuggest).not.toHaveBeenCalled()
    expect(deps.lastSuggestAtRef.current).toBe(0)
    expect(gate.records().at(-1)).toEqual({
      path: 'question',
      status: 'held',
      shouldGenerate: false,
      reason: 'mode-manual',
      outcome: 'hold',
      generation: gate.generation,
      contextRevision: gate.contextRevision
    })
  })

  it('budget exhaustion holds before decide', async () => {
    const { gate, deps } = questionDeps({ triggerText: ASK })
    for (let i = 0; i < 6; i++) deps.controls.reserve(gate.sessionId, 'questions')
    const spy = decideSpy(gate)
    expect(await runQuestionFlow(deps, 't1')).toBe('hold')
    expect(spy).not.toHaveBeenCalled()
    expect(deps.runSuggest).not.toHaveBeenCalled()
    expect(gate.records().at(-1)).toMatchObject({ status: 'held', reason: 'budget', outcome: 'hold' })
  })

  it('budget is not consulted when an existing rule already says no', async () => {
    const { gate, deps } = questionDeps({ settings: { ...READY, autoSuggest: false } })
    for (let i = 0; i < 6; i++) deps.controls.reserve(gate.sessionId, 'questions')
    expect(await runQuestionFlow(deps, 't1')).toBe('hold')
    expect(gate.records().at(-1)).toMatchObject({ reason: 'auto-suggest-off' })
  })

  it('low-novelty trigger holds with novelty through decide', async () => {
    const { gate, deps } = questionDeps({ triggerText: ASK, nowMs: () => 100_000 })
    expect(await runQuestionFlow(deps, 't1')).toBe('generate')
    deps.nowMs = () => 200_000 // past the 8 s cooldown
    deps.triggerText = `${ASK}?`
    const spy = decideSpy(gate)
    expect(await runQuestionFlow(deps, 't2')).toBe('hold')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][1]).toEqual({ shouldGenerate: false, reason: 'novelty' })
    expect(deps.runSuggest).toHaveBeenCalledTimes(1)
    expect(gate.records().at(-1)).toMatchObject({ reason: 'novelty', outcome: 'hold' })
    expect(deps.lastSuggestAtRef.current).toBe(100_000)
    // the held trigger released its slot: five more distinct questions still fit
    for (let i = 0; i < 5; i++) {
      deps.nowMs = () => 300_000 + i * 20_000
      deps.triggerText = `distinct${i} topic${i} words${i} here${i}`
      expect(await runQuestionFlow(deps, `n${i}`)).toBe('generate')
    }
  })

  it('quiet defer and drop release the reservation', async () => {
    for (const action of ['defer', 'drop'] as const) {
      const { gate, deps } = questionDeps({ triggerText: ASK, offerQuiet: vi.fn(async () => action) })
      const { snapshot } = await gate.decide('shadow', { shouldGenerate: true, reason: 'new-line' })
      deps.readySpeculative = () => ({ snapshot })
      expect(await runQuestionFlow(deps, 't1')).toBe('suppressed-quiet')
      // all 6 slots are free again and the trigger did not enter the novelty ring
      expect(deps.controls.noveltyOf(gate.sessionId, ASK)).toBe(1)
      const slots = Array.from({ length: 6 }, () => deps.controls.reserve(gate.sessionId, 'questions'))
      expect(slots.every((s) => s !== null)).toBe(true)
    }
  })

  it('adopt and generate commit the trigger', async () => {
    const generated = questionDeps({ triggerText: ASK })
    expect(await runQuestionFlow(generated.deps, 't1')).toBe('generate')
    expect(generated.deps.controls.noveltyOf(generated.gate.sessionId, ASK)).toBe(0)

    const adopted = questionDeps({ triggerText: ASK })
    const { snapshot } = await adopted.gate.decide('shadow', { shouldGenerate: true, reason: 'new-line' })
    adopted.deps.readySpeculative = () => ({ snapshot })
    expect(await runQuestionFlow(adopted.deps, 't1')).toBe('adopt')
    expect(adopted.deps.controls.noveltyOf(adopted.gate.sessionId, ASK)).toBe(0)
  })

  it('stale-drop releases', async () => {
    const { gate, deps } = questionDeps({ triggerText: ASK })
    const { snapshot } = await gate.decide('shadow', { shouldGenerate: true, reason: 'new-line' })
    deps.readySpeculative = () => ({ snapshot })
    deps.offerQuiet = vi.fn(async () => {
      gate.observe({ kind: 'scope', change: 'stop' })
      return 'allow' as const
    })
    expect(await runQuestionFlow(deps, 't1')).toBe('stale-drop')
    expect(deps.controls.noveltyOf(gate.sessionId, ASK)).toBe(1)
    const slots = Array.from({ length: 6 }, () => deps.controls.reserve(gate.sessionId, 'questions'))
    expect(slots.every((s) => s !== null)).toBe(true)
  })

  it('a streaming race after decide releases the reservation', async () => {
    let streaming = false
    const { gate, deps } = questionDeps({ triggerText: ASK, suggestStreaming: () => streaming })
    const original = gate.decide.bind(gate)
    vi.spyOn(gate, 'decide').mockImplementation(async (...args) => {
      streaming = true // a card started streaming during the await
      return original(...args)
    })
    expect(await runQuestionFlow(deps, 't1')).toBe('hold')
    const slots = Array.from({ length: 6 }, () => deps.controls.reserve(gate.sessionId, 'questions'))
    expect(slots.every((s) => s !== null)).toBe(true)
  })

  it('questions mode with fresh budget and novel text behaves exactly as G70', async () => {
    const { gate, deps } = questionDeps({ settings: { ...READY, interruptionMode: 'questions' }, triggerText: ASK })
    expect(await runQuestionFlow(deps, 't1')).toBe('generate')
    expect(deps.runSuggest).toHaveBeenCalledTimes(1)
    expect(gate.records().at(-1)).toMatchObject({ status: 'existing-rules', outcome: 'generate' })
  })
})

describe('question path', () => {
  it('question path runs an ambient suggest when the rules allow', async () => {
    const { gate, deps } = questionDeps()
    expect(await runQuestionFlow(deps, 't1')).toBe('generate')
    expect(deps.runSuggest).toHaveBeenCalledTimes(1)
    const snapshot = vi.mocked(deps.runSuggest).mock.calls[0][0]
    expect(gate.isCurrent(snapshot)).toBe(true)
    expect(deps.lastSuggestAtRef.current).toBe(100_000)
    expect(gate.records().at(-1)).toMatchObject({ path: 'question', status: 'existing-rules', outcome: 'generate' })
  })

  it('question path holds inside the cooldown and never double-fires across the await', async () => {
    const { gate, deps } = questionDeps()
    const [a, b] = await Promise.all([runQuestionFlow(deps, 't1'), runQuestionFlow(deps, 't2')])
    expect([a, b].sort()).toEqual(['generate', 'hold'])
    expect(deps.runSuggest).toHaveBeenCalledTimes(1)
    expect(
      gate
        .records()
        .map((r) => r.outcome)
        .sort()
    ).toEqual(['generate', 'hold'])
  })

  it('holds without touching the card when a rule says no', async () => {
    const { deps } = questionDeps({ settings: { ...READY, autoSuggest: false } })
    expect(await runQuestionFlow(deps, 't1')).toBe('hold')
    expect(deps.runSuggest).not.toHaveBeenCalled()
    expect(deps.focusCopilot).not.toHaveBeenCalled()
    expect(deps.lastSuggestAtRef.current).toBe(0)
  })

  it('adopts a current shadow card only when quiet allows', async () => {
    const { gate, deps } = questionDeps()
    const { snapshot } = await gate.decide('shadow', { shouldGenerate: true, reason: 'new-line' })
    deps.readySpeculative = () => ({ snapshot })
    expect(await runQuestionFlow(deps, 't1')).toBe('adopt')
    expect(deps.offerQuiet).toHaveBeenCalledWith('proactiveSuggestion')
    expect(deps.showSpeculative).toHaveBeenCalledTimes(1)
    expect(deps.runSuggest).not.toHaveBeenCalled()
    expect(gate.records().at(-1)).toMatchObject({ outcome: 'adopt' })
  })

  it('quiet defer suppresses adoption and records suppressed-quiet', async () => {
    for (const action of ['defer', 'drop'] as const) {
      const { gate, deps } = questionDeps({ offerQuiet: vi.fn(async () => action) })
      const { snapshot } = await gate.decide('shadow', { shouldGenerate: true, reason: 'new-line' })
      deps.readySpeculative = () => ({ snapshot })
      expect(await runQuestionFlow(deps, 't1')).toBe('suppressed-quiet')
      expect(deps.showSpeculative).not.toHaveBeenCalled()
      expect(deps.runSuggest).not.toHaveBeenCalled()
      expect(gate.records().at(-1)).toMatchObject({ outcome: 'suppressed-quiet' })
    }
  })

  it('a shadow card made before a newer final is not adopted', async () => {
    const { gate, deps } = questionDeps()
    const { snapshot } = await gate.decide('shadow', { shouldGenerate: true, reason: 'new-line' })
    gate.observe({ kind: 'final', lineId: 't7' })
    deps.readySpeculative = () => ({ snapshot })
    expect(await runQuestionFlow(deps, 't7')).toBe('generate')
    expect(deps.showSpeculative).not.toHaveBeenCalled()
    expect(deps.runSuggest).toHaveBeenCalledTimes(1)
  })

  it('drops an adoption that went stale while waiting for quiet', async () => {
    const { gate, deps } = questionDeps()
    const { snapshot } = await gate.decide('shadow', { shouldGenerate: true, reason: 'new-line' })
    deps.readySpeculative = () => ({ snapshot })
    deps.offerQuiet = vi.fn(async () => {
      gate.observe({ kind: 'scope', change: 'stop' })
      return 'allow' as const
    })
    expect(await runQuestionFlow(deps, 't1')).toBe('stale-drop')
    expect(deps.showSpeculative).not.toHaveBeenCalled()
  })

  it('falls back to the main-side gate when the quiet bridge fails', async () => {
    const { gate, deps } = questionDeps({
      offerQuiet: vi.fn(async () => {
        throw new Error('synthetic bridge failure')
      })
    })
    const { snapshot } = await gate.decide('shadow', { shouldGenerate: true, reason: 'new-line' })
    deps.readySpeculative = () => ({ snapshot })
    expect(await runQuestionFlow(deps, 't1')).toBe('generate')
    expect(deps.showSpeculative).not.toHaveBeenCalled()
  })
})

describe('shadow path', () => {
  function shadowDeps(over: Partial<ShadowFlowDeps> = {}) {
    const gate = new InterventionGate({ meetingStartMs: 1_000 })
    const watermark = { lineCount: 0, at: 0 }
    const deps: ShadowFlowDeps = {
      gate,
      busyRef: { current: false },
      rulesInput: () => ({
        listening: true,
        settings: { instantSuggestions: true, providerReady: true, suggestEverySec: 8 },
        lastSpeaker: 'them',
        lineCount: 2,
        watermark,
        nowMs: 100_000,
        anyStreaming: false
      }),
      runSpeculative: vi.fn(() => 'run-1'),
      commitWatermark: vi.fn(),
      ...over
    }
    return { gate, deps }
  }

  it('runs the speculative suggest and hands the snapshot to the watermark', async () => {
    const { gate, deps } = shadowDeps()
    expect(await runShadowFlow(deps)).toBe('generate')
    expect(deps.runSpeculative).toHaveBeenCalledTimes(1)
    const committed = vi.mocked(deps.commitWatermark).mock.calls[0][0]
    expect(committed.runId).toBe('run-1')
    expect(gate.isCurrent(committed.snapshot)).toBe(true)
    expect(gate.records().at(-1)).toMatchObject({ path: 'shadow', outcome: 'generate' })
  })

  it('stays silent (no record) when it is already running', async () => {
    const { gate, deps } = shadowDeps({ busyRef: { current: true } })
    expect(await runShadowFlow(deps)).toBe('hold')
    expect(gate.records()).toHaveLength(0)
    expect(deps.runSpeculative).not.toHaveBeenCalled()
  })

  it('holds when a rule says no, and releases the busy flag either way', async () => {
    const { gate, deps } = shadowDeps({
      rulesInput: () => ({
        listening: false,
        settings: null,
        lastSpeaker: null,
        lineCount: 0,
        watermark: { lineCount: 0, at: 0 },
        nowMs: 1,
        anyStreaming: false
      })
    })
    expect(await runShadowFlow(deps)).toBe('hold')
    expect(deps.busyRef.current).toBe(false)
    expect(gate.records()).toHaveLength(0)
  })
})

describe('stale live card', () => {
  it('a streaming suggestion is cancelled when its trigger line is retracted', async () => {
    const { gate } = questionDeps()
    const { snapshot } = await gate.decide('question', { shouldGenerate: true, reason: 'question-detected' }, 't4')
    const ref = { current: snapshot as typeof snapshot | null }
    const cancel = vi.fn()
    gate.observe({ kind: 'final', lineId: 't5' })
    expect(cancelStaleLive({ gate, snapshotRef: ref, streaming: true, cancel })).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    gate.observe({ kind: 'retraction', lineId: 't4' })
    expect(cancelStaleLive({ gate, snapshotRef: ref, streaming: true, cancel })).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(ref.current).toBeNull()
    expect(gate.records().at(-1)).toMatchObject({ outcome: 'stale-drop' })
  })

  it('cancels on a generation change and forgets the snapshot once the card stops streaming', async () => {
    const { gate } = questionDeps()
    const { snapshot } = await gate.decide('question', { shouldGenerate: true, reason: 'question-detected' }, 't4')
    const ref = { current: snapshot as typeof snapshot | null }
    const cancel = vi.fn()
    gate.observe({ kind: 'scope', change: 'sign-out' })
    expect(cancelStaleLive({ gate, snapshotRef: ref, streaming: false, cancel })).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    expect(ref.current).toBeNull()
  })
})
