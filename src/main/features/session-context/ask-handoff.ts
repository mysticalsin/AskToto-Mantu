/**
 * ask-handoff.ts — the fast-to-deep handoff contract (Métis 2.12 G29, CAP-19).
 *
 * A fast answer that is upgraded to a deep one is ONE turn with two stages, not two unrelated asks. The deep stage
 * keeps the turn's identity (`turnId`, the fast stage's ask id), its goal, its owner, its grants and its SessionContext
 * snapshot lineage, and the fast stage is superseded: a stage that is still running is stopped, a delivered one is
 * retired so a later correction names the deep output only.
 *
 * Main is the authority. The renderer only says "deeper" (`depth: 'deeper'`) about the request it replays; main finds
 * the fast stage by the goal digest in its own ledger and checks the snapshot anchors itself. A handoff that cannot
 * keep a promise (another owner, other grants, a stopped or different context, a fast stage that never delivered) is
 * not refused to the user: it runs as an ordinary fresh ask under its own identity, and the plan says why.
 *
 * Content-free by construction: the ledger holds a digest of the goal, never the prompt, and snapshot coordinates,
 * never transcript text.
 */
import { createHash } from 'node:crypto'
import type { ContextHandle } from './meeting-context-registry'

export type StageName = 'fast' | 'deep'
/** `delivered`: the answer finished and was published. `ended`: it failed, was cancelled, went stale or never ran. */
export type StageOutcome = 'running' | 'delivered' | 'ended'

/** Where a stage's snapshot stood: whose it is, which meeting, which grants. Coordinates only. */
export interface HandoffAnchor {
  readonly owner: string | null
  readonly sessionId: string | null
  readonly generation: number | null
  readonly contextRevision: number | null
  readonly permissionFingerprint: string | null
}

export function anchorOf(handle: Pick<ContextHandle, 'snapshot'> | null): HandoffAnchor {
  if (!handle)
    return { owner: null, sessionId: null, generation: null, contextRevision: null, permissionFingerprint: null }
  const { scope, generation, contextRevision, permissionFingerprint } = handle.snapshot
  return {
    owner: `${scope.tenantId}/${scope.userId}`,
    sessionId: scope.sessionId,
    generation,
    contextRevision,
    permissionFingerprint
  }
}

export interface AskGoal {
  readonly mode: string
  readonly prompt?: string
  readonly kind?: string
  readonly depth?: string
}

/** The goal of a turn: its mode, kind and words, whitespace-normalised. The deeper flag is not part of the goal. */
export function goalDigestOf(ask: AskGoal): string {
  const words = (ask.prompt ?? '').replace(/\s+/g, ' ').trim()
  return createHash('sha256')
    .update(`${ask.mode}\n${ask.kind ?? ''}\n${words}`)
    .digest('hex')
}

export type HandoffRefusal =
  | 'no_fast_turn'
  | 'fast_not_delivered'
  | 'owner_changed'
  | 'permissions_changed'
  | 'context_reset'

export type HandoffPlan =
  | { kind: 'fresh'; turnId: string; stage: 'fast'; refused?: HandoffRefusal }
  | { kind: 'handoff'; turnId: string; stage: 'deep'; supersedes: string; supersededOutcome: StageOutcome }

export interface StageView {
  readonly id: string
  readonly stage: StageName
  readonly outcome: StageOutcome
  readonly supersededBy: string | null
  readonly anchor: HandoffAnchor
}

export interface TurnView {
  readonly turnId: string
  readonly goal: string
  readonly stages: readonly StageView[]
}

export interface TurnLedger {
  /** Registers an ask. A deeper ask of a live fast stage becomes its second stage; anything else opens a new turn. */
  open(ask: AskGoal & { readonly id: string }, anchor: HandoffAnchor): HandoffPlan
  /** The stage finished: `delivered` (published) or `ended` (anything else). Unknown ids are ignored. */
  settle(askId: string, outcome: 'delivered' | 'ended'): void
  turnOf(askId: string): TurnView | undefined
  size(): number
}

/** Turns remembered; the oldest is forgotten first. */
export const MAX_HANDOFF_TURNS = 32
/** A turn nobody touched for this long cannot be handed off any more. */
export const HANDOFF_TTL_MS = 15 * 60 * 1000
const MAX_STAGES = 8

interface Stage {
  id: string
  stage: StageName
  outcome: StageOutcome
  supersededBy: string | null
  anchor: HandoffAnchor
}

interface Turn {
  turnId: string
  goal: string
  touchedAt: number
  stages: Stage[]
}

export function createTurnLedger(deps: { now?: () => number } = {}): TurnLedger {
  const now = deps.now ?? (() => Date.now())
  const turns = new Map<string, Turn>()
  const turnIdOfAsk = new Map<string, string>()

  const forget = (turn: Turn): void => {
    turns.delete(turn.turnId)
    for (const stage of turn.stages) if (turnIdOfAsk.get(stage.id) === turn.turnId) turnIdOfAsk.delete(stage.id)
  }

  const prune = (): void => {
    const cutoff = now() - HANDOFF_TTL_MS
    for (const turn of [...turns.values()]) if (turn.touchedAt < cutoff) forget(turn)
    while (turns.size > MAX_HANDOFF_TURNS) {
      const oldest = turns.values().next().value
      if (!oldest) break
      forget(oldest)
    }
  }

  const live = (turn: Turn): Stage => turn.stages[turn.stages.length - 1]

  const start = (ask: { id: string; mode: string; prompt?: string; kind?: string }, anchor: HandoffAnchor): void => {
    const turn: Turn = {
      turnId: ask.id,
      goal: goalDigestOf(ask),
      touchedAt: now(),
      stages: [{ id: ask.id, stage: 'fast', outcome: 'running', supersededBy: null, anchor }]
    }
    turns.set(turn.turnId, turn)
    turnIdOfAsk.set(ask.id, turn.turnId)
    prune()
  }

  const dropAsk = (askId: string): void => {
    const turnId = turnIdOfAsk.get(askId)
    const turn = turnId === undefined ? undefined : turns.get(turnId)
    if (!turn) return
    if (turn.turnId === askId) return forget(turn)
    turn.stages = turn.stages.filter((s) => s.id !== askId)
    turnIdOfAsk.delete(askId)
  }

  const refusalFor = (before: HandoffAnchor, after: HandoffAnchor): HandoffRefusal | null => {
    if (before.owner !== after.owner) return 'owner_changed'
    if (before.permissionFingerprint !== after.permissionFingerprint) return 'permissions_changed'
    if (
      before.sessionId !== after.sessionId ||
      before.generation !== after.generation ||
      (before.contextRevision !== null && (after.contextRevision ?? -1) < before.contextRevision)
    ) {
      return 'context_reset'
    }
    return null
  }

  return {
    open(ask, anchor) {
      dropAsk(ask.id)
      prune()
      const fresh = (refused?: HandoffRefusal): HandoffPlan => {
        start(ask, anchor)
        return refused
          ? { kind: 'fresh', turnId: ask.id, stage: 'fast', refused }
          : { kind: 'fresh', turnId: ask.id, stage: 'fast' }
      }
      if (ask.depth !== 'deeper') return fresh()

      const goal = goalDigestOf(ask)
      let candidate: Turn | undefined
      for (const turn of [...turns.values()].reverse()) {
        if (turn.goal === goal) {
          candidate = turn
          break
        }
      }
      if (!candidate) return fresh('no_fast_turn')
      const previous = live(candidate)
      if (previous.outcome === 'ended') return fresh('fast_not_delivered')
      const refusal = refusalFor(previous.anchor, anchor)
      if (refusal) return fresh(refusal)

      const supersededOutcome = previous.outcome
      previous.supersededBy = ask.id
      candidate.stages.push({ id: ask.id, stage: 'deep', outcome: 'running', supersededBy: null, anchor })
      if (candidate.stages.length > MAX_STAGES) {
        for (const dropped of candidate.stages.splice(1, candidate.stages.length - MAX_STAGES))
          turnIdOfAsk.delete(dropped.id)
      }
      candidate.touchedAt = now()
      turnIdOfAsk.set(ask.id, candidate.turnId)
      return { kind: 'handoff', turnId: candidate.turnId, stage: 'deep', supersedes: previous.id, supersededOutcome }
    },

    settle(askId, outcome) {
      const turnId = turnIdOfAsk.get(askId)
      const turn = turnId === undefined ? undefined : turns.get(turnId)
      const stage = turn?.stages.find((s) => s.id === askId)
      if (!turn || !stage || stage.outcome !== 'running') return
      stage.outcome = outcome
      turn.touchedAt = now()
    },

    turnOf(askId) {
      const turnId = turnIdOfAsk.get(askId)
      const turn = turnId === undefined ? undefined : turns.get(turnId)
      if (!turn) return undefined
      return { turnId: turn.turnId, goal: turn.goal, stages: turn.stages.map((s) => ({ ...s })) }
    },

    size: () => turns.size
  }
}
