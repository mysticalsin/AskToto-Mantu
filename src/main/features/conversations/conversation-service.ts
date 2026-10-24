import {
  AppendRequestSchema,
  CONVERSATION_LIMIT_PER_OWNER,
  CONVERSATION_RECENT_RUNS,
  CONVERSATION_TURN_LIMIT,
  DRAFT_TTL_MS,
  DraftGetRequestSchema,
  DraftSetRequestSchema,
  HistoryRequestSchema,
  OpenRequestSchema,
  SetAnchorRequestSchema,
  type AppendResult,
  type ConversationRefusal,
  type DraftGetResult,
  type EmptyResult,
  type HistoryResult,
  type ListResult,
  type OpenResult
} from '@shared/conversations'
import type { SealedScope } from '../../infra/storage/sealed-scoped-store'
import {
  newConversationId,
  newTurnId,
  pruneDrafts,
  viewOf,
  type ConversationRecord,
  type IndexDoc,
  type ThreadContext
} from './conversation-model'
import { committedTurns, type ConversationStore } from './conversation-store'

export type ConversationAuditPhase =
  | 'opened'
  | 'appended'
  | 'replayed'
  | 'linked'
  | 'draft-saved'
  | 'draft-expired'
  | 'refused'

export interface ConversationServiceDeps {
  store: ConversationStore
  scope(): SealedScope | null
  now(): number
  /** The owner's assistants with their archive flag (system assistants included). Throws when they cannot be read. */
  assistants(): Promise<ReadonlyArray<{ id: string; archived: boolean }>>
  /** The saved meetings' own file names. Throws when they cannot be read. */
  meetings(): Promise<readonly string[]>
  /** The remote (Dust) conversation epoch, whether one is held, and its time to live. */
  remote(): { epoch: number; active: boolean; ttlMs: number }
  /** Outcome tokens and counts only: never a turn, a draft, an id, an assistant name or a meeting file. */
  audit?(phase: ConversationAuditPhase, detail: { reason?: string; count?: number }): void
}

export interface ConversationService {
  list(): Promise<ListResult>
  open(input: unknown): Promise<OpenResult>
  history(input: unknown): Promise<HistoryResult>
  append(input: unknown): Promise<AppendResult>
  draftGet(input: unknown): Promise<DraftGetResult>
  draftSet(input: unknown): Promise<EmptyResult>
  setAnchor(input: unknown): Promise<EmptyResult>
}

type Refusal = ConversationRefusal['reason']
const MAX_CHAIN = 50
const byRecent = (a: ConversationRecord, b: ConversationRecord): number =>
  b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)

export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  let lock: Promise<unknown> = Promise.resolve()
  /** Every operation runs alone: one that writes the turn file and then the index must not interleave with another. */
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = lock.then(work)
    lock = result.catch(() => undefined)
    return result
  }
  const audit = (phase: ConversationAuditPhase, detail: { reason?: string; count?: number } = {}): void => {
    try {
      deps.audit?.(phase, detail)
    } catch {
      // an audit failure never changes the outcome
    }
  }
  const refuse = (reason: Refusal): { ok: false; reason: Refusal } => {
    audit('refused', { reason })
    return { ok: false, reason }
  }
  const fromTx = (reason: 'signed-out' | 'unavailable' | 'stale'): { ok: false; reason: Refusal } => refuse(reason)

  const context = async (): Promise<ThreadContext | null> => {
    try {
      const [assistants, meetings] = await Promise.all([deps.assistants(), deps.meetings()])
      const remote = deps.remote()
      return {
        assistantIds: new Set(assistants.map((a) => a.id)),
        assistantArchived: new Set(assistants.filter((a) => a.archived).map((a) => a.id)),
        meetingFiles: new Set(meetings),
        remoteEpoch: remote.epoch,
        remoteTtlMs: remote.ttlMs,
        now: deps.now()
      }
    } catch {
      // Without knowing what still exists a thread cannot be called dead, so nothing is decided.
      return null
    }
  }
  const mine =
    (scope: SealedScope) =>
    (r: { ownerKey: string; tenantKey: string }): boolean =>
      r.ownerKey === scope.ownerKey && r.tenantKey === scope.tenantKey

  /** Reads one of the caller's conversations, or a refusal. */
  const findRecord = async (
    scope: SealedScope,
    id: string
  ): Promise<{ ok: true; record: ConversationRecord; drafts: IndexDoc['drafts'] } | { ok: false; reason: Refusal }> => {
    const read = await deps.store.index.transact(
      (doc, s) => ({
        commit: false,
        value: { record: doc.conversations.filter(mine(s)).find((r) => r.id === id) ?? null, drafts: doc.drafts }
      }),
      scope
    )
    if (!read.ok) return fromTx(read.reason)
    return read.value.record === null
      ? refuse('not-found')
      : { ok: true, record: read.value.record, drafts: read.value.drafts }
  }

  return {
    list: () =>
      exclusive(async () => {
        const scope = deps.scope()
        if (scope === null) return refuse('signed-out')
        const ctx = await context()
        if (ctx === null) return refuse('unavailable')
        const read = await deps.store.index.transact(
          (doc, s) => ({ commit: false, value: doc.conversations.filter(mine(s)).sort(byRecent) }),
          scope
        )
        return read.ok ? { ok: true, conversations: read.value.map((r) => viewOf(r, ctx)) } : fromTx(read.reason)
      }),

    open: (input) =>
      exclusive(async () => {
        const scope = deps.scope()
        if (scope === null) return refuse('signed-out')
        const parsed = OpenRequestSchema.safeParse(input)
        if (!parsed.success) return refuse('invalid')
        const { assistantId } = parsed.data
        const meetingFile = parsed.data.meetingFile ?? null
        const ctx = await context()
        if (ctx === null) return refuse('unavailable')
        if (!ctx.assistantIds.has(assistantId) || ctx.assistantArchived.has(assistantId)) return refuse('not-found')
        if (meetingFile !== null && !ctx.meetingFiles.has(meetingFile)) return refuse('not-found')
        const tx = await deps.store.index.transact((doc, s) => {
          const own = doc.conversations.filter(mine(s))
          // The newest thread for this pair that was not superseded. A dead one (a lost remote thread) is returned
          // as it is: it stays readable, and the next append links a successor.
          const existing = parsed.data.fresh
            ? undefined
            : own
                .filter(
                  (r) => r.assistantId === assistantId && r.meetingFile === meetingFile && r.supersededBy === null
                )
                .sort(byRecent)[0]
          if (existing) return { commit: false, value: { record: existing, created: false } }
          if (own.length >= CONVERSATION_LIMIT_PER_OWNER) return { commit: false, value: null }
          const now = ctx.now
          const record: ConversationRecord = {
            id: newConversationId(),
            ownerKey: s.ownerKey,
            tenantKey: s.tenantKey,
            assistantId,
            meetingFile,
            remote: null,
            createdAt: now,
            updatedAt: now,
            lastSeq: 0,
            turnCount: 0,
            linkedFrom: null,
            supersededBy: null,
            anchorTurnId: null,
            recentRunIds: []
          }
          return {
            commit: true,
            doc: { ...doc, conversations: [...doc.conversations, record] },
            value: { record, created: true }
          }
        }, scope)
        if (!tx.ok) return fromTx(tx.reason)
        if (tx.value === null) return refuse('limit')
        audit('opened', { count: tx.value.created ? 1 : 0 })
        return { ok: true, conversation: viewOf(tx.value.record, ctx), created: tx.value.created }
      }),

    history: (input) =>
      exclusive(async () => {
        const scope = deps.scope()
        if (scope === null) return refuse('signed-out')
        const parsed = HistoryRequestSchema.safeParse(input)
        if (!parsed.success) return refuse('invalid')
        const { conversationId, limit } = parsed.data
        const ctx = await context()
        if (ctx === null) return refuse('unavailable')
        const found = await findRecord(scope, conversationId)
        if (!found.ok) return found
        const { record } = found
        const read = await deps.store.turns.transact(
          (doc) => ({ commit: false, value: committedTurns(doc, record.lastSeq) }),
          scope,
          conversationId
        )
        if (!read.ok) return fromTx(read.reason)
        const turns = read.value
        const cursor = (c: string | undefined): number | null => (c === undefined ? null : Number(c.slice(1)))
        const before = cursor(parsed.data.before)
        const after = cursor(parsed.data.after)
        let page = turns
        let pivot: number | null = null
        if (after !== null) {
          page = turns.filter((t) => t.seq > after).slice(0, limit)
          pivot = after
        } else {
          const older = before === null ? turns : turns.filter((t) => t.seq < before)
          page = older.slice(-limit)
          pivot = before
        }
        // Scrolling up: the anchor is the turn that was on top, so the renderer keeps its offset after prepending.
        // First load: the stored reading position when that turn still exists, else the latest turn.
        const turnAt = (seq: number | null) => (seq === null ? undefined : turns.find((t) => t.seq === seq))
        const stored = turns.find((t) => t.id === record.anchorTurnId)
        const anchorTurn = pivot !== null ? turnAt(pivot) : (stored ?? turns[turns.length - 1])
        const status = viewOf(record, ctx)
        return {
          ok: true,
          turns: page.map((t) => ({ id: t.id, seq: t.seq, role: t.role, text: t.text, at: t.at })),
          nextBefore: page.length > 0 && page[0]!.seq > 1 ? `s${page[0]!.seq}` : null,
          latestSeq: record.lastSeq,
          anchor: anchorTurn ? { turnId: anchorTurn.id, seq: anchorTurn.seq } : null,
          status: status.status,
          deadReason: status.deadReason
        }
      }),

    append: (input) =>
      exclusive(async () => {
        const scope = deps.scope()
        if (scope === null) return refuse('signed-out')
        const parsed = AppendRequestSchema.safeParse(input)
        if (!parsed.success) return refuse('invalid')
        const req = parsed.data
        const ctx = await context()
        if (ctx === null) return refuse('unavailable')
        const snapshot = await deps.store.index.transact(
          (doc, s) => ({ commit: false, value: doc.conversations.filter(mine(s)) }),
          scope
        )
        if (!snapshot.ok) return fromTx(snapshot.reason)
        const own = snapshot.value
        const requested = own.find((r) => r.id === req.conversationId)
        if (!requested) return refuse('not-found')

        // A run that already landed (in this thread or the successor it was moved to) answers with that result.
        const chain: ConversationRecord[] = [requested]
        for (let hop = 0; hop < MAX_CHAIN; hop += 1) {
          const next = own.find((r) => r.id === chain[chain.length - 1]!.supersededBy)
          if (!next) break
          chain.push(next)
        }
        const prior = chain.find((r) => r.recentRunIds.includes(req.runId))
        if (prior) {
          audit('replayed')
          return {
            ok: true,
            conversationId: prior.id,
            linkedFrom: prior.linkedFrom,
            deadReason: null,
            lastSeq: prior.lastSeq
          }
        }

        // The tail of the chain is where the conversation continues; a dead tail gets a linked successor.
        const tail = chain[chain.length - 1]!
        const requestedStatus = viewOf(requested, ctx)
        const tailStatus = viewOf(tail, ctx)
        const link = tailStatus.status === 'dead'
        if (link) {
          if (!ctx.assistantIds.has(req.assistantId) || ctx.assistantArchived.has(req.assistantId))
            return refuse('not-found')
          if (own.length >= CONVERSATION_LIMIT_PER_OWNER) return refuse('limit')
        }
        if ((link ? 0 : tail.turnCount) + req.turns.length > CONVERSATION_TURN_LIMIT) return refuse('limit')
        const now = ctx.now
        const target: ConversationRecord = link
          ? {
              ...tail,
              id: newConversationId(),
              assistantId: req.assistantId,
              meetingFile:
                tail.meetingFile !== null && ctx.meetingFiles.has(tail.meetingFile) ? tail.meetingFile : null,
              remote: null,
              createdAt: now,
              updatedAt: now,
              lastSeq: 0,
              turnCount: 0,
              linkedFrom: tail.id,
              supersededBy: null,
              anchorTurnId: null,
              recentRunIds: []
            }
          : tail
        const turns = req.turns.map((t, i) => ({
          id: newTurnId(),
          seq: target.lastSeq + 1 + i,
          role: t.role,
          text: t.text,
          at: now
        }))

        // The turn file first, then the index that counts it: a crash between them shows nothing half-committed.
        const wrote = await deps.store.turns.transact(
          (doc) => ({
            commit: true,
            doc: { ...doc, conversationId: target.id, turns: [...committedTurns(doc, target.lastSeq), ...turns] },
            value: null
          }),
          scope,
          target.id
        )
        if (!wrote.ok) return fromTx(wrote.reason)

        const remote = deps.remote()
        const committed = await deps.store.index.transact((doc, s) => {
          const base = doc.conversations
          const updated: ConversationRecord = {
            ...target,
            updatedAt: now,
            lastSeq: target.lastSeq + turns.length,
            turnCount: target.turnCount + turns.length,
            remote: remote.active ? { provider: 'dust', epoch: remote.epoch, at: now } : target.remote,
            recentRunIds: [...target.recentRunIds, req.runId].slice(-CONVERSATION_RECENT_RUNS)
          }
          const conversations = link
            ? [...base.map((r) => (r.id === tail.id ? { ...r, supersededBy: updated.id } : r)), updated]
            : base.map((r) => (r.id === updated.id ? updated : r))
          // Sending clears the composer draft of the thread the person typed in and of the one that took the turns.
          const sent = new Set([req.conversationId, updated.id])
          const remaining = doc.drafts.filter((d) => !(mine(s)(d) && sent.has(d.conversationId)))
          return {
            commit: true,
            doc: { ...doc, conversations, drafts: pruneDrafts(remaining, s, now).drafts },
            value: updated
          }
        }, scope)
        if (!committed.ok) return fromTx(committed.reason)
        audit(link ? 'linked' : 'appended', {
          reason: link ? (tailStatus.deadReason ?? undefined) : undefined,
          count: turns.length
        })
        return {
          ok: true,
          conversationId: committed.value.id,
          linkedFrom: committed.value.linkedFrom,
          deadReason: link ? tailStatus.deadReason : requestedStatus.deadReason,
          lastSeq: committed.value.lastSeq
        }
      }),

    draftGet: (input) =>
      exclusive(async () => {
        const scope = deps.scope()
        if (scope === null) return refuse('signed-out')
        const parsed = DraftGetRequestSchema.safeParse(input)
        if (!parsed.success) return refuse('invalid')
        const found = await findRecord(scope, parsed.data.conversationId)
        if (!found.ok) return found
        const draft = found.drafts.find((d) => mine(scope)(d) && d.conversationId === parsed.data.conversationId)
        if (!draft || deps.now() - draft.updatedAt >= DRAFT_TTL_MS) return { ok: true, text: null, updatedAt: null }
        return { ok: true, text: draft.text, updatedAt: draft.updatedAt }
      }),

    draftSet: (input) =>
      exclusive(async () => {
        const scope = deps.scope()
        if (scope === null) return refuse('signed-out')
        const parsed = DraftSetRequestSchema.safeParse(input)
        if (!parsed.success) return refuse('invalid')
        const { conversationId, text } = parsed.data
        const now = deps.now()
        const tx = await deps.store.index.transact((doc, s) => {
          if (!doc.conversations.filter(mine(s)).some((r) => r.id === conversationId))
            return { commit: false, value: null }
          const others = doc.drafts.filter((d) => !(mine(s)(d) && d.conversationId === conversationId))
          const next =
            text === ''
              ? others
              : [...others, { conversationId, ownerKey: s.ownerKey, tenantKey: s.tenantKey, text, updatedAt: now }]
          const pruned = pruneDrafts(next, s, now)
          return { commit: true, doc: { ...doc, drafts: pruned.drafts }, value: pruned }
        }, scope)
        if (!tx.ok) return fromTx(tx.reason)
        if (tx.value === null) return refuse('not-found')
        if (tx.value.expired > 0) audit('draft-expired', { count: tx.value.expired })
        audit('draft-saved', { count: tx.value.drafts.length })
        return { ok: true }
      }),

    setAnchor: (input) =>
      exclusive(async () => {
        const scope = deps.scope()
        if (scope === null) return refuse('signed-out')
        const parsed = SetAnchorRequestSchema.safeParse(input)
        if (!parsed.success) return refuse('invalid')
        const { conversationId, turnId } = parsed.data
        const found = await findRecord(scope, conversationId)
        if (!found.ok) return found
        const read = await deps.store.turns.transact(
          (doc) => ({ commit: false, value: committedTurns(doc, found.record.lastSeq).some((t) => t.id === turnId) }),
          scope,
          conversationId
        )
        if (!read.ok) return fromTx(read.reason)
        if (!read.value) return refuse('not-found')
        const tx = await deps.store.index.transact(
          (doc) => ({
            commit: true,
            doc: {
              ...doc,
              conversations: doc.conversations.map((r) =>
                r.id === conversationId ? { ...r, anchorTurnId: turnId } : r
              )
            },
            value: null
          }),
          scope
        )
        return tx.ok ? { ok: true } : fromTx(tx.reason)
      })
  }
}
