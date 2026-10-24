import { describe, expect, it } from 'vitest'
import { CursorSchema, DRAFT_MAX_PER_OWNER, DRAFT_TTL_MS } from '@shared/conversations'
import {
  deriveThreadStatus,
  pruneDrafts,
  type ConversationRecord,
  type Draft,
  type ThreadContext
} from './conversation-model'

const OWNER = { ownerKey: 'a'.repeat(64), tenantKey: '1'.repeat(64) }
const cid = (n: number): string => `c_${n.toString(16).padStart(32, '0')}`

const record = (over: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id: cid(1),
  ...OWNER,
  assistantId: 'sys-general',
  meetingFile: null,
  remote: null,
  createdAt: 1,
  updatedAt: 1,
  lastSeq: 0,
  turnCount: 0,
  linkedFrom: null,
  supersededBy: null,
  anchorTurnId: null,
  recentRunIds: [],
  ...over
})

const ctx = (over: Partial<ThreadContext> = {}): ThreadContext => ({
  assistantIds: new Set(['sys-general']),
  assistantArchived: new Set(),
  meetingFiles: new Set(['m1']),
  remoteEpoch: 3,
  remoteTtlMs: 1000,
  now: 500,
  ...over
})

describe('deriveThreadStatus (G49)', () => {
  it('is live when nothing it hangs on is gone', () => {
    expect(deriveThreadStatus(record(), ctx())).toEqual({ status: 'live', deadReason: null })
  })

  it('applies superseded > assistant-missing > assistant-archived > meeting-missing > remote-lost', () => {
    const everything = record({
      supersededBy: cid(2),
      assistantId: 'a_' + '0'.repeat(32),
      meetingFile: 'gone',
      remote: { provider: 'dust', epoch: 1, at: 0 }
    })
    const c = ctx({ remoteEpoch: 9 })
    expect(deriveThreadStatus(everything, c).deadReason).toBe('superseded')
    const noSuper = { ...everything, supersededBy: null }
    expect(deriveThreadStatus(noSuper, c).deadReason).toBe('assistant-missing')
    const archived = { ...noSuper, assistantId: 'sys-general' }
    expect(
      deriveThreadStatus(archived, ctx({ remoteEpoch: 9, assistantArchived: new Set(['sys-general']) })).deadReason
    ).toBe('assistant-archived')
    expect(deriveThreadStatus(archived, c).deadReason).toBe('meeting-missing')
    expect(deriveThreadStatus({ ...archived, meetingFile: 'm1' }, c).deadReason).toBe('remote-lost')
  })

  it('treats a remote thread as lost on a new epoch or past its time to live, and not before', () => {
    const remote = { provider: 'dust' as const, epoch: 3, at: 0 }
    expect(deriveThreadStatus(record({ remote }), ctx({ now: 1000 })).status).toBe('live')
    expect(deriveThreadStatus(record({ remote }), ctx({ now: 1001 })).deadReason).toBe('remote-lost')
    expect(deriveThreadStatus(record({ remote }), ctx({ remoteEpoch: 4 })).deadReason).toBe('remote-lost')
  })

  it('revives when the assistant reappears (status is derived, never stored)', () => {
    const r = record({ assistantId: 'a_' + '1'.repeat(32) })
    expect(deriveThreadStatus(r, ctx()).deadReason).toBe('assistant-missing')
    expect(deriveThreadStatus(r, ctx({ assistantIds: new Set([r.assistantId]) })).status).toBe('live')
  })
})

describe('pruneDrafts retention (G49)', () => {
  const draft = (n: number, updatedAt: number, owner = OWNER): Draft => ({
    conversationId: cid(n),
    ...owner,
    text: 'x',
    updatedAt
  })

  it('drops a draft at the exact TTL millisecond and keeps one a millisecond younger', () => {
    const now = 10_000_000
    const kept = pruneDrafts([draft(1, now - DRAFT_TTL_MS), draft(2, now - DRAFT_TTL_MS + 1)], OWNER, now)
    expect(kept.drafts.map((d) => d.conversationId)).toEqual([cid(2)])
    expect(kept.expired).toBe(1)
  })

  it('evicts the oldest beyond the per-owner cap', () => {
    const drafts = Array.from({ length: DRAFT_MAX_PER_OWNER + 3 }, (_, i) => draft(i + 1, 100 + i))
    const kept = pruneDrafts(drafts, OWNER, 1000).drafts
    expect(kept).toHaveLength(DRAFT_MAX_PER_OWNER)
    expect(kept.map((d) => d.conversationId)).not.toContain(cid(1))
    expect(kept.map((d) => d.conversationId)).toContain(cid(DRAFT_MAX_PER_OWNER + 3))
  })

  it("passes another owner's drafts through untouched", () => {
    const other = { ownerKey: 'b'.repeat(64), tenantKey: '2'.repeat(64) }
    const foreign = draft(9, 0, other)
    expect(pruneDrafts([foreign], OWNER, DRAFT_TTL_MS * 5).drafts).toEqual([foreign])
  })
})

describe('history cursor schema (G49)', () => {
  it('accepts s<n> with n >= 1 and rejects s0, bare digits and non-digits', () => {
    expect(CursorSchema.safeParse('s1').success).toBe(true)
    expect(CursorSchema.safeParse('s123456789').success).toBe(true)
    for (const bad of ['s0', 's', '5', 's-1', 's1a', 's0123', 's1234567890']) {
      expect(CursorSchema.safeParse(bad).success, bad).toBe(false)
    }
  })
})
