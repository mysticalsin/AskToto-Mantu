import type {
  AcceptResult,
  AckResult,
  AdjustRequest,
  AdjustResult,
  CardRef,
  CardView,
  CheckResult,
  DismissRequest,
  ListResult,
  RunView
} from '@shared/suggestions'
import { buildCandidates, filterByFeedback } from './editor'
import {
  MAX_FEEDBACK,
  MAX_RUNS,
  MAX_SUGGESTIONS,
  type Evidence,
  type OwnerData,
  type Run,
  type Suggestion
} from './model'
import type { ResearchSource, SourceItem } from './sources'
import type { SuggestionScope, SuggestionStore, TxOutcome } from './store'

export type SuggestionAuditPhase =
  | 'run_finished'
  | 'accepted'
  | 'dismissed'
  | 'adjusted'
  | 'sources_changed'
  | 'nudge'
  | 'refused'

/** Phase, an enum reason and counts only. Never a title, label, term, subject, memory text, account ref or id. */
export interface SuggestionAuditRecord {
  phase: SuggestionAuditPhase
  reason?: string
  count?: number
  ms?: number
}

export interface SuggestionServiceDeps {
  store: SuggestionStore
  scope(): SuggestionScope | null
  /** The owner's setting. Every entry point checks it. */
  enabled(): boolean
  sources: readonly ResearchSource[]
  now(): number
  /** 24 lowercase hex characters. */
  newId(): string
  /** 32 lowercase hex characters, issued afresh with every revision. */
  newNonce(): string
  /** The quiet-gated notification path. Called only for routine batches, with a count-only body. */
  notify(notification: { title: string; body: string; directRequest: false }): void
  audit(record: SuggestionAuditRecord): void
  /** How many sources are read at once. */
  concurrency?: number
}

export type RoutineResearchResult =
  | { ok: true }
  | { ok: false; errorClass: 'disabled' | 'internal' | 'connector' | 'timeout' | 'cancelled' }

export interface SuggestionService {
  list(): Promise<ListResult>
  checkNow(): Promise<CheckResult>
  runRoutine(request: { signal: AbortSignal; tools: readonly string[] }): Promise<RoutineResearchResult>
  shown(ref: CardRef): Promise<AckResult>
  accept(ref: CardRef): Promise<AcceptResult>
  dismiss(request: DismissRequest): Promise<AckResult>
  adjust(request: AdjustRequest): Promise<AdjustResult>
  /** The run in flight, if any, as of right now. A run waiting behind the store is `queued`, not failed. */
  activeRun(): RunView | null
  /** The owner or the memory partition changed: abort the run in flight and withhold its results. */
  onOwnerChange(): void
}

export const SUGGESTION_TTL_MS = 24 * 3_600_000
const DAY_MS = 24 * 3_600_000
/** Quiet breaks after three unopened nudges in a row: a day, then three, then seven (capped). */
const BREAK_DAYS = [1, 3, 7] as const
const UNOPENED_LIMIT = 3
const DEFAULT_CONCURRENCY = 2

type Refusal = 'signed-out' | 'disabled'
interface Outcome {
  run: Run
  created: number
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const toCard = (s: Suggestion): CardView => ({
  id: s.id,
  revision: s.revision,
  nonce: s.nonce,
  title: s.title,
  evidence: s.evidence.map((e) => ({
    sourceKind: e.sourceKind,
    label: e.label,
    eventAt: e.eventAt,
    retrievedAt: e.retrievedAt
  })),
  createdAt: s.createdAt,
  expiresAt: s.expiresAt
})

const toRunView = (run: Run): RunView => ({ ...run, ...(run.sourceMs ? { sourceMs: { ...run.sourceMs } } : {}) })

/**
 * The read-only research and suggestion pipeline (G67). It gathers from sources the owner already granted, builds
 * deduplicated cards and lets the owner accept or dismiss them. It holds no provider write path: sources only read.
 * Cards are sealed per owner by the store; an accept is bound to the exact id, revision and nonce the owner was shown,
 * and re-checks every source first.
 */
export function createSuggestionService(deps: SuggestionServiceDeps): SuggestionService {
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY
  let active: { run: Run; controller: AbortController; promise: Promise<Outcome> } | null = null

  const audit = (record: SuggestionAuditRecord): void => {
    try {
      deps.audit(record)
    } catch {
      /* audit is best effort */
    }
  }

  const gate = (): { ok: true; scope: SuggestionScope } | { ok: false; reason: Refusal } => {
    if (!deps.enabled()) return { ok: false, reason: 'disabled' }
    const scope = deps.scope()
    return scope ? { ok: true, scope } : { ok: false, reason: 'signed-out' }
  }

  /** Cards the owner can still act on: open, not expired. */
  const isCurrent = (s: Suggestion | undefined, ref: CardRef, now: number): s is Suggestion =>
    s !== undefined && s.state === 'open' && s.revision === ref.revision && s.nonce === ref.nonce && s.expiresAt > now

  /** Accept, dismiss and adjust act only on the card the owner was last shown, at the revision and nonce it carried. */
  const isShown = (own: OwnerData, ref: CardRef): boolean =>
    own.shown !== null &&
    own.shown.id === ref.id &&
    own.shown.revision === ref.revision &&
    own.shown.nonce === ref.nonce

  const actionable = (own: OwnerData, ref: CardRef, now: number): Suggestion | null => {
    const s = own.suggestions.find((candidate) => candidate.id === ref.id)
    return isCurrent(s, ref, now) && isShown(own, ref) ? s : null
  }

  const expire = (own: OwnerData, now: number): boolean => {
    let changed = false
    for (const s of own.suggestions) {
      if (s.state === 'open' && s.expiresAt <= now) {
        s.state = 'expired'
        changed = true
      }
    }
    return changed
  }

  const pushRun = (own: OwnerData, run: Run): void => {
    own.runs = [...own.runs, toRunView(run)].slice(-MAX_RUNS)
  }

  /** Records a run that produced nothing, when the scope it ran under is still in force. Best effort. */
  const recordRun = async (run: Run, scope: SuggestionScope): Promise<void> => {
    await deps.store.transact((view) => {
      const own = structuredClone(view.own)
      pushRun(own, run)
      return { commit: true, own, value: null }
    }, scope)
  }

  const execute = async (run: Run, controller: AbortController, scope: SuggestionScope): Promise<Outcome> => {
    const { signal } = controller
    const end = async (
      state: 'failed' | 'cancelled',
      errorClass?: Run['errorClass'],
      persist = true
    ): Promise<Outcome> => {
      run.state = state
      run.finishedAt = deps.now()
      if (errorClass) run.errorClass = errorClass
      if (persist) await recordRun(run, scope).catch(() => undefined)
      audit({ phase: 'run_finished', reason: state, count: 0, ms: run.finishedAt - (run.startedAt ?? run.enqueuedAt) })
      return { run, created: 0 }
    }

    // Waiting for the store is the queue: the run stays `queued` until it gets its turn.
    const turn = await deps.store.transact(() => ({ commit: false, value: null }), scope)
    if (!turn.ok) {
      if (turn.reason === 'stale') return end('cancelled', undefined, false)
      return end('failed', 'internal', false)
    }
    if (signal.aborted) return end('cancelled')
    run.state = 'running'
    run.startedAt = deps.now()

    const sourceMs: Record<string, number> = {}
    const gathered = await mapLimit(deps.sources, concurrency, async (source) => {
      const started = deps.now()
      try {
        const out = await source.gather({ signal, now: started })
        return { source, items: out.status === 'ok' ? out.items : ([] as SourceItem[]), failed: false }
      } catch {
        return { source, items: [] as SourceItem[], failed: true }
      } finally {
        sourceMs[source.kind] = (sourceMs[source.kind] ?? 0) + (deps.now() - started)
      }
    })
    run.sourceMs = sourceMs
    if (signal.aborted) return end('cancelled', undefined, false)
    const failures = gathered.filter((g) => g.failed)
    if (deps.sources.length > 0 && failures.length === gathered.length) {
      return end('failed', failures.some((f) => f.source.kind === 'calendar') ? 'connector' : 'internal')
    }

    const items = gathered.flatMap((g) => g.items)
    const now = deps.now()
    const candidates = buildCandidates(items, now)
    const committed = await deps.store.transact((view): TxOutcome<{ created: number; nudge: boolean }> => {
      const own = structuredClone(view.own)
      expire(own, now)
      let created = 0
      for (const candidate of filterByFeedback(candidates, own.feedback)) {
        const existing = own.suggestions.find((s) => s.state === 'open' && s.fingerprint === candidate.fingerprint)
        if (existing && existing.evidenceDigest === candidate.evidenceDigest) continue
        const id = deps.newId()
        if (existing) {
          existing.state = 'superseded'
          existing.supersededBy = id
        }
        own.suggestions.push({
          id,
          revision: 1,
          nonce: deps.newNonce(),
          ownerKey: scope.ownerKey,
          tenantKey: scope.tenantKey,
          fingerprint: candidate.fingerprint,
          evidenceDigest: candidate.evidenceDigest,
          title: candidate.title,
          kind: 'prepare_for_event',
          evidence: candidate.evidence,
          state: 'open',
          createdAt: now,
          expiresAt: now + SUGGESTION_TTL_MS
        })
        created += 1
      }
      while (own.suggestions.length > MAX_SUGGESTIONS) {
        const oldest = own.suggestions.findIndex((s) => s.state !== 'open')
        own.suggestions.splice(oldest === -1 ? 0 : oldest, 1)
      }
      let nudge = false
      if (run.trigger === 'routine' && created > 0) {
        const state = own.nudge
        if (state.quietUntil === null || state.quietUntil <= now) {
          nudge = true
          state.lastNudgeAt = now
          state.unopenedStreak += 1
          if (state.unopenedStreak >= UNOPENED_LIMIT) {
            state.quietUntil = now + BREAK_DAYS[Math.min(state.breaks, BREAK_DAYS.length - 1)]! * DAY_MS
            state.breaks += 1
            state.unopenedStreak = 0
          }
        }
      }
      run.state = 'succeeded'
      run.finishedAt = now
      pushRun(own, run)
      return { commit: true, own, value: { created, nudge } }
    }, scope)

    if (!committed.ok) {
      run.state = 'cancelled'
      run.finishedAt = deps.now()
      if (committed.reason !== 'stale') {
        run.state = 'failed'
        run.errorClass = 'internal'
      }
      audit({ phase: 'run_finished', reason: run.state, count: 0 })
      return { run, created: 0 }
    }
    if (signal.aborted) {
      run.state = 'cancelled'
      return { run, created: 0 }
    }
    audit({
      phase: 'run_finished',
      reason: 'succeeded',
      count: committed.value.created,
      ms: run.finishedAt! - run.startedAt!
    })
    if (committed.value.nudge) {
      const n = committed.value.created
      try {
        deps.notify({
          title: 'Suggestions ready',
          body: `${n} new suggestion${n === 1 ? '' : 's'}`,
          directRequest: false
        })
      } catch {
        /* a notification failing never fails a run */
      }
      audit({ phase: 'nudge', count: n })
    }
    return { run, created: committed.value.created }
  }

  const start = (trigger: Run['trigger'], scope: SuggestionScope, external?: AbortSignal): Promise<Outcome> => {
    // A second request while one is running joins it, so there is never more than one run.
    if (active) return active.promise
    const run: Run = { runId: deps.newId(), trigger, state: 'queued', enqueuedAt: deps.now() }
    const controller = new AbortController()
    if (external?.aborted) controller.abort()
    else external?.addEventListener('abort', () => controller.abort(), { once: true })
    const promise = execute(run, controller, scope).finally(() => {
      if (active?.run === run) active = null
    })
    active = { run, controller, promise }
    return promise
  }

  const settleRefusal = (reason: 'signed-out' | 'unavailable' | 'stale'): { ok: false; reason: typeof reason } => ({
    ok: false,
    reason
  })

  /** One transaction over the owner's cards that either acts on the exact card shown or refuses as stale. */
  const act = async (
    ref: CardRef,
    scope: SuggestionScope,
    apply: (own: OwnerData, card: Suggestion, now: number) => void
  ): Promise<{ ok: true; card: Suggestion } | { ok: false; reason: 'signed-out' | 'unavailable' | 'stale' }> => {
    const result = await deps.store.transact((view) => {
      const now = deps.now()
      const own = structuredClone(view.own)
      const card = actionable(own, ref, now)
      if (!card) return { commit: false, value: null }
      apply(own, card, now)
      return { commit: true, own, value: structuredClone(card) }
    }, scope)
    if (!result.ok) return settleRefusal(result.reason)
    return result.value ? { ok: true, card: result.value } : settleRefusal('stale')
  }

  const sourceValid = async (evidence: Evidence): Promise<boolean> => {
    const source = deps.sources.find((s) => s.kind === evidence.sourceKind)
    if (!source) return false
    try {
      return await source.stillValid(evidence)
    } catch {
      return false
    }
  }

  return {
    activeRun: () => (active ? toRunView(active.run) : null),

    onOwnerChange() {
      active?.controller.abort()
    },

    async list() {
      const g = gate()
      if (!g.ok) return { ok: false, reason: g.reason }
      const result = await deps.store.transact((view) => {
        const own = structuredClone(view.own)
        const now = deps.now()
        // Opening the list is the owner looking: the unopened streak ends.
        const changed = expire(own, now) || own.nudge.unopenedStreak !== 0
        own.nudge.unopenedStreak = 0
        const open = own.suggestions
          .filter((s) => s.state === 'open')
          .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
        const value = {
          cards: open.map(toCard),
          lastShownId: open.find((s) => s.id === own.shown?.id)?.id ?? null,
          lastRun: own.runs.at(-1) ?? null
        }
        return changed ? { commit: true as const, own, value } : { commit: false as const, value }
      }, g.scope)
      if (!result.ok) return { ok: false, reason: result.reason === 'stale' ? 'unavailable' : result.reason }
      return {
        ok: true,
        cards: result.value.cards,
        lastShownId: result.value.lastShownId,
        activeRun: active ? toRunView(active.run) : null,
        lastRun: result.value.lastRun ? toRunView(result.value.lastRun) : null
      }
    },

    async checkNow() {
      const g = gate()
      if (!g.ok) return { ok: false, reason: g.reason }
      const out = await start('manual', g.scope)
      return { ok: true, run: toRunView(out.run), created: out.created }
    },

    async runRoutine({ signal, tools }) {
      if (!deps.enabled()) {
        audit({ phase: 'refused', reason: 'disabled' })
        return { ok: false, errorClass: 'disabled' }
      }
      if (tools.includes('web.search')) {
        audit({ phase: 'refused', reason: 'tool_unsupported' })
        return { ok: false, errorClass: 'internal' }
      }
      const scope = deps.scope()
      if (!scope) {
        audit({ phase: 'refused', reason: 'signed_out' })
        return { ok: false, errorClass: 'internal' }
      }
      const out = await start('routine', scope, signal)
      if (out.run.state === 'succeeded') return { ok: true }
      return { ok: false, errorClass: out.run.state === 'cancelled' ? 'cancelled' : (out.run.errorClass ?? 'internal') }
    },

    async shown(ref) {
      const g = gate()
      if (!g.ok) return { ok: false, reason: g.reason }
      const result = await deps.store.transact((view) => {
        const own = structuredClone(view.own)
        const card = own.suggestions.find((s) => s.id === ref.id)
        if (!isCurrent(card, ref, deps.now())) return { commit: false, value: false }
        own.shown = { id: ref.id, revision: ref.revision, nonce: ref.nonce }
        return { commit: true, own, value: true }
      }, g.scope)
      if (!result.ok) return settleRefusal(result.reason)
      return result.value ? { ok: true } : settleRefusal('stale')
    },

    async accept(ref) {
      const g = gate()
      if (!g.ok) return { ok: false, reason: g.reason }
      const before = await deps.store.transact(
        (view) => ({ commit: false, value: actionable(view.own, ref, deps.now())?.evidence ?? null }),
        g.scope
      )
      if (!before.ok) return settleRefusal(before.reason)
      if (!before.value) {
        audit({ phase: 'refused', reason: 'stale' })
        return settleRefusal('stale')
      }
      // Every source is asked again now: a revoked grant, a disconnected account or a deleted memory ends the card.
      const checks = await Promise.all(before.value.map(sourceValid))
      if (!checks.every(Boolean)) {
        const marked = await act(ref, g.scope, (_own, card) => {
          card.state = 'sources_changed'
        })
        audit({ phase: 'sources_changed', count: checks.filter((ok) => !ok).length })
        return marked.ok ? { ok: false, reason: 'sources_changed' } : settleRefusal(marked.reason)
      }
      const done = await act(ref, g.scope, (own, card, now) => {
        card.state = 'accepted'
        own.feedback = [
          ...own.feedback,
          { fingerprint: card.fingerprint, evidenceDigest: card.evidenceDigest, verdict: 'accepted' as const, at: now }
        ].slice(-MAX_FEEDBACK)
        own.shown = null
      })
      if (!done.ok) return settleRefusal(done.reason)
      audit({ phase: 'accepted', count: done.card.evidence.length })
      return { ok: true, sources: done.card.evidence.map((e) => e.label) }
    },

    async dismiss(request) {
      const g = gate()
      if (!g.ok) return { ok: false, reason: g.reason }
      const done = await act(request, g.scope, (own, card, now) => {
        card.state = 'dismissed'
        own.feedback = [
          ...own.feedback,
          {
            fingerprint: card.fingerprint,
            evidenceDigest: card.evidenceDigest,
            verdict: 'dismissed' as const,
            reason: request.reason,
            at: now
          }
        ].slice(-MAX_FEEDBACK)
        own.shown = null
      })
      if (!done.ok) return settleRefusal(done.reason)
      audit({ phase: 'dismissed', reason: request.reason })
      return { ok: true }
    },

    async adjust(request) {
      const g = gate()
      if (!g.ok) return { ok: false, reason: g.reason }
      let revision = 0
      let nonce: string | undefined
      const done = await act(request, g.scope, (own, card) => {
        if (request.action === 'draft') {
          card.pendingRevision = { revision: card.revision + 1, title: request.title }
          revision = card.pendingRevision.revision
        } else if (request.action === 'cancel') {
          delete card.pendingRevision
          revision = card.revision
        } else if (card.pendingRevision) {
          card.revision = card.pendingRevision.revision
          card.title = card.pendingRevision.title
          card.nonce = deps.newNonce()
          delete card.pendingRevision
          // The card changed under the owner: it must be shown again before it can be accepted.
          own.shown = null
          revision = card.revision
          nonce = card.nonce
        } else {
          revision = 0
        }
      })
      if (!done.ok) return settleRefusal(done.reason)
      if (revision === 0) return settleRefusal('stale')
      audit({ phase: 'adjusted', reason: request.action })
      return { ok: true, revision, ...(nonce ? { nonce } : {}) }
    }
  }
}

/**
 * The research port a routine engine (G66) calls for a read-only suggestion routine. It carries the routine's tools
 * and abort signal and nothing else: the routine's title or prompt never reaches the pipeline, its audit or its nudge.
 */
export function createRoutineResearchPort(service: Pick<SuggestionService, 'runRoutine'>) {
  return (request: { title: string; tools: readonly string[] }, signal: AbortSignal): Promise<RoutineResearchResult> =>
    service.runRoutine({ signal, tools: request.tools })
}
