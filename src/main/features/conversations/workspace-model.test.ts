import { describe, expect, it } from 'vitest'
import { WORKSPACE_PIN_MAX } from '@shared/conversation-workspace'
import type { ConversationRecord } from './conversation-model'
import {
  baselineOwner,
  deriveUnread,
  emptyWorkspaceDoc,
  normalizeQuery,
  prunePins,
  pruneWorkspace,
  snippetAround,
  type WorkspaceDoc
} from './workspace-model'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const T1 = '1'.repeat(64)
const T2 = '2'.repeat(64)
const A = { ownerKey: KEY_A, tenantKey: T1 }
const cid = (n: number): string => `c_${String(n).padStart(32, '0')}`

const record = (n: number, over: Partial<ConversationRecord> = {}, owner = A): ConversationRecord => ({
  id: cid(n),
  ownerKey: owner.ownerKey,
  tenantKey: owner.tenantKey,
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
const doc = (): WorkspaceDoc => emptyWorkspaceDoc({ partitionId: 'a1'.repeat(12), ...A })

describe('workspace model (G50)', () => {
  it('deriveUnread counts turns past readSeq', () => {
    const r = record(1, { lastSeq: 5 })
    expect(deriveUnread(r, { readSeq: 2, manualUnread: false }, false)).toEqual({ unread: true, unreadTurns: 3 })
    expect(deriveUnread(r, { readSeq: 5, manualUnread: false }, false)).toEqual({ unread: false, unreadTurns: 0 })
    expect(deriveUnread(r, { readSeq: 9, manualUnread: false }, false)).toEqual({ unread: false, unreadTurns: 0 })
    expect(deriveUnread(r, undefined, false)).toEqual({ unread: true, unreadTurns: 5 })
  })

  it('manualUnread forces unread with zero turns', () => {
    expect(deriveUnread(record(1, { lastSeq: 3 }), { readSeq: 3, manualUnread: true }, false)).toEqual({
      unread: true,
      unreadTurns: 0
    })
  })

  it('superseded and archived never count unread', () => {
    const r = record(1, { lastSeq: 4 })
    expect(deriveUnread(r, undefined, true)).toEqual({ unread: false, unreadTurns: 0 })
    expect(deriveUnread({ ...r, supersededBy: cid(2) }, undefined, false)).toEqual({ unread: false, unreadTurns: 0 })
  })

  it('baselineOwner marks existing history read', () => {
    const base = baselineOwner(doc(), A, [record(1, { lastSeq: 4 }), record(2, { lastSeq: 0 })], 99)
    expect(base.owners).toEqual([{ ...A, baselinedAt: 99, selected: null, rev: 0 }])
    expect(base.reads.map((r) => [r.conversationId, r.readSeq, r.manualUnread])).toEqual([
      [cid(1), 4, false],
      [cid(2), 0, false]
    ])
    expect(baselineOwner(base, A, [record(3, { lastSeq: 9 })], 200)).toBe(base)
  })

  it('post-baseline new conversation is unread after its first turn', () => {
    const base = baselineOwner(doc(), A, [], 1)
    expect(
      deriveUnread(
        record(1, { lastSeq: 1 }),
        base.reads.find((r) => r.conversationId === cid(1)),
        false
      )
    ).toEqual({
      unread: true,
      unreadTurns: 1
    })
  })

  it('foreign owner rows pass through prune untouched', () => {
    const foreign = { ownerKey: KEY_B, tenantKey: T2 }
    const base: WorkspaceDoc = {
      ...doc(),
      reads: [
        { ...A, conversationId: cid(1), readSeq: 1, manualUnread: false, at: 1 },
        { ...A, conversationId: cid(9), readSeq: 1, manualUnread: false, at: 1 },
        { ...foreign, conversationId: cid(9), readSeq: 1, manualUnread: false, at: 1 }
      ],
      archived: [
        { ...A, conversationId: cid(9), at: 1 },
        { ...foreign, conversationId: cid(9), at: 1 }
      ],
      pins: [
        { ...A, kind: 'assistant', id: 'sys-gone', at: 1 },
        { ...foreign, kind: 'assistant', id: 'sys-gone', at: 1 }
      ]
    }
    const pruned = pruneWorkspace(base, A, {
      conversationIds: new Set([cid(1)]),
      assistantIds: new Set(['sys-general'])
    })
    expect(pruned.reads.map((r) => `${r.ownerKey.slice(0, 1)}${r.conversationId}`)).toEqual([
      `a${cid(1)}`,
      `b${cid(9)}`
    ])
    expect(pruned.archived).toEqual([{ ...foreign, conversationId: cid(9), at: 1 }])
    expect(pruned.pins).toEqual([{ ...foreign, kind: 'assistant', id: 'sys-gone', at: 1 }])
  })

  it('pins capped at 12 and ordered by at', () => {
    const pins = Array.from({ length: 15 }, (_, i) => ({
      ...A,
      kind: 'conversation' as const,
      id: cid(i),
      at: 100 - i
    }))
    const kept = prunePins(pins, A)
    expect(kept).toHaveLength(WORKSPACE_PIN_MAX)
    expect(kept.map((p) => p.at)).toEqual([...kept.map((p) => p.at)].sort((a, b) => a - b))
  })

  it('normalizeQuery NFKC + lowercase, rejects <2 chars', () => {
    expect(normalizeQuery('  ＡＢc ')).toBe('abc')
    expect(normalizeQuery('a')).toBeNull()
    expect(normalizeQuery(' a ')).toBeNull()
    expect(normalizeQuery('ﬁx')).toBe('fix')
  })

  it('snippetAround is bounded and centred on the match', () => {
    const text = `${'x'.repeat(300)}needle${'y'.repeat(300)}`
    const snippet = snippetAround(text, 'needle')
    expect(snippet.length).toBeLessThanOrEqual(160)
    expect(snippet).toContain('needle')
    expect(snippetAround('short needle here', 'needle')).toBe('short needle here')
  })
})
