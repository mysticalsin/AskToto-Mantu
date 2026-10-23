import { mayProposeActions, type ContextRecord } from '@shared/context-authority'
import {
  ASSISTANT_LIMIT_PER_OWNER,
  ASSISTANT_PROPOSAL_TTL_MS,
  ArchiveRequestSchema,
  ConfirmRequestSchema,
  ProposeRequestSchema,
  UpdateRequestSchema,
  type AssistantPreviewItem,
  type AssistantView,
  type ConfirmResult,
  type HistoryMapResult,
  type ListResult,
  type MutationResult,
  type ProposeResult
} from '@shared/assistants'
import {
  assistantIdFor,
  idempotencyKeyFor,
  mapMeetingsToAssistants,
  normalizeDraft,
  previewHashFor,
  proposalIdFor,
  systemAssistants,
  validPreviewItem,
  viewOf,
  type AssistantEntity,
  type CustomMode
} from './assistant-model'
import type { AssistantScope, AssistantStore } from './assistant-store'

export type AssistantAuditPhase = 'proposed' | 'created' | 'replayed' | 'updated' | 'archived' | 'migrated' | 'refused'

export interface AssistantServiceDeps {
  store: AssistantStore
  /** Same scope the store reads: the verified owner and tenant keys and the partition in force. */
  scope(): AssistantScope | null
  now(): number
  customModes(): readonly CustomMode[]
  /** The saved meetings, read only: their ids are the meetings' own and are never written. */
  meetings(): Promise<ReadonlyArray<{ file: string; mode: string }>>
  /** Outcome tokens and counts only: never a name, an instruction or an id. */
  audit?(phase: AssistantAuditPhase, detail: { reason?: string; count?: number }): void
}

export interface AssistantService {
  list(): Promise<ListResult>
  /** Only an owner command can propose; content-derived text (transcript, screen, document) is data and is refused. */
  propose(command: ContextRecord, drafts: unknown): Promise<ProposeResult>
  confirm(input: unknown): Promise<ConfirmResult>
  update(input: unknown): Promise<MutationResult>
  archive(input: unknown): Promise<MutationResult>
  historyMap(): Promise<HistoryMapResult>
  /** Sign-out, revocation or an owner switch: every pending proposal is forgotten. */
  onOwnerChange(): void
}

interface Proposal {
  scopeKey: string
  items: AssistantPreviewItem[]
  previewHash: string
  expiresAt: number
}

type Created = Array<{ assistant: AssistantView; created: boolean }>
const MAX_PENDING_PROPOSALS = 16
const scopeKeyOf = (scope: AssistantScope): string => `${scope.partitionId}\0${scope.tenantKey}\0${scope.ownerKey}`
const sameScope = (a: AssistantScope, b: AssistantScope | null): boolean => b !== null && scopeKeyOf(a) === scopeKeyOf(b)
const isSystemId = (id: string): boolean => id.startsWith('sys-')

export function createAssistantService(deps: AssistantServiceDeps): AssistantService {
  const proposals = new Map<string, Proposal>()
  const audit = (phase: AssistantAuditPhase, detail: { reason?: string; count?: number } = {}): void => {
    try {
      deps.audit?.(phase, detail)
    } catch {
      // an audit failure never changes the outcome
    }
  }
  const refused = <R extends string>(reason: R): { ok: false; reason: R } => {
    audit('refused', { reason })
    return { ok: false, reason }
  }
  const storeReason = (reason: 'signed-out' | 'unavailable' | 'stale'): 'signed-out' | 'unavailable' | 'stale' => reason

  const newest = (entities: readonly AssistantEntity[]): AssistantView[] =>
    [...entities].sort((a, b) => a.createdAt - b.createdAt || a.assistantId.localeCompare(b.assistantId)).map(viewOf)

  return {
    onOwnerChange: () => proposals.clear(),

    async list() {
      const scope = deps.scope()
      if (scope === null) return { ok: false, reason: 'signed-out' }
      const result = await deps.store.transact((view) => ({ commit: false, value: newest(view.own) }), scope)
      if (!result.ok) return { ok: false, reason: result.reason === 'signed-out' ? 'signed-out' : 'unavailable' }
      if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'unavailable' }
      return { ok: true, assistants: [...systemAssistants(deps.customModes()), ...result.value] }
    },

    async propose(command, drafts) {
      if (!mayProposeActions(command)) return refused('not-owner-command')
      const scope = deps.scope()
      if (scope === null) return refused('signed-out')
      const parsed = ProposeRequestSchema.safeParse({ drafts })
      if (!parsed.success) return refused('invalid')
      const items: AssistantPreviewItem[] = []
      const seen = new Set<string>()
      for (const draft of parsed.data.drafts) {
        const item = normalizeDraft(draft)
        if (!validPreviewItem(item)) return refused('invalid')
        const key = idempotencyKeyFor(scope, item)
        if (seen.has(key)) continue // the same assistant twice in one request is one assistant
        seen.add(key)
        items.push(item)
      }
      const now = deps.now()
      for (const [id, pending] of proposals) if (pending.expiresAt <= now) proposals.delete(id)
      const previewHash = previewHashFor(items)
      const proposalId = proposalIdFor(scope, previewHash)
      proposals.delete(proposalId)
      while (proposals.size >= MAX_PENDING_PROPOSALS) proposals.delete(proposals.keys().next().value as string)
      const expiresAt = now + ASSISTANT_PROPOSAL_TTL_MS
      proposals.set(proposalId, { scopeKey: scopeKeyOf(scope), items, previewHash, expiresAt })
      audit('proposed', { count: items.length })
      return { ok: true, proposalId, previewHash, expiresAt, items }
    },

    async confirm(input) {
      const parsed = ConfirmRequestSchema.safeParse(input)
      if (!parsed.success) return refused('invalid')
      const scope = deps.scope()
      if (scope === null) return refused('signed-out')
      const pending = proposals.get(parsed.data.proposalId)
      if (!pending || pending.scopeKey !== scopeKeyOf(scope)) return refused('unknown-proposal')
      if (pending.previewHash !== parsed.data.previewHash) return refused('preview-mismatch')
      if (pending.expiresAt <= deps.now()) {
        proposals.delete(parsed.data.proposalId)
        return refused('expired')
      }
      const now = deps.now()
      const result = await deps.store.transact<Created | 'limit'>((view) => {
        const own = [...view.own]
        const created: Created = []
        let added = 0
        for (const item of pending.items) {
          const idempotencyKey = idempotencyKeyFor(scope, item)
          const existing = own.find((entity) => entity.idempotencyKey === idempotencyKey)
          if (existing) {
            created.push({ assistant: viewOf(existing), created: false })
            continue
          }
          const entity: AssistantEntity = {
            assistantId: assistantIdFor(idempotencyKey),
            ownerKey: scope.ownerKey,
            tenantKey: scope.tenantKey,
            ...item,
            createdAt: now,
            updatedAt: now,
            revision: 1,
            archived: false,
            idempotencyKey
          }
          own.push(entity)
          added += 1
          created.push({ assistant: viewOf(entity), created: true })
        }
        if (own.length > ASSISTANT_LIMIT_PER_OWNER) return { commit: false, value: 'limit' }
        if (added === 0) return { commit: false, value: created }
        return { commit: true, own, value: created }
      }, scope)
      if (!result.ok) return refused(storeReason(result.reason))
      if (!sameScope(scope, deps.scope())) return refused('stale')
      if (result.value === 'limit') return refused('limit')
      const createdCount = result.value.filter((entry) => entry.created).length
      audit(createdCount > 0 ? 'created' : 'replayed', { count: createdCount })
      return { ok: true, assistants: result.value }
    },

    async update(input) {
      const parsed = UpdateRequestSchema.safeParse(input)
      if (!parsed.success) return refused('invalid')
      return change(parsed.data.assistantId, parsed.data.expectedRevision, (entity) => {
        const next = normalizeDraft({
          name: parsed.data.name ?? entity.name,
          base: parsed.data.base ?? entity.base,
          instructions: parsed.data.instructions ?? entity.instructions
        })
        return validPreviewItem(next)
          ? { ...entity, name: next.name, base: next.base, instructions: next.instructions }
          : 'invalid'
      }, 'updated')
    },

    async archive(input) {
      const parsed = ArchiveRequestSchema.safeParse(input)
      if (!parsed.success) return refused('invalid')
      return change(
        parsed.data.assistantId,
        parsed.data.expectedRevision,
        (entity) => (entity.archived === parsed.data.archived ? 'unchanged' : { ...entity, archived: parsed.data.archived }),
        'archived',
        true
      )
    },

    async historyMap() {
      const scope = deps.scope()
      if (scope === null) return { ok: false, reason: 'signed-out' }
      let meetings: ReadonlyArray<{ file: string; mode: string }>
      try {
        meetings = await deps.meetings()
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
      if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'unavailable' }
      const custom = deps.customModes()
      const mapping = mapMeetingsToAssistants(meetings, custom)
      // The invariant the migration stands on: every meeting keeps its own id, in order, none added or lost.
      if (mapping.length !== meetings.length || mapping.some((entry, index) => entry.meetingId !== meetings[index]!.file)) {
        return { ok: false, reason: 'unavailable' }
      }
      const now = deps.now()
      const systemCount = systemAssistants(custom).length
      const result = await deps.store.transact(
        (view) =>
          view.migration?.version === 1
            ? { commit: false, value: false }
            : {
                commit: true,
                own: [...view.own],
                migration: { version: 1 as const, ranAt: now, systemAssistants: systemCount },
                value: true
              },
        scope
      )
      if (!result.ok) return { ok: false, reason: result.reason === 'signed-out' ? 'signed-out' : 'unavailable' }
      if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'unavailable' }
      if (result.value) audit('migrated', { count: mapping.length })
      return { ok: true, migrated: result.value, mapping }
    }
  }

  /** One revision-checked change to one of the owner's assistants. A foreign or forged id is `not-found`. */
  async function change(
    assistantId: string,
    expectedRevision: number,
    apply: (entity: AssistantEntity) => AssistantEntity | 'invalid' | 'unchanged',
    phase: 'updated' | 'archived',
    allowWhileArchived = false
  ): Promise<MutationResult> {
    const scope = deps.scope()
    if (scope === null) return refused('signed-out')
    if (isSystemId(assistantId)) return refused('read-only')
    const now = deps.now()
    const result = await deps.store.transact((view) => {
      const index = view.own.findIndex((entity) => entity.assistantId === assistantId)
      const entity = view.own[index]
      if (!entity) return { commit: false, value: { ok: false, reason: 'not-found' } as MutationResult }
      if (entity.revision !== expectedRevision) {
        return { commit: false, value: { ok: false, reason: 'stale-revision', current: viewOf(entity) } as MutationResult }
      }
      if (entity.archived && !allowWhileArchived) return { commit: false, value: { ok: false, reason: 'archived' } as MutationResult }
      const next = apply(entity)
      if (next === 'invalid') return { commit: false, value: { ok: false, reason: 'invalid' } as MutationResult }
      if (next === 'unchanged') return { commit: false, value: { ok: true, assistant: viewOf(entity) } as MutationResult }
      const saved: AssistantEntity = { ...next, revision: entity.revision + 1, updatedAt: now }
      const own = [...view.own]
      own[index] = saved
      return { commit: true, own, value: { ok: true, assistant: viewOf(saved) } as MutationResult }
    }, scope)
    if (!result.ok) return refused(storeReason(result.reason))
    if (!sameScope(scope, deps.scope())) return refused('stale')
    if (result.value.ok) audit(phase)
    else audit('refused', { reason: result.value.reason })
    return result.value
  }
}
