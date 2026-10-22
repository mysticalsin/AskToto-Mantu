import { describe, expect, it } from 'vitest'
import { ContractError, copyData } from './contract-data'
import { SessionContext, type SessionScope, type TranscriptSnapshot } from './session-context'
import { sessionScopeFor } from './session-scope'

// All people, tenants, utterances and screens below are SYNTHETIC. Ported from the 2.12 reference kernel tests.
const SCOPE: SessionScope = {
  tenantId: 'synthetic-tenant-a',
  userId: 'synthetic-user-a',
  sessionId: 'synthetic-meeting-1'
}
const OTHER_TENANT: SessionScope = { ...SCOPE, tenantId: 'synthetic-tenant-b' }
const OTHER_USER: SessionScope = { ...SCOPE, userId: 'synthetic-user-b' }
const OTHER_SESSION: SessionScope = { ...SCOPE, sessionId: 'synthetic-meeting-2' }

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (error) {
    return error instanceof ContractError ? error.code : `other:${String(error)}`
  }
  return undefined
}

const context = (permissions: string[] = []): SessionContext =>
  new SessionContext({ scope: SCOPE, permissions, mode: 'meeting', objective: 'Synthetic contract exercise' })
const transcript = (revision: number, texts: string[] = [], scope: SessionScope = SCOPE): TranscriptSnapshot => ({
  scope,
  revision,
  segments: texts.map((text, index) => ({ utteranceId: `synthetic-utterance-${index + 1}`, state: 'final', text })),
  interim: []
})
const screen = (overrides: Record<string, unknown> = {}) => ({
  scope: SCOPE,
  sourceId: 'synthetic-screen-1',
  observedAtMs: 1_000,
  text: 'Synthetic screen',
  ...overrides
})
const knowledge = (overrides: Record<string, unknown> = {}) => ({
  scope: SCOPE,
  sourceId: 'synthetic-kb-1',
  citation: 'Synthetic citation',
  text: 'Synthetic knowledge',
  ...overrides
})

describe('SessionContext snapshots', () => {
  it('supplies consistent facts to conversation, screen, manual and follow-up outputs', () => {
    const ctx = context()
    ctx.updateTranscript(transcript(1, ['Synthetic confirmed statement']))
    ctx.setScreen(screen())
    ctx.setKnowledge([knowledge()])
    const snapshots = (['conversation', 'screen', 'manual', 'followup'] as const).map((kind) => ctx.snapshot(kind))
    const shared = snapshots.map(({ outputKind: _kind, ...facts }) => facts)
    for (const facts of shared.slice(1)) expect(facts).toEqual(shared[0])
    expect(snapshots.map((snapshot) => snapshot.outputKind)).toEqual(['conversation', 'screen', 'manual', 'followup'])
    expect(shared[0]?.transcript.segments).toHaveLength(1)
    expect(shared[0]?.knowledge[0]).toMatchObject({ sourceId: 'synthetic-kb-1' })
    expect(shared[0]?.scope).toEqual(SCOPE)
    expect(shared[0]?.mode).toBe('meeting')
  })

  it('is deeply immutable, detached from input, and rejects executable or accessor values', () => {
    const ctx = context()
    const input = screen()
    ctx.setScreen(input)
    const snapshot = ctx.snapshot('screen')
    input.text = 'Untrusted later mutation'
    expect(snapshot.screen?.text).toBe('Synthetic screen')
    expect(() => {
      ;(snapshot.screen as unknown as { text: string }).text = 'Mutation'
    }).toThrow(TypeError)
    expect(codeOf(() => ctx.setScreen(screen({ run: () => 'code' })))).toBe('DATA_OBJECT')
    const accessor = screen()
    Object.defineProperty(accessor, 'extra', {
      enumerable: true,
      get() {
        throw new Error('must not execute')
      }
    })
    expect(codeOf(() => ctx.setScreen(accessor))).toBe('DATA_ACCESSOR')
  })

  it('rejects a forged snapshot and a snapshot issued by another authority', () => {
    const ctx = context()
    const snapshot = ctx.snapshot('manual')
    expect(codeOf(() => ctx.assertCurrent({ ...snapshot }))).toBe('SNAPSHOT_NOT_ISSUED')
    expect(codeOf(() => context().assertCurrent(snapshot))).toBe('SNAPSHOT_NOT_ISSUED')
    expect(codeOf(() => ctx.assertCurrent(null as never))).toBe('SNAPSHOT_NOT_ISSUED')
    expect(ctx.isCurrent(snapshot)).toBe(true)
    expect(context().isCurrent(snapshot)).toBe(false)
  })

  it('rejects an unknown output kind', () => {
    expect(codeOf(() => context().snapshot('typed' as never))).toBe('OUTPUT_KIND')
  })
})

describe('SessionContext scope boundaries', () => {
  it('rejects transcript, screen and knowledge contamination across tenant, user and session', () => {
    const ctx = context()
    for (const wrongScope of [OTHER_TENANT, OTHER_USER, OTHER_SESSION]) {
      expect(codeOf(() => ctx.updateTranscript(transcript(1, [], wrongScope)))).toBe('SCOPE_MISMATCH')
      expect(codeOf(() => ctx.setScreen(screen({ scope: wrongScope })))).toBe('SCOPE_MISMATCH')
      expect(codeOf(() => ctx.setKnowledge([knowledge({ scope: wrongScope })]))).toBe('SCOPE_MISMATCH')
      expect(codeOf(() => ctx.assertActor(wrongScope))).toBe('SCOPE_MISMATCH')
    }
    expect(ctx.revision).toBe(1)
  })

  it('validates the scope tuple shape and identifier characters at construction', () => {
    const make = (scope: unknown) => () => new SessionContext({ scope: scope as SessionScope })
    expect(codeOf(make({ tenantId: 'a', userId: 'b' }))).toBe('SCOPE_SHAPE')
    expect(codeOf(make({ ...SCOPE, extra: 'x' }))).toBe('SCOPE_SHAPE')
    expect(codeOf(make({ ...SCOPE, tenantId: '' }))).toBe('SCOPE_ID')
    expect(codeOf(make({ ...SCOPE, userId: 'has space' }))).toBe('SCOPE_ID')
    expect(codeOf(make({ ...SCOPE, sessionId: 'x'.repeat(129) }))).toBe('SCOPE_ID')
    expect(codeOf(make({ ...SCOPE, sessionId: 42 }))).toBe('SCOPE_ID')
  })

  it('validates mode, objective and permission identifiers at construction', () => {
    const permissions = (value: unknown) => () => new SessionContext({ scope: SCOPE, permissions: value as string[] })
    expect(codeOf(permissions('screen'))).toBe('PERMISSIONS_SHAPE')
    expect(codeOf(permissions(Array.from({ length: 65 }, (_, index) => `p${index}`)))).toBe('PERMISSIONS_SHAPE')
    expect(codeOf(permissions(['Bad Id']))).toBe('PERMISSION_ID')
    expect(codeOf(() => new SessionContext({ scope: SCOPE, mode: 'm'.repeat(81) }))).toBe('MODE')
    expect(codeOf(() => new SessionContext({ scope: SCOPE, objective: 'o'.repeat(2_001) }))).toBe('OBJECTIVE')
  })

  it('derives a scope from an owner-session ref tenant key, owner key and a meeting session id', () => {
    const scope = sessionScopeFor({ tenantKey: 'ab'.repeat(32), ownerKey: 'cd'.repeat(32) }, 'meeting-1')
    expect(scope).toEqual({ tenantId: 'ab'.repeat(32), userId: 'cd'.repeat(32), sessionId: 'meeting-1' })
    expect(() => new SessionContext({ scope })).not.toThrow()
    expect(codeOf(() => sessionScopeFor({ tenantKey: '', ownerKey: 'cd'.repeat(32) }, 'meeting-1'))).toBe('SCOPE_ID')
  })
})

describe('SessionContext revisions and lifecycle', () => {
  it('keeps transcript revisions monotonic and invalidates earlier output snapshots on a correction', () => {
    const ctx = context()
    const initial = transcript(1, ['Synthetic amount ten'])
    expect(ctx.updateTranscript(initial)).toBe(true)
    const output = ctx.snapshot('followup')
    expect(ctx.updateTranscript(initial)).toBe(false)
    ctx.updateTranscript(transcript(2, ['Synthetic amount twenty']))
    expect(codeOf(() => ctx.assertCurrent(output))).toBe('STALE_CONTEXT')
    expect(codeOf(() => ctx.updateTranscript(initial))).toBe('TRANSCRIPT_REGRESSION')
    expect(codeOf(() => ctx.updateTranscript(transcript(2, ['Contradictory same revision'])))).toBe(
      'TRANSCRIPT_REVISION_COLLISION'
    )
  })

  it('rejects malformed transcript envelopes', () => {
    const ctx = context()
    expect(codeOf(() => ctx.updateTranscript({ ...transcript(1), revision: -1 }))).toBe('TRANSCRIPT_REVISION')
    expect(codeOf(() => ctx.updateTranscript({ ...transcript(1), revision: 1.5 }))).toBe('TRANSCRIPT_REVISION')
    expect(codeOf(() => ctx.updateTranscript({ ...transcript(1), segments: 'x' } as never))).toBe('TRANSCRIPT_SHAPE')
    expect(codeOf(() => ctx.updateTranscript({ ...transcript(1), interim: null } as never))).toBe('TRANSCRIPT_SHAPE')
  })

  it('validates screen identity and time, and ignores an identical observation', () => {
    const ctx = context()
    expect(codeOf(() => ctx.setScreen(screen({ sourceId: 7 })))).toBe('SCREEN_ID')
    expect(codeOf(() => ctx.setScreen(screen({ sourceId: 'x'.repeat(129) })))).toBe('SCREEN_ID')
    expect(codeOf(() => ctx.setScreen(screen({ observedAtMs: -1 })))).toBe('SCREEN_TIME')
    expect(codeOf(() => ctx.setScreen(screen({ observedAtMs: 1.5 })))).toBe('SCREEN_TIME')
    expect(ctx.setScreen(screen())).toBe(true)
    expect(ctx.setScreen(screen())).toBe(false)
    expect(ctx.setScreen(null)).toBe(true)
    expect(ctx.snapshot('screen').screen).toBeNull()
  })

  it('validates knowledge shape and ignores identical references', () => {
    const ctx = context()
    expect(codeOf(() => ctx.setKnowledge({} as never))).toBe('KNOWLEDGE_SHAPE')
    expect(codeOf(() => ctx.setKnowledge(['text'] as never))).toBe('KNOWLEDGE_SHAPE')
    expect(ctx.setKnowledge([knowledge()])).toBe(true)
    expect(ctx.setKnowledge([knowledge()])).toBe(false)
  })

  it('creates distinct generations on stop and resume and never revives a previous snapshot', () => {
    const ctx = context()
    const before = ctx.snapshot('conversation')
    expect(ctx.stop()).toBe(true)
    expect(ctx.active).toBe(false)
    expect(ctx.stop()).toBe(false)
    expect(codeOf(() => ctx.snapshot('manual'))).toBe('SESSION_STOPPED')
    expect(codeOf(() => ctx.assertCurrent(before))).toBe('SESSION_STOPPED')
    expect(ctx.resume()).toBe(true)
    expect(ctx.resume()).toBe(false)
    expect(ctx.generation).toBe(before.generation + 2)
    expect(codeOf(() => ctx.assertCurrent(before))).toBe('STALE_GENERATION')
    expect(ctx.isCurrent(ctx.snapshot('conversation'))).toBe(true)
  })

  it('changes the permission fingerprint and generation when permissions change', () => {
    const ctx = context(['screen.read', 'screen.read', 'asr.use'])
    expect(ctx.permissionFingerprint).toBe('["asr.use","screen.read"]')
    expect(ctx.hasPermissions(['screen.read'])).toBe(true)
    expect(ctx.hasPermissions(['screen.read', 'tasks.run'])).toBe(false)
    const before = ctx.snapshot('manual')
    expect(ctx.setPermissions(['asr.use', 'screen.read'])).toBe(false)
    expect(ctx.isCurrent(before)).toBe(true)
    expect(ctx.setPermissions(['asr.use'])).toBe(true)
    expect(codeOf(() => ctx.assertCurrent(before))).toBe('STALE_GENERATION')
    expect(ctx.generation).toBe(before.generation + 1)
  })

  it('notifies observers with the reason and survives a throwing observer', () => {
    const ctx = context()
    const reasons: string[] = []
    ctx.onChange(() => {
      throw new Error('observer failure must not stop invalidation')
    })
    const off = ctx.onChange((reason) => reasons.push(reason))
    ctx.setScreen(screen())
    ctx.setKnowledge([knowledge()])
    ctx.updateTranscript(transcript(1))
    ctx.setPermissions(['asr.use'])
    ctx.stop()
    ctx.resume()
    off()
    ctx.setScreen(null)
    expect(reasons).toEqual(['screen', 'knowledge', 'transcript', 'permissions', 'stop', 'resume'])
    expect(codeOf(() => ctx.onChange('x' as never))).toBe('LISTENER')
  })

  it('copyData stays the single boundary for plain data', () => {
    expect(copyData({ a: 1 })).toEqual({ a: 1 })
  })
})
