import { describe, expect, it, vi } from 'vitest'
import type { QuietAction } from '@shared/quiet-mode-settings'
import { InterventionGate } from './intervention-gate'
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
