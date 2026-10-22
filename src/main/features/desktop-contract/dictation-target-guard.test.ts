import { describe, expect, it } from 'vitest'
import { FixtureSessionContext } from '../../../test-helpers/desktop-contract-context'
import {
  type DictationActor,
  type DictationInsertRequest,
  type DictationTarget,
  DictationTargetGuard,
  MAX_PRIOR_DRAFTS,
  type PriorDraft
} from './dictation-target-guard'

const actor: DictationActor = { tenantId: 'mantu', userId: 'tony', sessionId: 'dictation-1' }

function throwsCode(fn: () => unknown, code: string): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught, `expected ${code}`).toBeDefined()
  expect((caught as { code?: string }).code).toBe(code)
}

function fixture(options: { onDraftPreserved?: (draft: PriorDraft) => void } = {}) {
  let clock = 1_000
  const context = new FixtureSessionContext({ scope: actor, permissions: ['dictation.insert'] })
  const guard = new DictationTargetGuard(context, { now: () => clock, ...options })
  const target = (overrides: Partial<DictationTarget> = {}): DictationTarget => ({
    appId: 'com.example.editor',
    processInstanceId: 'pid-10-start-900',
    windowId: 'window-4',
    elementId: 'editor-1',
    focusRevision: 7,
    selectionRevision: 3,
    documentRevision: 'document-v12',
    editable: true,
    secure: false,
    observedAtMs: clock,
    ...overrides
  })
  const begin = (overrides: Record<string, unknown> = {}) =>
    guard.begin({ actor, target: target(), activation: 'dictation-shortcut', mode: 'hold', ...overrides })
  function ready(text = 'Prepare the Montréal project update.') {
    const lease = begin()
    guard.revise(lease, { actor, revision: 1, text })
    const request = guard.prepare(lease, { actor, currentTarget: target() })
    return { lease, request }
  }
  const receipt = (request: DictationInsertRequest, overrides: Record<string, unknown> = {}) => ({
    operationId: request.args.operationId,
    argsHash: request.argsHash,
    targetFingerprint: request.args.targetFingerprint,
    textHash: request.args.textHash,
    ...overrides
  })
  return {
    context,
    guard,
    target,
    begin,
    ready,
    receipt,
    advance: (amount: number) => {
      clock += amount
    }
  }
}

describe('DictationTargetGuard (ported reference contract)', () => {
  it('dictation produces a bounded immutable proposal and a matching observed result', () => {
    const f = fixture()
    const { request } = f.ready()
    expect(request.kind).toBe('dictation.insert')
    expect(Object.isFrozen(request.args)).toBe(true)
    const args = f.guard.takeForDispatch(request, { actor, currentTarget: f.target() })
    expect(args.text).toBe('Prepare the Montréal project update.')
    const outcome = f.guard.settle(request, {
      actor,
      outcome: 'verified',
      receipt: f.receipt(request),
      evidenceId: 'native:readback-1'
    })
    expect(outcome.state).toBe('verified')
  })

  it('meeting audio and assistant speech cannot activate the dictation contract', () => {
    const f = fixture()
    throwsCode(() => f.begin({ activation: 'meeting-audio' }), 'DICTATION_ACTIVATION')
    throwsCode(() => f.begin({ activation: 'assistant-speech' }), 'DICTATION_ACTIVATION')
  })

  it('a foreign user cannot start a dictation in another user context', () => {
    const f = fixture()
    throwsCode(() => f.begin({ actor: { ...actor, userId: 'other' } }), 'SCOPE_MISMATCH')
  })

  it('secure and non-editable targets are refused before any transcript can be inserted', () => {
    const f = fixture()
    throwsCode(() => f.begin({ target: f.target({ secure: true }) }), 'TARGET_NOT_ALLOWED')
    throwsCode(() => f.begin({ target: f.target({ editable: false }) }), 'TARGET_NOT_ALLOWED')
  })

  it('stale target observations cannot authorize insertion', () => {
    const f = fixture()
    const observed = f.target()
    f.advance(2_001)
    throwsCode(() => f.begin({ target: observed }), 'TARGET_STALE')
  })

  it('ASR corrections replace the draft and reject revision collisions or regressions', () => {
    const f = fixture()
    const lease = f.begin()
    f.guard.revise(lease, { actor, revision: 1, text: 'Client count is fifty.' })
    f.guard.revise(lease, { actor, revision: 2, text: 'Client count is fifteen.' })
    expect(f.guard.inspect()?.text).toBe('Client count is fifteen.')
    expect(f.guard.revise(lease, { actor, revision: 2, text: 'Client count is fifteen.' })).toBe(false)
    throwsCode(
      () => f.guard.revise(lease, { actor, revision: 2, text: 'Different text' }),
      'TRANSCRIPT_REVISION_COLLISION'
    )
    throwsCode(() => f.guard.revise(lease, { actor, revision: 1, text: 'Old text' }), 'TRANSCRIPT_REGRESSION')
  })

  it('focus moves to another app while transcription runs: preserve draft and refuse insertion', () => {
    const f = fixture()
    const lease = f.begin()
    f.guard.revise(lease, { actor, revision: 1, text: 'Private draft' })
    throwsCode(
      () => f.guard.prepare(lease, { actor, currentTarget: f.target({ appId: 'com.example.chat' }) }),
      'DICTATION_TARGET_CHANGED'
    )
    expect(f.guard.inspect()?.state).toBe('review')
    expect(f.guard.inspect()?.text).toBe('Private draft')
  })

  it('same app name and window ID cannot hide a restarted process', () => {
    const f = fixture()
    const { request } = f.ready()
    throwsCode(
      () =>
        f.guard.takeForDispatch(request, {
          actor,
          currentTarget: f.target({ processInstanceId: 'pid-10-start-1500' })
        }),
      'DICTATION_TARGET_CHANGED'
    )
  })

  it('a changed selection or document invalidates even an unchanged focused element', () => {
    for (const changed of [{ selectionRevision: 4 }, { documentRevision: 'document-v13' }, { focusRevision: 8 }]) {
      const f = fixture()
      const { request } = f.ready()
      throwsCode(
        () => f.guard.takeForDispatch(request, { actor, currentTarget: f.target(changed) }),
        'DICTATION_TARGET_CHANGED'
      )
    }
  })

  it('a copied request cannot be used as an insertion capability', () => {
    const f = fixture()
    const { request } = f.ready()
    throwsCode(
      () =>
        f.guard.takeForDispatch(JSON.parse(JSON.stringify(request)) as DictationInsertRequest, {
          actor,
          currentTarget: f.target()
        }),
      'INSERTION_NOT_ISSUED'
    )
  })

  it('the same prepared insertion is consumed once even before a native result arrives', () => {
    const f = fixture()
    const { request } = f.ready()
    f.guard.takeForDispatch(request, { actor, currentTarget: f.target() })
    throwsCode(() => f.guard.takeForDispatch(request, { actor, currentTarget: f.target() }), 'INSERTION_CONSUMED')
  })

  it('cancellation before dispatch retains the text and denies the stale request', () => {
    const f = fixture()
    const { lease, request } = f.ready()
    f.guard.cancel()
    expect(lease.signal.aborted).toBe(true)
    expect(f.guard.inspect()?.state).toBe('review')
    throwsCode(() => f.guard.takeForDispatch(request, { actor, currentTarget: f.target() }), 'DICTATION_REVOKED')
  })

  it('cancellation after dispatch is uncertain; automatic retry/new dictation is blocked', () => {
    const f = fixture()
    const { request } = f.ready()
    f.guard.takeForDispatch(request, { actor, currentTarget: f.target() })
    f.guard.cancel()
    expect(f.guard.inspect()?.state).toBe('uncertain')
    throwsCode(() => f.begin(), 'INSERTION_RECONCILIATION_REQUIRED')
    throwsCode(
      () =>
        f.guard.settle(request, {
          actor,
          outcome: 'verified',
          receipt: f.receipt(request),
          evidenceId: 'late:receipt'
        }),
      'INSERTION_RECONCILIATION_REQUIRED'
    )
    f.guard.reconcile({
      actor,
      operationId: request.args.operationId,
      outcome: 'no_effect',
      evidenceId: 'native:absent'
    })
    expect(f.guard.inspect()?.state).toBe('no_effect')
    expect(() => f.begin()).not.toThrow()
  })

  it('logout/permission invalidation aborts dictation and cannot be undone by restoring permission', () => {
    const f = fixture()
    const { lease, request } = f.ready()
    f.context.setPermissions([])
    f.context.setPermissions(['dictation.insert'])
    expect(lease.signal.aborted).toBe(true)
    expect(() => f.guard.takeForDispatch(request, { actor, currentTarget: f.target() })).toThrow()
  })

  it('a receipt for another text or another target is uncertain rather than successful', () => {
    const f = fixture()
    const { request } = f.ready()
    f.guard.takeForDispatch(request, { actor, currentTarget: f.target() })
    const outcome = f.guard.settle(request, {
      actor,
      outcome: 'verified',
      receipt: f.receipt(request, { textHash: 'wrong' }),
      evidenceId: 'native:mismatch'
    })
    expect(outcome.state).toBe('uncertain')
    throwsCode(() => f.begin(), 'INSERTION_RECONCILIATION_REQUIRED')
  })

  it('denied native insertion preserves the corrected transcript for explicit user recovery', () => {
    const f = fixture()
    const { request } = f.ready('Bonjour, São Paulo.')
    f.guard.takeForDispatch(request, { actor, currentTarget: f.target() })
    const outcome = f.guard.settle(request, { actor, outcome: 'no_effect', evidenceId: 'native:compare-failed' })
    expect(outcome.text).toBe('Bonjour, São Paulo.')
    expect(outcome.state).toBe('no_effect')
  })

  it('empty text and UTF-8 text beyond the byte limit cannot prepare an insertion', () => {
    const f = fixture()
    const lease = f.begin()
    f.guard.revise(lease, { actor, revision: 1, text: '   ' })
    throwsCode(() => f.guard.prepare(lease, { actor, currentTarget: f.target() }), 'DICTATION_STATE')
    throwsCode(() => f.guard.revise(lease, { actor, revision: 2, text: '😀'.repeat(9_000) }), 'DICTATION_TEXT')
  })

  it('a new explicit activation supersedes a prior draft without inserting either draft', () => {
    const f = fixture()
    const old = f.begin()
    f.guard.revise(old, { actor, revision: 1, text: 'Old draft' })
    const current = f.begin({ mode: 'handsfree' })
    expect(old.signal.aborted).toBe(true)
    expect(f.guard.inspect()?.text).toBe('')
    throwsCode(() => f.guard.revise(old, { actor, revision: 2, text: 'Late final' }), 'DICTATION_NOT_CURRENT')
    expect(current.mode).toBe('handsfree')
  })
})

describe('DictationTargetGuard prior draft preservation (G07 fix)', () => {
  it('begin keeps the superseded draft instead of dropping it', () => {
    const f = fixture()
    const old = f.begin()
    f.guard.revise(old, { actor, revision: 3, text: 'Old draft the user has not inserted' })
    f.begin({ mode: 'handsfree' })
    expect(f.guard.inspect()?.text).toBe('')
    const drafts = f.guard.priorDrafts({ actor })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      operationId: old.id,
      text: 'Old draft the user has not inserted',
      transcriptRevision: 3,
      state: 'review',
      reason: 'superseded'
    })
    expect(Object.isFrozen(drafts[0])).toBe(true)
  })

  it('keeps a draft whose native insertion was denied when a new dictation starts', () => {
    const f = fixture()
    const { request } = f.ready('Bonjour, São Paulo.')
    f.guard.takeForDispatch(request, { actor, currentTarget: f.target() })
    f.guard.settle(request, { actor, outcome: 'no_effect', evidenceId: 'native:compare-failed' })
    f.begin()
    expect(f.guard.priorDrafts({ actor }).map((draft) => [draft.text, draft.state])).toEqual([
      ['Bonjour, São Paulo.', 'no_effect']
    ])
  })

  it('does not keep a verified insertion or an empty listening session', () => {
    const f = fixture()
    const { request } = f.ready()
    f.guard.takeForDispatch(request, { actor, currentTarget: f.target() })
    f.guard.settle(request, { actor, outcome: 'verified', receipt: f.receipt(request), evidenceId: 'native:ok' })
    f.begin()
    f.begin()
    expect(f.guard.priorDrafts({ actor })).toEqual([])
  })

  it('a refused begin does not lose or move the current draft', () => {
    const f = fixture()
    const lease = f.begin()
    f.guard.revise(lease, { actor, revision: 1, text: 'Keep me' })
    throwsCode(() => f.begin({ target: f.target({ secure: true }) }), 'TARGET_NOT_ALLOWED')
    expect(f.guard.inspect()?.text).toBe('Keep me')
    expect(f.guard.priorDrafts({ actor })).toEqual([])
    expect(lease.signal.aborted).toBe(false)
  })

  it('hands each preserved draft to the host sink and survives a throwing sink', () => {
    const seen: PriorDraft[] = []
    const f = fixture({
      onDraftPreserved: (draft) => {
        seen.push(draft)
        throw new Error('disk full')
      }
    })
    const lease = f.begin()
    f.guard.revise(lease, { actor, revision: 1, text: 'Persist this' })
    expect(() => f.begin()).not.toThrow()
    expect(seen.map((draft) => draft.text)).toEqual(['Persist this'])
    expect(f.guard.priorDrafts({ actor })).toHaveLength(1)
  })

  it('dispose preserves the live draft and drafts stay readable afterwards', () => {
    const f = fixture()
    const lease = f.begin()
    f.guard.revise(lease, { actor, revision: 1, text: 'Unsent at shutdown' })
    f.guard.dispose()
    const drafts = f.guard.priorDrafts({ actor })
    expect(drafts.map((draft) => [draft.text, draft.reason])).toEqual([['Unsent at shutdown', 'dispose']])
    throwsCode(() => f.begin(), 'DICTATION_DISPOSED')
  })

  it('priorDrafts and discard require the owning actor and discard is explicit', () => {
    const f = fixture()
    const lease = f.begin()
    f.guard.revise(lease, { actor, revision: 1, text: 'Mine' })
    f.begin()
    throwsCode(() => f.guard.priorDrafts({ actor: { ...actor, userId: 'other' } }), 'SCOPE_MISMATCH')
    expect(f.guard.discardPriorDraft({ actor, operationId: 'dictation:999' })).toBe(false)
    expect(f.guard.discardPriorDraft({ actor, operationId: lease.id })).toBe(true)
    expect(f.guard.priorDrafts({ actor })).toEqual([])
  })

  it('bounds retained drafts and evicts the oldest first', () => {
    const f = fixture()
    for (let index = 0; index < MAX_PRIOR_DRAFTS + 2; index += 1) {
      const lease = f.begin()
      f.guard.revise(lease, { actor, revision: 1, text: `draft ${index}` })
    }
    f.begin()
    const texts = f.guard.priorDrafts({ actor }).map((draft) => draft.text)
    expect(texts).toHaveLength(MAX_PRIOR_DRAFTS)
    expect(texts[0]).toBe('draft 2')
    expect(texts.at(-1)).toBe(`draft ${MAX_PRIOR_DRAFTS + 1}`)
  })

  it('a preserved draft grants no insertion authority', () => {
    const f = fixture()
    const old = f.ready()
    f.begin()
    throwsCode(() => f.guard.takeForDispatch(old.request, { actor, currentTarget: f.target() }), 'INSERTION_NOT_ISSUED')
  })
})
