import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationInsertRequest, DictationTarget } from '../desktop-contract'
import type { ChordWatcherEvent } from '../../voice/chord-watcher'
import type { DictationInsertionResult, DictationTargetObservation } from './dictation-ports'
import { DictationSession, type DictationSessionDeps } from './dictation-session'

// Synthetic fixtures only: no real application, window or text.
const TEXT = 'synthetic dictated sentence for the guard'
const NOW = 5_000_000

const target = (patch: Partial<DictationTarget> = {}, now = NOW): DictationTarget => ({
  appId: 'com.example.synthetic-editor',
  processInstanceId: 'pid:41',
  windowId: 'window:1',
  elementId: 'element:1',
  focusRevision: 3,
  selectionRevision: 0,
  documentRevision: 'doc:1',
  editable: true,
  secure: false,
  observedAtMs: now,
  ...patch
})

const armed: ChordWatcherEvent = { type: 'armed' }
const latched: ChordWatcherEvent = { type: 'latched' }
const released: ChordWatcherEvent = { type: 'released', reason: 'release' }
const latchEnded: ChordWatcherEvent = { type: 'latch-ended', reason: 'press' }

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function setup(
  over: {
    observations?: DictationTargetObservation[]
    insert?: DictationInsertionResult | ((request: DictationInsertRequest) => Promise<DictationInsertionResult>)
    gate?: Partial<DictationSessionDeps['gate']>
    mint?: boolean
    enabled?: boolean
  } = {}
) {
  const calls = {
    begin: [] as Array<{ turnId: string; maxMs: number; purpose: 'dictation' }>,
    end: [] as Array<{ turnId: string; cancelled: boolean }>,
    stopLease: [] as string[],
    audit: [] as Array<[string, unknown]>,
    drafts: [] as string[],
    mint: 0,
    revoke: 0,
    prewarm: 0
  }
  const queue = [...(over.observations ?? [])]
  const captureTarget = vi.fn(async (): Promise<DictationTargetObservation> => {
    return queue.shift() ?? { kind: 'target', target: target() }
  })
  const insert = vi.fn(async (request: DictationInsertRequest): Promise<DictationInsertionResult> => {
    if (typeof over.insert === 'function') return over.insert(request)
    return over.insert ?? { outcome: 'unsupported' }
  })
  const flags = { enabled: over.enabled ?? true, mint: over.mint ?? true }
  let n = 0
  const deps: DictationSessionDeps = {
    settings: () => ({ enabled: flags.enabled }),
    gate: {
      signedIn: () => true,
      meetingReserved: () => false,
      onboardingActive: () => false,
      windowVisible: () => true,
      captureBusy: () => false,
      availability: () => ({ ok: true }),
      ...over.gate
    },
    activation: {
      mint: () => {
        calls.mint++
        return flags.mint
      },
      revoke: () => {
        calls.revoke++
      }
    },
    stopLease: (reason) => calls.stopLease.push(reason),
    speech: {
      prewarm: async () => {
        calls.prewarm++
      }
    },
    ports: { target: { captureTarget }, insertion: { insert } },
    push: {
      begin: (payload) => calls.begin.push(payload),
      end: (payload) => calls.end.push(payload)
    },
    newTurnId: () => `turn-${++n}`,
    now: () => NOW,
    audit: (phase, detail) => calls.audit.push([phase, detail]),
    onDraftPreserved: (draft) => calls.drafts.push(draft.text)
  }
  const session = new DictationSession(deps)
  session.refresh()
  return { session, calls, captureTarget, insert, flags }
}

/** Drives a normal turn up to the sealed state, returning the turn id. */
async function listenAndRelease(ctx: ReturnType<typeof setup>): Promise<string> {
  ctx.session.onChordEvent(armed)
  await flush()
  const turnId = ctx.calls.begin.at(-1)?.turnId
  if (!turnId) throw new Error('turn did not begin')
  ctx.session.report({ turnId, phase: 'capturing' })
  ctx.session.onChordEvent(released)
  return turnId
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DictationSession: activation (G22)', () => {
  it('a held chord binds the target through the guard, mints once and asks the renderer for a dictation capture', async () => {
    const ctx = setup()
    ctx.session.onChordEvent(armed)
    await flush()
    expect(ctx.captureTarget).toHaveBeenCalledTimes(1)
    expect(ctx.calls.mint).toBe(1)
    expect(ctx.calls.begin).toEqual([{ turnId: 'turn-1', maxMs: 15_000, purpose: 'dictation' }])
    expect(ctx.calls.prewarm).toBe(1)
    expect(ctx.session.snapshot().state).toBe('listening')
    expect(ctx.session.active()).toBe(true)
  })

  it('a double-tap latch starts the same way and its end finishes the turn once', async () => {
    const ctx = setup()
    ctx.session.onChordEvent(latched)
    await flush()
    expect(ctx.calls.begin).toHaveLength(1)
    ctx.session.onChordEvent(latchEnded)
    expect(ctx.calls.end).toEqual([{ turnId: 'turn-1', cancelled: false }])
    expect(ctx.session.snapshot().state).toBe('thinking')
  })

  it.each([
    ['feature off', { enabled: false }],
    ['signed out', { gate: { signedIn: () => false } }],
    ['a meeting is recording', { gate: { meetingReserved: () => true } }],
    ['onboarding is exclusive', { gate: { onboardingActive: () => true } }],
    ['the window is hidden', { gate: { windowVisible: () => false } }],
    ['another capture owns the microphone', { gate: { captureBusy: () => true } }],
    [
      'speech is unavailable',
      { gate: { availability: () => ({ ok: false as const, reason: 'unsupported_engine' as const }) } }
    ]
  ])('refuses without capturing the target, minting or opening a microphone: %s', async (_name, over) => {
    const ctx = setup(over as never)
    ctx.session.onChordEvent(armed)
    await flush()
    expect(ctx.captureTarget).not.toHaveBeenCalled()
    expect(ctx.calls.mint).toBe(0)
    expect(ctx.calls.begin).toEqual([])
    expect(ctx.session.active()).toBe(false)
  })

  it('names the reason when a meeting is recording', async () => {
    const ctx = setup({ gate: { meetingReserved: () => true } })
    ctx.session.onChordEvent(armed)
    await flush()
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'meeting_recording' })
  })

  it('the watcher refusing a hold during a meeting is explained and opens nothing', async () => {
    const ctx = setup()
    ctx.session.onChordEvent({ type: 'refused', reason: 'meeting' })
    await flush()
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'meeting_recording' })
    expect(ctx.calls.begin).toEqual([])
    expect(ctx.captureTarget).not.toHaveBeenCalled()
  })

  it.each([
    [{ kind: 'unavailable', reason: 'unsupported' }, 'target_unsupported'],
    [{ kind: 'unavailable', reason: 'no_focus' }, 'no_target'],
    [{ kind: 'unavailable', reason: 'secure_field' }, 'secure_field'],
    [{ kind: 'unavailable', reason: 'permission' }, 'permission_needed'],
    [{ kind: 'target', target: target({ secure: true }) }, 'secure_field'],
    [{ kind: 'target', target: target({ editable: false }) }, 'target_not_editable'],
    [{ kind: 'target', target: target({}, NOW - 60_000) }, 'no_target']
  ] as Array<
    [DictationTargetObservation, string]
  >)('never opens the microphone when no editable, non-secure, fresh target can be bound (%j)', async (observation, reason) => {
    const ctx = setup({ observations: [observation] })
    ctx.session.onChordEvent(armed)
    await flush()
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason })
    expect(ctx.calls.mint).toBe(0)
    expect(ctx.calls.begin).toEqual([])
  })

  it('a failed activation mint leaves nothing bound and nothing listening', async () => {
    const ctx = setup({ mint: false })
    ctx.session.onChordEvent(armed)
    await flush()
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'not_ready' })
    expect(ctx.calls.begin).toEqual([])
    // The bound target was cancelled, so a later hold can bind a new one.
    ctx.flags.mint = true
    ctx.session.onChordEvent(armed)
    await flush()
    expect(ctx.calls.begin).toHaveLength(1)
  })

  it('a second hold while listening is ignored; while thinking it is refused as busy', async () => {
    const ctx = setup()
    await listenAndRelease(ctx)
    ctx.session.onChordEvent(armed)
    await flush()
    expect(ctx.calls.begin).toHaveLength(1)
    expect(ctx.calls.audit).toContainEqual(['refused', { reason: 'busy' }])
    // The first turn is untouched: it is still being recognized and can still finish.
    expect(ctx.session.snapshot().state).toBe('thinking')
    expect(ctx.session.active()).toBe(true)
  })

  it('a duplicate arm while listening opens exactly one capture', async () => {
    const ctx = setup()
    ctx.session.onChordEvent(armed)
    await flush()
    ctx.session.onChordEvent(armed)
    ctx.session.onChordEvent(latched)
    await flush()
    expect(ctx.calls.begin).toHaveLength(1)
    expect(ctx.calls.mint).toBe(1)
  })
})

describe('DictationSession: idempotent stop (G22)', () => {
  it('a double stop seals the capture once', async () => {
    const ctx = setup()
    await listenAndRelease(ctx)
    ctx.session.onChordEvent(released)
    ctx.session.onChordEvent(latchEnded)
    expect(ctx.calls.end).toEqual([{ turnId: 'turn-1', cancelled: false }])
  })

  it('a stop with no turn is a no-op', () => {
    const ctx = setup()
    ctx.session.onChordEvent(released)
    ctx.session.onChordEvent(latchEnded)
    expect(ctx.calls.end).toEqual([])
    expect(ctx.session.snapshot().state).toBe('idle')
  })

  it('a stop during start (target capture still pending) opens no microphone, mints nothing and binds nothing', async () => {
    const ctx = setup()
    let resolve!: (value: DictationTargetObservation) => void
    ctx.captureTarget.mockImplementationOnce(
      () =>
        new Promise<DictationTargetObservation>((r) => {
          resolve = r
        })
    )
    ctx.session.onChordEvent(armed)
    await flush()
    expect(ctx.session.snapshot().state).toBe('starting')
    ctx.session.onChordEvent(released)
    ctx.session.onChordEvent(released)
    resolve({ kind: 'target', target: target() })
    await flush()
    expect(ctx.calls.mint).toBe(0)
    expect(ctx.calls.begin).toEqual([])
    expect(ctx.session.active()).toBe(false)
    expect(ctx.session.snapshot().state).toBe('idle')
  })

  it('an abort during start is silent and the late target is discarded', async () => {
    const ctx = setup()
    let resolve!: (value: DictationTargetObservation) => void
    ctx.captureTarget.mockImplementationOnce(
      () =>
        new Promise<DictationTargetObservation>((r) => {
          resolve = r
        })
    )
    ctx.session.onChordEvent(armed)
    await flush()
    ctx.session.onChordEvent({ type: 'aborted', reason: 'other-input' })
    resolve({ kind: 'target', target: target() })
    await flush()
    expect(ctx.calls.begin).toEqual([])
    expect(ctx.session.snapshot().state).toBe('idle')
  })

  it('a stop after a revocation is safe and changes nothing', async () => {
    const ctx = setup()
    ctx.session.onChordEvent(armed)
    await flush()
    ctx.session.onHardStop('sign-out')
    const ended = ctx.calls.end.length
    ctx.session.onChordEvent(released)
    ctx.session.onChordEvent(latchEnded)
    ctx.session.onHardStop('sign-out')
    expect(ctx.calls.end).toHaveLength(ended)
    expect(ctx.session.active()).toBe(false)
  })

  it('a transcript arriving after a revocation is dropped and nothing is inserted', async () => {
    const ctx = setup({ insert: { outcome: 'unsupported' } })
    await listenAndRelease(ctx)
    ctx.session.onHardStop('screen-locked')
    ctx.session.onTranscript(TEXT)
    await flush()
    expect(ctx.insert).not.toHaveBeenCalled()
  })

  it('the same transcript delivered twice is inserted at most once', async () => {
    const ctx = setup({ insert: { outcome: 'no_effect', evidenceId: 'port:synthetic' } })
    await listenAndRelease(ctx)
    ctx.session.onTranscript(TEXT)
    ctx.session.onTranscript(TEXT)
    await flush()
    expect(ctx.insert).toHaveBeenCalledTimes(1)
  })

  it('a transcript with no sealed turn is dropped', async () => {
    const ctx = setup()
    ctx.session.onTranscript(TEXT)
    await flush()
    expect(ctx.insert).not.toHaveBeenCalled()
  })
})

describe('DictationSession: revocation and failure (G22)', () => {
  it.each([
    ['sign-out', 'session_ended'],
    ['screen-locked', 'screen_locked'],
    ['system-suspend', 'system_suspend'],
    ['renderer-reset', 'renderer_reset']
  ] as const)('a hard stop (%s) ends a listening turn, stops the lease and revokes the activation', async (stop, reason) => {
    const ctx = setup()
    ctx.session.onChordEvent(armed)
    await flush()
    ctx.session.onHardStop(stop)
    expect(ctx.calls.end).toEqual([{ turnId: 'turn-1', cancelled: true }])
    expect(ctx.calls.stopLease).toHaveLength(1)
    expect(ctx.calls.revoke).toBeGreaterThan(0)
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason })
  })

  it('a meeting starting ends the turn', async () => {
    const ctx = setup()
    ctx.session.onChordEvent(armed)
    await flush()
    ctx.session.onMeetingReserved()
    expect(ctx.calls.end).toEqual([{ turnId: 'turn-1', cancelled: true }])
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'meeting_started' })
  })

  it('another key or modifier during the hold cancels silently', async () => {
    const ctx = setup()
    ctx.session.onChordEvent(armed)
    await flush()
    ctx.session.onChordEvent({ type: 'aborted', reason: 'other-input' })
    expect(ctx.calls.end).toEqual([{ turnId: 'turn-1', cancelled: true }])
    expect(ctx.session.snapshot()).toMatchObject({ state: 'idle', reason: null })
  })

  it('turning the feature off ends the turn', async () => {
    const ctx = setup()
    ctx.session.onChordEvent(armed)
    await flush()
    ctx.flags.enabled = false
    ctx.session.refresh()
    expect(ctx.session.active()).toBe(false)
    expect(ctx.session.snapshot().state).toBe('off')
  })

  it('a microphone failure reported by the renderer cancels the turn; a stale turn id is ignored', async () => {
    const ctx = setup()
    ctx.session.onChordEvent(armed)
    await flush()
    ctx.session.report({ turnId: 'turn-0', phase: 'failed', reason: 'microphone_unavailable' })
    expect(ctx.session.active()).toBe(true)
    ctx.session.report({ turnId: 'turn-1', phase: 'failed', reason: 'microphone_unavailable' })
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'microphone_unavailable' })
  })

  it('a capture that never starts is cancelled by the watchdog', async () => {
    const ctx = setup()
    ctx.session.onChordEvent(armed)
    await flush()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'microphone_unavailable' })
  })

  it('the 15 second cap seals a turn that is still listening', async () => {
    const ctx = setup()
    ctx.session.onChordEvent(armed)
    await flush()
    ctx.session.report({ turnId: 'turn-1', phase: 'capturing' })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(ctx.calls.end).toEqual([{ turnId: 'turn-1', cancelled: false }])
  })

  it('a recognition failure ends the sealed turn with its reason', async () => {
    const ctx = setup()
    await listenAndRelease(ctx)
    ctx.session.onSpeechFinished({ ok: false, reason: 'no_speech' })
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'no_speech' })
    expect(ctx.session.active()).toBe(false)
    expect(ctx.calls.revoke).toBeGreaterThan(0)
  })
})

describe('DictationSession: the recognized text and the typed insertion port (G22)', () => {
  it('hands the text and the bound target to the insertion port exactly once, and a matching receipt verifies it', async () => {
    const ctx = setup({
      insert: async (request) => ({
        outcome: 'verified',
        evidenceId: 'port:synthetic',
        receipt: {
          operationId: request.args.operationId,
          argsHash: request.argsHash,
          targetFingerprint: request.args.targetFingerprint,
          textHash: request.args.textHash
        }
      })
    })
    await listenAndRelease(ctx)
    ctx.session.onTranscript(TEXT)
    await flush()
    expect(ctx.insert).toHaveBeenCalledTimes(1)
    const request = ctx.insert.mock.calls[0]![0]
    expect(request.kind).toBe('dictation.insert')
    expect(request.args.text).toBe(TEXT)
    expect(request.args.target).toMatchObject({ appId: 'com.example.synthetic-editor', elementId: 'element:1' })
    expect(request.args.operationId).toMatch(/^dictation:/)
    expect(ctx.session.snapshot()).toMatchObject({ state: 'done', reason: null })
    expect(ctx.session.active()).toBe(false)
    // A verified insertion leaves nothing to recover.
    ctx.session.dispose()
    expect(ctx.session.priorDrafts()).toEqual([])
  })

  it('production returns unsupported: the draft is kept, the person is told, nothing is reported as inserted', async () => {
    const ctx = setup({ insert: { outcome: 'unsupported' } })
    await listenAndRelease(ctx)
    ctx.session.onTranscript(TEXT)
    await flush()
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'insertion_unsupported' })
    expect(ctx.session.active()).toBe(false)
    // The draft survives the next activation (G07: begin never drops the prior draft).
    ctx.session.onChordEvent(armed)
    await flush()
    expect(ctx.session.priorDrafts().map((d) => d.text)).toEqual([TEXT])
    expect(ctx.calls.drafts).toEqual([TEXT])
  })

  it('a verified receipt that does not match the bound target is not a verified insertion', async () => {
    const ctx = setup({
      insert: {
        outcome: 'verified',
        evidenceId: 'port:synthetic',
        receipt: { operationId: 'dictation:1', argsHash: 'x', targetFingerprint: 'y', textHash: 'z' }
      }
    })
    await listenAndRelease(ctx)
    ctx.session.onTranscript(TEXT)
    await flush()
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'insertion_failed' })
  })

  it('focus moved to another field before insertion: nothing is inserted and the draft is kept', async () => {
    const ctx = setup({
      observations: [
        { kind: 'target', target: target() },
        { kind: 'target', target: target({ elementId: 'element:2' }) }
      ]
    })
    await listenAndRelease(ctx)
    ctx.session.onTranscript(TEXT)
    await flush()
    expect(ctx.insert).not.toHaveBeenCalled()
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'target_changed' })
    ctx.session.dispose()
    expect(ctx.session.priorDrafts().map((d) => d.text)).toEqual([TEXT])
  })

  it('a secure field at insertion time inserts nothing and keeps the draft', async () => {
    const ctx = setup({
      observations: [
        { kind: 'target', target: target() },
        { kind: 'unavailable', reason: 'secure_field' }
      ]
    })
    await listenAndRelease(ctx)
    ctx.session.onTranscript(TEXT)
    await flush()
    expect(ctx.insert).not.toHaveBeenCalled()
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'secure_field' })
    ctx.session.dispose()
    expect(ctx.session.priorDrafts().map((d) => d.text)).toEqual([TEXT])
  })

  it('a port that throws leaves the outcome uncertain and never retries', async () => {
    const ctx = setup({
      insert: async () => {
        throw new Error('synthetic native failure')
      }
    })
    await listenAndRelease(ctx)
    ctx.session.onTranscript(TEXT)
    await flush()
    expect(ctx.insert).toHaveBeenCalledTimes(1)
    expect(ctx.session.snapshot()).toMatchObject({ state: 'failed', reason: 'insertion_failed' })
  })

  it('the text never reaches the audit trail or a state snapshot', async () => {
    const ctx = setup({ insert: { outcome: 'unsupported' } })
    await listenAndRelease(ctx)
    ctx.session.onTranscript(TEXT)
    await flush()
    const everything = JSON.stringify([ctx.calls.audit, ctx.session.snapshot(), ctx.calls.begin, ctx.calls.end])
    expect(everything).not.toContain(TEXT)
    expect(everything).not.toContain('synthetic dictated')
  })
})
