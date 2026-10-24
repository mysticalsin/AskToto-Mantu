import {
  MarkReadRequestSchema,
  MarkUnreadRequestSchema,
  SearchRequestSchema,
  SelectRequestSchema,
  SetArchivedRequestSchema,
  SetPinnedRequestSchema,
  WORKSPACE_PIN_MAX,
  WORKSPACE_SEARCH_SCAN_BUDGET,
  WORKSPACE_SNIPPET_MAX,
  type GetResult,
  type MutationResult,
  type SearchHit,
  type SearchResult,
  type WorkspaceItem
} from '@shared/conversation-workspace'
import type { ConversationRefusal } from '@shared/conversations'
import type { SealedScope } from '../../infra/storage/sealed-scoped-store'
import {
  buildThreadContext,
  byRecent,
  deriveThreadStatus,
  isMine,
  MAX_CHAIN,
  viewOf,
  type ConversationRecord,
  type ThreadContext
} from './conversation-model'
import { committedTurns, type ConversationStore } from './conversation-store'
import {
  baselineOwner,
  deriveUnread,
  normalizeQuery,
  pruneWorkspace,
  snippetAround,
  type OwnerRow,
  type WorkspaceDoc
} from './workspace-model'
import type { WorkspaceStore } from './workspace-store'

export type WorkspaceAuditPhase =
  | 'selected'
  | 'read'
  | 'unread'
  | 'archived'
  | 'restored'
  | 'pinned'
  | 'unpinned'
  | 'searched'
  | 'baselined'
  | 'refused'

export interface WorkspaceServiceDeps {
  conversations: ConversationStore
  workspace: WorkspaceStore
  scope(): SealedScope | null
  now(): number
  /** The owner's assistants with their archive flag and name (system assistants included). Throws when unreadable. */
  assistants(): Promise<ReadonlyArray<{ id: string; archived: boolean; name?: string }>>
  /** The saved meetings' own file names. Throws when they cannot be read. */
  meetings(): Promise<readonly string[]>
  remote(): { epoch: number; active: boolean; ttlMs: number }
  /** Phase tokens and counts only: never a query, a snippet, a turn, an id or an assistant name. */
  audit?(phase: WorkspaceAuditPhase, detail: { reason?: string; count?: number }): void
}

export interface WorkspaceService {
  get(): Promise<GetResult>
  select(input: unknown): Promise<MutationResult>
  markRead(input: unknown): Promise<MutationResult>
  markUnread(input: unknown): Promise<MutationResult>
  setArchived(input: unknown): Promise<MutationResult>
  setPinned(input: unknown): Promise<MutationResult>
  search(input: unknown): Promise<SearchResult>
  /** In-process only: called with the new revision after every change. G51 broadcasts it to windows. */
  subscribe(listener: (rev: number) => void): () => void
}

type Refusal = ConversationRefusal['reason']
type Fail = { ok: false; reason: Refusal }

interface Frame {
  scope: SealedScope
  ctx: ThreadContext
  own: ConversationRecord[]
  names: Map<string, string>
}
interface Working {
  doc: WorkspaceDoc
  owner: OwnerRow
  frame: Frame
}
type Op<T> = (
  w: Working
) => { refuse: Refusal } | { value: T; doc?: WorkspaceDoc; owner?: Partial<OwnerRow>; changed: boolean }
type Applied<T> = { ok: true; value: T; doc: WorkspaceDoc; owner: OwnerRow; changed: boolean; baselined: number } | Fail

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  let lock: Promise<unknown> = Promise.resolve()
  /** Every operation runs alone, so a read of the conversations and the write of the workspace see one state. */
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = lock.then(work)
    lock = result.catch(() => undefined)
    return result
  }
  const listeners = new Set<(rev: number) => void>()
  const audit = (phase: WorkspaceAuditPhase, detail: { reason?: string; count?: number } = {}): void => {
    try {
      deps.audit?.(phase, detail)
    } catch {
      // an audit failure never changes the outcome
    }
  }
  const refuse = (reason: Refusal): Fail => {
    audit('refused', { reason })
    return { ok: false, reason }
  }
  const notify = (rev: number): void => {
    for (const listener of [...listeners]) {
      try {
        listener(rev)
      } catch {
        // a listener failure never changes the outcome
      }
    }
  }

  /** The caller's conversations and what they are attached to, or a refusal. */
  const frameOf = async (scope: SealedScope): Promise<Frame | Fail> => {
    let list: Awaited<ReturnType<WorkspaceServiceDeps['assistants']>>
    try {
      list = await deps.assistants()
    } catch {
      // Without knowing what still exists nothing is decided.
      return refuse('unavailable')
    }
    const ctx = await buildThreadContext({
      assistants: async () => list,
      meetings: deps.meetings,
      remote: deps.remote,
      now: deps.now
    })
    if (ctx === null) return refuse('unavailable')
    const read = await deps.conversations.index.transact(
      (doc, s) => ({ commit: false, value: doc.conversations.filter(isMine(s)) }),
      scope
    )
    if (!read.ok) return refuse(read.reason)
    const names = new Map<string, string>()
    for (const a of list) if (a.name !== undefined) names.set(a.id, a.name.normalize('NFKC').toLowerCase())
    return { scope, ctx, own: read.value, names }
  }

  const apply = async <T>(frame: Frame, op: Op<T>): Promise<Applied<T>> => {
    type Landed =
      | { refuse: Refusal }
      | { value: T; doc: WorkspaceDoc; owner: OwnerRow; changed: boolean; baselined: number }
    const tx = await deps.workspace.transact<Landed>((stored, s) => {
      const mine = isMine(s)
      const based = baselineOwner(stored, s, frame.own, frame.ctx.now)
      const fresh = based !== stored
      const baselined = fresh ? Math.max(1, based.reads.length - stored.reads.length) : 0
      const owner = based.owners.find(mine)!
      const out = op({ doc: based, owner, frame })
      if ('refuse' in out) {
        // The baseline stays even when the operation is refused: it is what keeps old history read.
        return fresh ? { commit: true, doc: based, value: out } : { commit: false, value: out }
      }
      if (!out.changed && !fresh) return { commit: false, value: { ...out, doc: based, owner, baselined } }
      const bumped: OwnerRow = { ...owner, ...out.owner, rev: owner.rev + (out.changed ? 1 : 0) }
      const next = pruneWorkspace(
        { ...(out.doc ?? based), owners: (out.doc ?? based).owners.map((o) => (mine(o) ? bumped : o)) },
        s,
        { conversationIds: new Set(frame.own.map((r) => r.id)), assistantIds: frame.ctx.assistantIds }
      )
      return { commit: true, doc: next, value: { ...out, doc: next, owner: bumped, baselined } }
    }, frame.scope)
    if (!tx.ok) return refuse(tx.reason)
    if ('refuse' in tx.value) return refuse(tx.value.refuse)
    if (tx.value.baselined > 0) audit('baselined', { count: tx.value.baselined })
    return { ok: true, ...tx.value }
  }

  /** The common shape of a change: validate, read the frame, apply, announce. */
  const mutate = async <T>(
    parse: () => { success: boolean; data?: T },
    run: (input: T, frame: Frame) => Promise<Op<unknown> | Fail>,
    phase: (input: T, value: unknown) => WorkspaceAuditPhase
  ): Promise<MutationResult> => {
    const scope = deps.scope()
    if (scope === null) return refuse('signed-out')
    const parsed = parse()
    if (!parsed.success) return refuse('invalid')
    const input = parsed.data as T
    const frame = await frameOf(scope)
    if ('ok' in frame) return frame
    const op = await run(input, frame)
    if ('ok' in op) return op
    const done = await apply(frame, op)
    if (!done.ok) return done
    audit(phase(input, done.value))
    notify(done.owner.rev)
    return { ok: true, rev: done.owner.rev }
  }

  const viewOfState = (doc: WorkspaceDoc, owner: OwnerRow, frame: Frame): GetResult => {
    const mine = isMine(frame.scope)
    const reads = new Map(doc.reads.filter(mine).map((r) => [r.conversationId, r]))
    const archived = new Set(doc.archived.filter(mine).map((r) => r.conversationId))
    const pins = doc.pins.filter(mine)
    const pinAt = new Map(pins.filter((p) => p.kind === 'conversation').map((p) => [p.id, p.at]))
    const counts = { unreadConversations: 0, readConversations: 0, archivedConversations: 0 }
    const rows: Array<{ record: ConversationRecord; item: WorkspaceItem }> = []
    for (const record of frame.own.filter((r) => r.supersededBy === null)) {
      const isArchived = archived.has(record.id)
      const d = deriveUnread(record, reads.get(record.id), isArchived)
      if (isArchived) {
        counts.archivedConversations += 1
        continue
      }
      if (d.unread) counts.unreadConversations += 1
      else counts.readConversations += 1
      rows.push({
        record,
        item: {
          conversation: viewOf(record, frame.ctx),
          unread: d.unread,
          unreadTurns: d.unreadTurns,
          pinned: pinAt.has(record.id),
          archived: false
        }
      })
    }
    rows.sort((a, b) => {
      const pa = pinAt.get(a.record.id)
      const pb = pinAt.get(b.record.id)
      if (pa !== undefined && pb !== undefined) return pa - pb || a.record.id.localeCompare(b.record.id)
      if (pa !== undefined) return -1
      if (pb !== undefined) return 1
      return byRecent(a.record, b.record)
    })
    return {
      ok: true,
      rev: owner.rev,
      selectedConversationId: owner.selected,
      counts,
      items: rows.map((r) => r.item),
      pinnedAssistantIds: pins
        .filter((p) => p.kind === 'assistant')
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
        .map((p) => p.id)
    }
  }

  const upsertRead = (
    doc: WorkspaceDoc,
    scope: SealedScope,
    conversationId: string,
    patch: (prior: number) => { readSeq: number; manualUnread: boolean },
    at: number
  ): WorkspaceDoc => {
    const mine = isMine(scope)
    const prior = doc.reads.find((r) => mine(r) && r.conversationId === conversationId)
    const row = {
      ownerKey: scope.ownerKey,
      tenantKey: scope.tenantKey,
      conversationId,
      ...patch(prior?.readSeq ?? 0),
      at
    }
    return { ...doc, reads: [...doc.reads.filter((r) => !(mine(r) && r.conversationId === conversationId)), row] }
  }

  const ownRecord = (frame: Frame, id: string): ConversationRecord | undefined => frame.own.find((r) => r.id === id)

  return {
    get: () =>
      exclusive(async (): Promise<GetResult> => {
        const scope = deps.scope()
        if (scope === null) return refuse('signed-out')
        const frame = await frameOf(scope)
        if ('ok' in frame) return frame
        const done = await apply(frame, ({ owner }) => {
          // A selection that was superseded follows its chain to the live successor; a gone one clears.
          const byId = new Map(frame.own.map((r) => [r.id, r]))
          let selected = owner.selected
          if (selected !== null) {
            let current = byId.get(selected)
            for (let hop = 0; current && current.supersededBy !== null && hop < MAX_CHAIN; hop += 1) {
              const next = byId.get(current.supersededBy)
              if (!next) break
              current = next
            }
            selected = current?.id ?? null
          }
          return { value: null, owner: { selected }, changed: selected !== owner.selected }
        })
        if (!done.ok) return done
        if (done.changed) notify(done.owner.rev)
        return viewOfState(done.doc, done.owner, frame)
      }),

    select: (input) =>
      exclusive(() =>
        mutate(
          () => SelectRequestSchema.safeParse(input),
          async (req, frame) =>
            req.conversationId !== null && !ownRecord(frame, req.conversationId)
              ? refuse('not-found')
              : () => ({ value: null, owner: { selected: req.conversationId }, changed: true }),
          () => 'selected'
        )
      ),

    markRead: (input) =>
      exclusive(() =>
        mutate(
          () => MarkReadRequestSchema.safeParse(input),
          async (req, frame) => {
            const record = ownRecord(frame, req.conversationId)
            if (!record) return refuse('not-found')
            const turns = await deps.conversations.turns.transact(
              (doc) => ({ commit: false, value: committedTurns(doc, record.lastSeq) }),
              frame.scope,
              record.id
            )
            if (!turns.ok) return refuse(turns.reason)
            const seq = turns.value.find((t) => t.id === req.throughTurnId)?.seq
            if (seq === undefined) return refuse('not-found')
            return ({ doc }) => ({
              value: null,
              doc: upsertRead(
                doc,
                frame.scope,
                record.id,
                (prior) => ({ readSeq: Math.max(prior, seq), manualUnread: false }),
                frame.ctx.now
              ),
              changed: true
            })
          },
          () => 'read'
        )
      ),

    markUnread: (input) =>
      exclusive(() =>
        mutate(
          () => MarkUnreadRequestSchema.safeParse(input),
          async (req, frame) =>
            !ownRecord(frame, req.conversationId)
              ? refuse('not-found')
              : ({ doc }) => ({
                  value: null,
                  doc: upsertRead(
                    doc,
                    frame.scope,
                    req.conversationId,
                    (prior) => ({ readSeq: prior, manualUnread: true }),
                    frame.ctx.now
                  ),
                  changed: true
                }),
          () => 'unread'
        )
      ),

    setArchived: (input) =>
      exclusive(() =>
        mutate(
          () => SetArchivedRequestSchema.safeParse(input),
          async (req, frame) =>
            !ownRecord(frame, req.conversationId)
              ? refuse('not-found')
              : ({ doc }) => {
                  const mine = isMine(frame.scope)
                  const others = doc.archived.filter((r) => !(mine(r) && r.conversationId === req.conversationId))
                  const row = {
                    ownerKey: frame.scope.ownerKey,
                    tenantKey: frame.scope.tenantKey,
                    conversationId: req.conversationId,
                    at: frame.ctx.now
                  }
                  return {
                    value: null,
                    doc: { ...doc, archived: req.archived ? [...others, row] : others },
                    changed: true
                  }
                },
          (req) => (req.archived ? 'archived' : 'restored')
        )
      ),

    setPinned: (input) =>
      exclusive(() =>
        mutate(
          () => SetPinnedRequestSchema.safeParse(input),
          async (req, frame) => {
            const exists =
              req.kind === 'conversation' ? ownRecord(frame, req.id) !== undefined : frame.ctx.assistantIds.has(req.id)
            if (!exists) return refuse('not-found')
            return ({ doc }) => {
              const mine = isMine(frame.scope)
              const own = doc.pins.filter(mine)
              const same = (p: { kind: string; id: string }): boolean => p.kind === req.kind && p.id === req.id
              if (req.pinned && !own.some(same) && own.length >= WORKSPACE_PIN_MAX) return { refuse: 'limit' as const }
              const others = doc.pins.filter((p) => !(mine(p) && same(p)))
              const prior = own.find(same)
              const row = {
                ownerKey: frame.scope.ownerKey,
                tenantKey: frame.scope.tenantKey,
                kind: req.kind,
                id: req.id,
                at: prior?.at ?? frame.ctx.now
              }
              return { value: null, doc: { ...doc, pins: req.pinned ? [...others, row] : others }, changed: true }
            }
          },
          (req) => (req.pinned ? 'pinned' : 'unpinned')
        )
      ),

    search: (input) =>
      exclusive(async (): Promise<SearchResult> => {
        const scope = deps.scope()
        if (scope === null) return refuse('signed-out')
        const parsed = SearchRequestSchema.safeParse(input)
        const needle = parsed.success ? normalizeQuery(parsed.data.query) : null
        if (!parsed.success || needle === null) return refuse('invalid')
        const { limit } = parsed.data
        const includeArchived = parsed.data.includeArchived ?? true
        const frame = await frameOf(scope)
        if ('ok' in frame) return frame
        const stored = await deps.workspace.transact(
          (doc, s) => ({
            commit: false,
            value: new Set(doc.archived.filter(isMine(s)).map((r) => r.conversationId))
          }),
          scope
        )
        if (!stored.ok) return refuse(stored.reason)
        const archived = stored.value
        // Only the caller's own records are ever iterated, and a turn file opens only through the scope-checked store.
        const candidates = frame.own.filter((r) => includeArchived || !archived.has(r.id)).sort(byRecent)
        const label = (r: ConversationRecord): SearchHit['label'] =>
          archived.has(r.id) ? 'archived' : deriveThreadStatus(r, frame.ctx).status === 'dead' ? 'dead' : 'active'
        const hits: SearchHit[] = []
        for (const r of candidates) {
          if (hits.length >= limit) break
          const name = frame.names.get(r.assistantId)
          if (name?.includes(needle)) {
            hits.push({ conversationId: r.id, label: label(r), turnId: null, snippet: null, matched: 'assistant-name' })
          }
        }
        const found = new Set(hits.map((h) => h.conversationId))
        let scanned = 0
        let truncated = false
        for (const r of candidates) {
          if (found.has(r.id) || r.lastSeq === 0) continue
          if (hits.length >= limit || scanned >= WORKSPACE_SEARCH_SCAN_BUDGET) {
            truncated = true
            break
          }
          scanned += 1
          const read = await deps.conversations.turns.transact(
            (doc) => ({ commit: false, value: committedTurns(doc, r.lastSeq).reverse() }),
            scope,
            r.id
          )
          if (!read.ok) return refuse(read.reason)
          const turn = read.value.find((t) => t.text.normalize('NFKC').toLowerCase().includes(needle))
          if (turn) {
            hits.push({
              conversationId: r.id,
              label: label(r),
              turnId: turn.id,
              snippet: snippetAround(turn.text, needle, WORKSPACE_SNIPPET_MAX),
              matched: 'turn'
            })
          }
        }
        audit('searched', { count: hits.length })
        return { ok: true, hits, truncated }
      }),

    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
}
