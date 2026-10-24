import { describe, expect, it, vi } from 'vitest'
import type { LiveTranslationTarget } from '@shared/live-translation'
import {
  TRANSLATION_MAX_PENDING,
  createTranslationChannels,
  type TranslateOutcome,
  type TranslateRequest,
  type TranslationLogCode,
  type TranslationUtterance
} from './translation-channel'

const FRAME = { processId: 4, routingId: 2 }
const STARTED = 1_700_000_000_000
const SCOPE = { tenantId: 't1', userId: 'u1', sessionId: 's1' }

interface Call {
  request: TranslateRequest
  signal: AbortSignal
  resolve(outcome: TranslateOutcome): void
}

function setup(initial: LiveTranslationTarget = 'en') {
  const target = { current: initial }
  const calls: Call[] = []
  const pushes: Array<{ kind: string; payload: Record<string, unknown> }> = []
  const logs: TranslationLogCode[] = []
  const channels = createTranslationChannels({
    readTarget: () => target.current,
    translate: (request, signal) =>
      new Promise<TranslateOutcome>((resolve) => {
        calls.push({ request, signal, resolve })
      }),
    push: {
      segment: (_f, payload) => pushes.push({ kind: 'segment', payload: { ...payload } }),
      retract: (_f, payload) => pushes.push({ kind: 'retract', payload: { ...payload } }),
      reset: (_f, payload) => pushes.push({ kind: 'reset', payload: { ...payload } }),
      status: (_f, payload) => pushes.push({ kind: 'status', payload: { ...payload } })
    },
    log: (code) => logs.push(code)
  })
  const say = (u: Partial<TranslationUtterance> & { utteranceId: string }, scope = SCOPE): void =>
    channels.onUtterance(FRAME, STARTED, {
      scope,
      revision: 1,
      state: 'final',
      text: `source ${u.utteranceId}`,
      ...u
    })
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }
  const ok = (text = 'translated'): TranslateOutcome => ({ kind: 'ok', text, lowConfidence: false })
  return { target, calls, pushes, logs, channels, say, flush, ok }
}

describe('translation channel (G73)', () => {
  it('translates a final once, bound to utteranceId and revision', async () => {
    const t = setup()
    t.say({ utteranceId: 'u1', revision: 3, lang: 'fr' })
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].request).toMatchObject({ utteranceId: 'u1', revision: 3, lang: 'fr', target: 'en' })
    t.calls[0].resolve({ kind: 'ok', text: 'Hello', lowConfidence: true })
    await t.flush()
    expect(t.pushes).toEqual([
      {
        kind: 'segment',
        payload: {
          meetingStartedAt: STARTED,
          utteranceId: 'u1',
          revision: 3,
          target: 'en',
          text: 'Hello',
          lowConfidence: true
        }
      }
    ])
  })

  it('drops a result whose utterance was corrected while in flight', async () => {
    const t = setup()
    t.say({ utteranceId: 'u1', revision: 1 })
    t.say({ utteranceId: 'u1', revision: 2, text: 'corrected' })
    t.calls[0].resolve(t.ok('old translation'))
    await t.flush()
    expect(t.pushes.filter((p) => p.kind === 'segment')).toHaveLength(0)
    expect(t.logs).toContain('translation.stale_dropped')
    expect(t.calls).toHaveLength(2)
    expect(t.calls[1].request).toMatchObject({ revision: 2, text: 'corrected' })
    t.calls[1].resolve(t.ok('new translation'))
    await t.flush()
    expect(t.pushes).toHaveLength(1)
    expect(t.pushes[0].payload).toMatchObject({ revision: 2, text: 'new translation' })
  })

  it('correction after delivery retracts and retranslates the new revision', async () => {
    const t = setup()
    t.say({ utteranceId: 'u1', revision: 1 })
    t.calls[0].resolve(t.ok('first'))
    await t.flush()
    t.say({ utteranceId: 'u1', revision: 2 })
    expect(t.pushes.map((p) => p.kind)).toEqual(['segment', 'retract'])
    expect(t.pushes[1].payload).toMatchObject({ utteranceIds: ['u1'] })
    t.calls[1].resolve(t.ok('second'))
    await t.flush()
    expect(t.pushes.map((p) => p.kind)).toEqual(['segment', 'retract', 'segment'])
    expect(t.pushes[2].payload).toMatchObject({ revision: 2, text: 'second' })
  })

  it('retraction withdraws and does not retranslate', async () => {
    const t = setup()
    t.say({ utteranceId: 'u1', revision: 1 })
    t.calls[0].resolve(t.ok())
    await t.flush()
    t.say({ utteranceId: 'u1', revision: 2, state: 'retracted', text: '' })
    expect(t.pushes.map((p) => p.kind)).toEqual(['segment', 'retract'])
    expect(t.calls).toHaveLength(1)
  })

  it('a retraction while in flight drops the pending result', async () => {
    const t = setup()
    t.say({ utteranceId: 'u1', revision: 1 })
    t.say({ utteranceId: 'u1', revision: 2, state: 'retracted', text: '' })
    t.calls[0].resolve(t.ok())
    await t.flush()
    expect(t.pushes).toHaveLength(0)
  })

  it('duplicate or older revision makes one call', () => {
    const t = setup()
    t.say({ utteranceId: 'u1', revision: 2 })
    t.say({ utteranceId: 'u1', revision: 2 })
    t.say({ utteranceId: 'u1', revision: 1 })
    expect(t.calls).toHaveLength(1)
  })

  it('target change aborts in flight, resets, keeps earlier lines and translates later finals only', async () => {
    const t = setup('en')
    t.say({ utteranceId: 'u1' })
    const first = t.calls[0]
    t.target.current = 'fr'
    t.say({ utteranceId: 'u2' })
    expect(first.signal.aborted).toBe(true)
    expect(t.pushes).toEqual([{ kind: 'reset', payload: { meetingStartedAt: STARTED, target: 'fr' } }])
    first.resolve(t.ok('late english'))
    await t.flush()
    expect(t.pushes.filter((p) => p.kind === 'segment')).toHaveLength(0)
    expect(t.calls).toHaveLength(2)
    expect(t.calls[1].request).toMatchObject({ utteranceId: 'u2', target: 'fr' })
  })

  it('off makes no call', () => {
    const t = setup('off')
    t.say({ utteranceId: 'u1' })
    expect(t.calls).toHaveLength(0)
    expect(t.pushes).toHaveLength(0)
  })

  it('switching to off aborts, resets and stops calls', () => {
    const t = setup('en')
    t.say({ utteranceId: 'u1' })
    t.target.current = 'off'
    t.say({ utteranceId: 'u2' })
    expect(t.calls[0].signal.aborted).toBe(true)
    expect(t.calls).toHaveLength(1)
    expect(t.pushes).toEqual([{ kind: 'reset', payload: { meetingStartedAt: STARTED, target: 'off' } }])
  })

  it('ignores utterances from another tenant, user or session', () => {
    const t = setup()
    t.say({ utteranceId: 'u1' })
    t.say({ utteranceId: 'u2' }, { ...SCOPE, tenantId: 'other' })
    t.say({ utteranceId: 'u3' }, { ...SCOPE, userId: 'other' })
    t.say({ utteranceId: 'u4' }, { ...SCOPE, sessionId: 'other' })
    expect(t.calls.map((c) => c.request.utteranceId)).toEqual(['u1'])
  })

  it('meeting end and owner revocation push nothing after', async () => {
    const ended = setup()
    ended.say({ utteranceId: 'u1' })
    ended.channels.closeMeeting(STARTED)
    expect(ended.calls[0].signal.aborted).toBe(true)
    ended.calls[0].resolve(ended.ok())
    await ended.flush()
    expect(ended.pushes).toHaveLength(0)

    const revoked = setup()
    revoked.say({ utteranceId: 'u1' })
    revoked.channels.closeFrame(`${FRAME.processId}:${FRAME.routingId}`)
    revoked.calls[0].resolve(revoked.ok())
    await revoked.flush()
    revoked.say({ utteranceId: 'u2' })
    expect(revoked.pushes.filter((p) => p.kind === 'segment')).toHaveLength(0)
  })

  it('router unavailable pushes status copy once per epoch and keeps going', async () => {
    const t = setup()
    t.say({ utteranceId: 'u1' })
    t.calls[0].resolve({ kind: 'unavailable', message: 'Your organization has not approved a model.' })
    await t.flush()
    t.say({ utteranceId: 'u2' })
    t.calls[1].resolve({ kind: 'unavailable', message: 'Your organization has not approved a model.' })
    await t.flush()
    expect(t.pushes).toEqual([
      {
        kind: 'status',
        payload: {
          meetingStartedAt: STARTED,
          state: 'unavailable',
          message: 'Your organization has not approved a model.'
        }
      }
    ])
    expect(t.logs.filter((c) => c === 'translation.unavailable')).toHaveLength(2)
  })

  it('a failed translation pushes nothing and the next line still translates', async () => {
    const t = setup()
    t.say({ utteranceId: 'u1' })
    t.calls[0].resolve({ kind: 'failed' })
    await t.flush()
    t.say({ utteranceId: 'u2' })
    expect(t.pushes).toHaveLength(0)
    expect(t.logs).toEqual(['translation.failed'])
    expect(t.calls).toHaveLength(2)
  })

  it('queue: one in flight, latest wins per line, oldest dropped past the cap', async () => {
    const t = setup()
    t.say({ utteranceId: 'first' })
    expect(t.calls).toHaveLength(1)
    for (let i = 0; i < TRANSLATION_MAX_PENDING + 3; i += 1) t.say({ utteranceId: `p${i}` })
    t.say({ utteranceId: 'p5', revision: 2, text: 'p5 corrected' })
    expect(t.calls).toHaveLength(1)
    const seen: string[] = []
    for (let n = 0; n < TRANSLATION_MAX_PENDING + 1; n += 1) {
      const call = t.calls[n]
      if (!call) break
      seen.push(`${call.request.utteranceId}@${call.request.revision}`)
      call.resolve(t.ok())
      await t.flush()
    }
    expect(seen[0]).toBe('first@1')
    // p0, p1, p2 were the oldest of 35 pending and were dropped; p5 appears once at its newest revision.
    expect(seen).not.toContain('p0@1')
    expect(seen).not.toContain('p1@1')
    expect(seen).not.toContain('p2@1')
    expect(seen).not.toContain('p5@1')
    expect(seen).toContain('p5@2')
    expect(seen.filter((s) => s.startsWith('p5')).length).toBe(1)
  })

  it('logs never contain source or translated text', async () => {
    const t = setup()
    const spy = vi.fn()
    t.say({ utteranceId: 'u1', text: 'SECRET-SOURCE' })
    t.calls[0].resolve({ kind: 'failed' })
    await t.flush()
    t.say({ utteranceId: 'u1', revision: 2, text: 'SECRET-SOURCE-2' })
    t.calls[1].resolve(t.ok('SECRET-TARGET'))
    await t.flush()
    spy(JSON.stringify(t.logs))
    expect(spy.mock.calls[0][0]).not.toMatch(/SECRET/)
    for (const code of t.logs) expect(code).toMatch(/^translation\.[a-z_]+$/)
  })

  it('a throwing push sink never breaks the channel', async () => {
    const calls: Array<(o: TranslateOutcome) => void> = []
    const channels = createTranslationChannels({
      readTarget: () => 'en',
      translate: () => new Promise<TranslateOutcome>((r) => calls.push(r)),
      push: {
        segment: () => {
          throw new Error('window gone')
        },
        retract: () => undefined,
        reset: () => undefined,
        status: () => undefined
      },
      log: () => undefined
    })
    channels.onUtterance(FRAME, STARTED, { scope: SCOPE, utteranceId: 'a', revision: 1, state: 'final', text: 'x' })
    calls[0]({ kind: 'ok', text: 'y', lowConfidence: false })
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    channels.onUtterance(FRAME, STARTED, { scope: SCOPE, utteranceId: 'b', revision: 1, state: 'final', text: 'x' })
    expect(calls).toHaveLength(2)
  })
})
