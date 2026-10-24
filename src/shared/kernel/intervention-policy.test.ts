// SYNTHETIC fixtures only. No provider, network, real meeting or desktop execution.
import { describe, expect, it } from 'vitest'
import {
  FakeSessionContext,
  SYNTHETIC_SCOPE as SCOPE,
  syntheticSegments
} from '../../test-helpers/intervention-context'
import { InterventionError, interventionDecisionSchema, type InterventionInput } from '../intervention-contract'
import { InterventionPolicy, buildInterventionInput, type InterventionPolicyOptions } from './intervention-policy'

const otherScope = { ...SCOPE, userId: 'synthetic-other-user' }
const hasCode = (code: string) => expect.objectContaining({ code })
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const scores = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  scores: { question: 0, objection: 0, hesitation: 0, decision: 0, ...overrides }
})
const rules = (shouldGenerate = false) => ({ shouldGenerate, reason: 'SYNTHETIC_EXISTING_RULE' })
const context = (scope = SCOPE) => new FakeSessionContext(scope)
const withTranscript = (count: number, text?: string) => {
  const ctx = context()
  ctx.setTranscript(syntheticSegments(SCOPE, count, text))
  return ctx
}
/** Most tests exercise the policy, not the rate limit; min interval has its own tests below. */
const policyFor = (
  ctx: FakeSessionContext,
  options: Partial<InterventionPolicyOptions> & Pick<InterventionPolicyOptions, 'classify'>
) => new InterventionPolicy(ctx, { minIntervalMs: 0, ...options })
const run = (
  policy: InterventionPolicy,
  ctx: FakeSessionContext,
  options: Partial<Parameters<InterventionPolicy['evaluate']>[0]> = {}
) => policy.evaluate({ snapshot: ctx.snapshot('conversation'), existingRules: rules(), ...options })

describe('buildInterventionInput', () => {
  it('takes at most eight recent finals and enforces a hard Unicode-safe byte budget', () => {
    const ctx = withTranscript(12, 'Synthetic🙂'.repeat(100))
    const snapshot = ctx.snapshot('conversation')
    const roomy = buildInterventionInput(snapshot, {
      liveFragment: 'Synthetic live fragment',
      currentCard: { scope: SCOPE, id: 'card-1', text: 'Synthetic current card' }
    })
    expect(roomy.input.finalMessages).toHaveLength(8)
    expect(roomy.input.finalMessages[0].utteranceId).toBe('synthetic-utterance-4')
    expect(roomy.input.finalMessages.at(-1)?.utteranceId).toBe('synthetic-utterance-11')
    expect(roomy.input.objective).toBe('Synthetic meeting objective')
    expect(roomy.budget.maxUtf8Bytes).toBe(8_192)
    expect(roomy.budget.utf8Bytes).toBeLessThanOrEqual(8_192)
    const small = buildInterventionInput(snapshot, {
      maxUtf8Bytes: 1_200,
      liveFragment: '🙂'.repeat(500),
      currentCard: { scope: SCOPE, id: 'card-1', text: '🙂'.repeat(500) }
    })
    expect(small.budget.utf8Bytes).toBeLessThanOrEqual(1_200)
    expect(Buffer.byteLength(JSON.stringify(small.input), 'utf8')).toBeLessThanOrEqual(1_200)
    expect(JSON.stringify(small.input)).not.toContain('�')
    expect(() =>
      buildInterventionInput(snapshot, {
        currentCard: { scope: otherScope, id: 'foreign', text: 'Synthetic foreign card' }
      })
    ).toThrow(hasCode('SCOPE_MISMATCH'))
  })

  it('rejects a foreign tenant on a segment and non-final or unidentified segments', () => {
    const ctx = context()
    ctx.setTranscript([{ ...syntheticSegments(SCOPE, 1)[0], scope: { ...SCOPE, tenantId: 'other-tenant' } }])
    expect(() => buildInterventionInput(ctx.snapshot())).toThrow(hasCode('SCOPE_MISMATCH'))
    const partial = context()
    partial.setTranscript([{ ...syntheticSegments(SCOPE, 1)[0], state: 'partial' }])
    expect(() => buildInterventionInput(partial.snapshot())).toThrow(hasCode('INTERVENTION_SEGMENT'))
    const unidentified = context()
    unidentified.setTranscript([{ ...syntheticSegments(SCOPE, 1)[0], utteranceId: 'bad id!' }])
    expect(() => buildInterventionInput(unidentified.snapshot())).toThrow(hasCode('INTERVENTION_SEGMENT'))
  })

  it('validates the configured limits', () => {
    const snapshot = withTranscript(1).snapshot()
    expect(() => buildInterventionInput(snapshot, { maxFinalMessages: 9 })).toThrow(
      hasCode('INTERVENTION_MESSAGE_LIMIT')
    )
    expect(() => buildInterventionInput(snapshot, { maxUtf8Bytes: 100 })).toThrow(hasCode('INTERVENTION_BYTE_LIMIT'))
    expect(buildInterventionInput(snapshot, { maxFinalMessages: 0 }).input.finalMessages).toEqual([])
  })

  it('clips per-field text to the contract caps and the result parses against the contract schema', () => {
    const snapshot = withTranscript(1, 'x'.repeat(2_000)).snapshot()
    const built = buildInterventionInput(snapshot, { liveFragment: 'y'.repeat(2_000) })
    expect(built.input.finalMessages[0].text).toHaveLength(640)
    expect(built.input.liveFragment).toHaveLength(512)
    expect(Object.isFrozen(built.input)).toBe(true)
  })
})

describe('InterventionPolicy.evaluate', () => {
  it('returns a generation decision and evidence stamp without generating an answer or action', async () => {
    const ctx = context()
    let calls = 0
    const policy = policyFor(ctx, {
      enabled: true,
      classify: async (input: InterventionInput) => {
        calls += 1
        expect(input.objective).toBe('Synthetic meeting objective')
        return scores({ question: 0.86 })
      }
    })
    const result = await run(policy, ctx)
    expect(result.stage).toBe('intervention-classification')
    expect(result.status).toBe('classified')
    expect(result.shouldGenerate).toBe(true)
    expect(result.matched).toEqual(['question'])
    expect(result.contextRevision).toBe(ctx.revision)
    expect(result).not.toHaveProperty('answer')
    expect(result).not.toHaveProperty('action')
    expect(interventionDecisionSchema.safeParse(result).success).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(calls).toBe(1)
    policy.dispose()
  })

  it('uses the guide thresholds: 0.85 response, 0.90 help, boundary inclusive', async () => {
    const ctx = context()
    const seen = [
      scores({ question: 0.85 }),
      scores({ hesitation: 0.89 }),
      scores({ hesitation: 0.9 }),
      scores({ objection: 0.84, decision: 0.85 })
    ]
    const policy = policyFor(ctx, { enabled: true, classify: async () => seen.shift() })
    expect((await run(policy, ctx, { liveFragment: 'x'.repeat(40) })).matched).toEqual(['question'])
    expect((await run(policy, ctx, { liveFragment: 'x'.repeat(40) })).shouldGenerate).toBe(false)
    expect((await run(policy, ctx, { liveFragment: 'x'.repeat(40) })).matched).toEqual(['hesitation'])
    const last = await run(policy, ctx)
    expect(last.matched).toEqual(['decision'])
    expect(last.thresholds).toEqual({ question: 0.85, objection: 0.85, hesitation: 0.9, decision: 0.85 })
    policy.dispose()
  })

  it('partial stability gates admission and a short fragment uses the explicit 0.70 hesitation threshold', async () => {
    const ctx = context()
    let calls = 0
    const policy = policyFor(ctx, {
      enabled: true,
      classify: async () => {
        calls += 1
        return scores({ hesitation: 0.75 })
      }
    })
    const held = await run(policy, ctx, {
      liveFragment: 'Synthetic short',
      trigger: { kind: 'partial', stableForMs: 274 }
    })
    expect(held.status).toBe('held')
    expect(held.reason).toBe('PARTIAL_NOT_STABLE')
    expect(calls).toBe(0)
    const short = await run(policy, ctx, {
      liveFragment: '🙂'.repeat(24),
      trigger: { kind: 'partial', stableForMs: 275 }
    })
    expect(short.thresholds?.hesitation).toBe(0.7)
    expect(short.shouldGenerate).toBe(true)
    const long = await run(policy, ctx, { liveFragment: '🙂'.repeat(25) })
    expect(long.thresholds?.hesitation).toBe(0.9)
    expect(long.shouldGenerate).toBe(false)
    expect(calls).toBe(2)
    policy.dispose()
  })

  it('only one classification is in flight; a later admission reports busy without a second call', async () => {
    const ctx = context()
    const gate = deferred<unknown>()
    let calls = 0
    const policy = policyFor(ctx, {
      enabled: true,
      classify: () => {
        calls += 1
        return gate.promise
      }
    })
    const first = run(policy, ctx)
    await flush()
    const second = await run(policy, ctx)
    expect(second.status).toBe('busy')
    expect(second.shouldGenerate).toBe(false)
    expect(calls).toBe(1)
    gate.resolve(scores({ question: 1 }))
    expect((await first).shouldGenerate).toBe(true)
    expect(policy.status.busy).toBe(false)
    policy.dispose()
  })

  it('stale revisions cancel classification without falling back on an obsolete decision', async () => {
    const ctx = context()
    const gate = deferred<unknown>()
    let signal: AbortSignal | undefined
    const policy = policyFor(ctx, {
      enabled: true,
      classify: (_input, abort) => {
        signal = abort
        return gate.promise
      }
    })
    const pending = run(policy, ctx, { existingRules: rules(true) })
    await flush()
    ctx.setScreen('Changed synthetic context')
    const stale = await pending
    expect(signal?.aborted).toBe(true)
    expect(stale.status).toBe('stale')
    expect(stale.shouldGenerate).toBe(false)
    expect(policy.status.enabled).toBe(true)
    gate.resolve(scores({ question: 1 }))
    await flush()
    const oldSnapshot = ctx.snapshot('conversation')
    ctx.stop()
    ctx.resume()
    await expect(policy.evaluate({ snapshot: oldSnapshot, existingRules: rules(true) })).rejects.toEqual(
      hasCode('STALE_GENERATION')
    )
    policy.dispose()
  })

  it('is off by default; a classifier failure disables it for the session while existing rules continue', async () => {
    const ctx = context()
    let calls = 0
    const disabled = policyFor(ctx, {
      classify: async () => {
        calls += 1
        return scores()
      }
    })
    expect((await run(disabled, ctx, { existingRules: rules(true) })).status).toBe('existing-rules')
    expect(disabled.status.disabledReason).toBe('not-enabled')
    expect(
      (await run(disabled, ctx, { existingRules: rules(true), trigger: { kind: 'partial', stableForMs: 0 } }))
        .shouldGenerate
    ).toBe(true)
    expect(calls).toBe(0)
    disabled.dispose()
    const failed = policyFor(ctx, {
      enabled: true,
      classify: async () => {
        calls += 1
        throw new Error('Synthetic optional service failure')
      }
    })
    expect((await run(failed, ctx, { existingRules: rules(true) })).shouldGenerate).toBe(true)
    expect(failed.status.enabled).toBe(false)
    expect(failed.status.disabledReason).toBe('classifier-failed')
    expect((await run(failed, ctx, { existingRules: rules(false) })).shouldGenerate).toBe(false)
    ctx.stop()
    ctx.resume()
    expect((await run(failed, ctx)).status).toBe('existing-rules')
    expect(calls).toBe(1)
    failed.dispose()
    const newSession = context({ ...SCOPE, sessionId: 'synthetic-new-session' })
    const next = policyFor(newSession, { enabled: true, classify: async () => scores({ decision: 1 }) })
    expect((await run(next, newSession)).status).toBe('classified')
    next.dispose()
  })

  it('invalid scores and timeout fall back only within valid authority; foreign and revoked snapshots never gain permission', async () => {
    const ctx = context()
    const invalid = policyFor(ctx, { enabled: true, classify: async () => scores({ question: 99 }) })
    expect((await run(invalid, ctx)).status).toBe('existing-rules')
    expect(invalid.status.enabled).toBe(false)
    expect(ctx.snapshot('manual').permissionFingerprint).toBe('[]')
    await expect(
      invalid.evaluate({ snapshot: context(otherScope).snapshot('conversation'), existingRules: rules(true) })
    ).rejects.toEqual(hasCode('SNAPSHOT_NOT_ISSUED'))
    const beforeStop = ctx.snapshot('conversation')
    ctx.stop()
    await expect(invalid.evaluate({ snapshot: beforeStop, existingRules: rules(true) })).rejects.toEqual(
      hasCode('SESSION_STOPPED')
    )
    await expect(invalid.evaluate({ snapshot: {} as never, existingRules: rules(true) })).rejects.toEqual(
      hasCode('SNAPSHOT_NOT_ISSUED')
    )
    invalid.dispose()
    const active = context()
    const timeout = policyFor(active, { enabled: true, timeoutMs: 15, classify: () => new Promise(() => {}) })
    expect((await run(timeout, active, { existingRules: rules(true) })).status).toBe('existing-rules')
    expect(timeout.status.disabledReason).toBe('classifier-timeout')
    timeout.dispose()
  })

  it('aborts the classifier signal on timeout and on dispose', async () => {
    const ctx = context()
    let signal: AbortSignal | undefined
    const policy = policyFor(ctx, {
      enabled: true,
      timeoutMs: 15,
      classify: (_input, abort) => {
        signal = abort
        return new Promise(() => {})
      }
    })
    await run(policy, ctx)
    expect(signal?.aborted).toBe(true)
    policy.dispose()
    const second = context()
    let secondSignal: AbortSignal | undefined
    const disposing = policyFor(second, {
      enabled: true,
      classify: (_input, abort) => {
        secondSignal = abort
        return new Promise(() => {})
      }
    })
    const pending = run(disposing, second, { existingRules: rules(true) })
    await flush()
    disposing.dispose()
    expect((await pending).status).toBe('stale')
    expect(secondSignal?.aborted).toBe(true)
    await expect(run(disposing, second)).rejects.toEqual(hasCode('INTERVENTION_DISPOSED'))
  })

  it('rejects a malformed existing-rules object and invalid construction', async () => {
    const ctx = context()
    const policy = policyFor(ctx, { enabled: true, classify: async () => scores() })
    await expect(
      policy.evaluate({
        snapshot: ctx.snapshot(),
        existingRules: { shouldGenerate: true, reason: 'x', extra: 1 } as never
      })
    ).rejects.toEqual(hasCode('EXISTING_RULE_SCHEMA'))
    policy.dispose()
    const make = (options: Partial<InterventionPolicyOptions>) => () =>
      new InterventionPolicy(ctx, { classify: async () => scores(), ...options })
    expect(make({ timeoutMs: 0 })).toThrow(hasCode('INTERVENTION_TIMEOUT'))
    expect(make({ stablePartialMs: 6_000 })).toThrow(hasCode('PARTIAL_STABILITY'))
    expect(make({ minIntervalMs: 60_001 })).toThrow(hasCode('INTERVENTION_INTERVAL'))
    expect(make({ thresholds: { question: 0.85 } as never })).toThrow(hasCode('THRESHOLD_SCHEMA'))
    expect(make({ thresholds: { question: 0, objection: 1, hesitation: 1, decision: 1, shortHesitation: 1 } })).toThrow(
      hasCode('THRESHOLD_RANGE')
    )
    expect(() => new InterventionPolicy(ctx, {} as never)).toThrow(InterventionError)
  })

  it('spaces classifier call starts by the minimum interval (1,100 ms default) and holds the rest', async () => {
    const ctx = context()
    let clock = 10_000
    let calls = 0
    const policy = new InterventionPolicy(ctx, {
      enabled: true,
      now: () => clock,
      classify: async () => {
        calls += 1
        return scores()
      }
    })
    expect((await run(policy, ctx)).status).toBe('classified')
    clock += 1_099
    const held = await run(policy, ctx)
    expect(held.status).toBe('held')
    expect(held.reason).toBe('MIN_REQUEST_INTERVAL')
    expect(held.shouldGenerate).toBe(false)
    expect(calls).toBe(1)
    expect(policy.status.enabled).toBe(true)
    clock += 1
    expect((await run(policy, ctx)).status).toBe('classified')
    expect(calls).toBe(2)
    policy.dispose()
  })
})
