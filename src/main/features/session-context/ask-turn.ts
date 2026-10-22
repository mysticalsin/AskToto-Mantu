import { ContractError } from '@shared/kernel/contract-data'
import { IPC } from '@shared/ipc'
import { isModeSkillIntegrityError } from '@shared/mode-skills'
import type { CounterMetricId } from '@shared/responsiveness-metrics'
import { anchorOf, createTurnLedger, type AskGoal, type HandoffPlan, type TurnLedger } from './ask-handoff'
import type { AskJob, ContextHandle } from './meeting-context-registry'

/** Shown when the context an answer was built from went stale while it was running (stop, permissions, meeting end). */
export const STALE_ANSWER_MESSAGE = 'The conversation changed, so this answer was stopped. Ask again.'
export const ANSWER_TIMEOUT_MESSAGE = 'This answer took too long and was stopped. Try again.'
/** Shown instead of silently ignoring a third request while one answer runs and two more are waiting. */
export const QUEUE_BUSY_MESSAGE = 'Métis is still working on earlier requests. Try again in a moment.'

/** What a request that could not start tells the renderer: a skill integrity failure names itself, the rest do not. */
export const askStartFailureMessage = (err: unknown): string =>
  isModeSkillIntegrityError(err) ? (err instanceof Error ? err.message : String(err)) : 'Could not start the answer.'

/** A live suggestion that has not landed in this long is no longer about the moment it was asked in. */
export const SUGGEST_JOB_TIMEOUT_MS = 30_000
/** Answers outlive the queue default: deep reasoning and recaps legitimately stream for minutes. */
export const ANSWER_JOB_TIMEOUT_MS = 240_000

/**
 * Why a turn ended without a terminal event of its own. `cancelled` (the renderer already let go) and `superseded`
 * (a deep stage took over the turn, G29) are silent.
 */
export type TurnStopReason = 'cancelled' | 'superseded' | 'stale' | 'timeout' | 'closed' | 'full'

const MESSAGES: Record<Exclude<TurnStopReason, 'cancelled' | 'superseded'>, string> = {
  stale: STALE_ANSWER_MESSAGE,
  closed: STALE_ANSWER_MESSAGE,
  timeout: ANSWER_TIMEOUT_MESSAGE,
  full: QUEUE_BUSY_MESSAGE
}

export function stopReasonOf(error: unknown): TurnStopReason {
  if (!(error instanceof ContractError)) return 'stale'
  switch (error.code) {
    case 'QUEUE_FULL':
      return 'full'
    case 'TASK_TIMEOUT':
      return 'timeout'
    case 'QUEUE_CLOSED':
    case 'SESSION_STOPPED':
      return 'closed'
    case 'TASK_CANCELLED':
      return 'cancelled'
    default:
      return 'stale'
  }
}

/** One ask's right to publish. Every event bound for the renderer goes through `send`; a stale turn sends nothing. */
export interface AskTurn {
  /** Publishes one renderer event while this turn is current. Returns false (and sends nothing) once it is not. */
  send(channel: string, payload: unknown): boolean
}

export interface AskTurnsDeps {
  /** Delivers one event to the window that owns the ask. */
  send(channel: string, payload: unknown): void
  /** The in-flight asks' abort handles (the main process's `streams` map): a stopped turn aborts its provider stream. */
  streams: {
    get(id: string): { abort(): void } | undefined
    delete(id: string): unknown
  }
  /** The fast-to-deep turn ledger (G29). One is created when none is given. */
  ledger?: TurnLedger
  /** Counts only (G12). A sink that throws never affects an ask. */
  metrics?: { increment(id: CounterMetricId): void }
}

export interface AskTurnRequest {
  readonly id: string
  readonly mode: string
  /** The meeting snapshot the prompt was built from, or null when the ask has no live meeting behind it. */
  readonly handle: ContextHandle | null
  /**
   * The ask's goal (G29). Given, the ask joins the turn ledger: a deeper ask of a live fast stage becomes the second
   * stage of that turn and supersedes the first. Absent, the ask is queued exactly as before.
   */
  readonly ask?: AskGoal
}

export interface AskTurns {
  /**
   * Waits for this ask's turn on its meeting's SessionQueue. Resolves with the turn once it may run, or with null
   * when it never will: cancelled while waiting (silent), refused because the queue is full, or outdated before its
   * turn came (the renderer is told once, with a message). An ask with no live meeting runs straight away.
   */
  begin(request: AskTurnRequest): Promise<AskTurn | null>
  /** The renderer cancelled: abort the stream, free the queue slot, tell nobody. */
  cancel(id: string): void
  /** The ask failed before or outside its stream (a start failure, a gate refusal): one error to the renderer, slot freed. */
  fail(id: string, message: string): void
}

interface Entry {
  readonly id: string
  state: 'queued' | 'running' | 'ended'
  /** The terminal answer went out (G29: a delivered stage may be handed off). */
  delivered: boolean
  release: (() => void) | null
  settleBegin: (turn: AskTurn | null) => void
}

export function createAskTurns(deps: AskTurnsDeps): AskTurns {
  const entries = new Map<string, Entry>()
  const ledger = deps.ledger ?? createTurnLedger()
  const count = (id: CounterMetricId): void => {
    try {
      deps.metrics?.increment(id)
    } catch {
      // a metric must never affect an ask
    }
  }

  const finish = (entry: Entry): void => {
    if (entry.state === 'ended') return
    entry.state = 'ended'
    ledger.settle(entry.id, entry.delivered ? 'delivered' : 'ended')
    if (entries.get(entry.id) === entry) entries.delete(entry.id)
    entry.settleBegin(null)
    entry.release?.()
  }

  const stop = (entry: Entry, reason: TurnStopReason): void => {
    if (entry.state === 'ended') return
    finish(entry)
    try {
      deps.streams.get(entry.id)?.abort()
      deps.streams.delete(entry.id)
    } catch {
      // a stream that cannot be stopped must not keep the slot
    }
    if (reason !== 'cancelled' && reason !== 'superseded') {
      deps.send(IPC.streamError, { id: entry.id, message: MESSAGES[reason] })
    }
  }

  /**
   * Joins the ask to the turn ledger. A deeper ask that keeps a live fast stage's identity takes over that turn: the
   * fast stage is stopped silently (its slot freed before the deep stage queues) or, if it already delivered, its
   * output is retired so a later correction names the deep output only (G29).
   */
  const joinTurn = (request: AskTurnRequest, ask: AskGoal): void => {
    const plan: HandoffPlan = ledger.open({ id: request.id, ...ask }, anchorOf(request.handle))
    if (plan.kind === 'fresh') {
      if (plan.refused) count('handoff_refused')
      return
    }
    count('handoff_started')
    count('handoff_superseded')
    const previous = entries.get(plan.supersedes)
    if (previous) stop(previous, 'superseded')
    else if (plan.supersededOutcome === 'running') {
      try {
        deps.streams.get(plan.supersedes)?.abort()
        deps.streams.delete(plan.supersedes)
      } catch {
        // a stream that cannot be stopped must not keep the new stage from starting
      }
    }
    request.handle?.retireOutput(plan.supersedes)
  }

  const turnFor = (entry: Entry, job: AskJob, handle: ContextHandle): AskTurn => ({
    send(channel, payload) {
      if (entry.state !== 'running') return false
      if (job.check().state === 'stale') {
        stop(entry, 'stale')
        return false
      }
      deps.send(channel, payload)
      // A delivered answer is remembered against the lines it read, so a later correction can name it (G15).
      if (channel === IPC.streamDone) {
        entry.delivered = true
        handle.recordOutput(entry.id)
      }
      if (channel === IPC.streamDone || channel === IPC.streamError) finish(entry)
      return true
    }
  })

  return {
    begin(request) {
      const { id, mode, handle } = request
      if (request.ask) joinTurn(request, request.ask)
      if (!handle) {
        return Promise.resolve<AskTurn>({
          send(channel, payload) {
            deps.send(channel, payload)
            if (channel === IPC.streamDone) ledger.settle(id, 'delivered')
            else if (channel === IPC.streamError) ledger.settle(id, 'ended')
            return true
          }
        })
      }
      const previous = entries.get(id)
      if (previous) stop(previous, 'cancelled')
      return new Promise<AskTurn | null>((settleBegin) => {
        const entry: Entry = { id, state: 'queued', delivered: false, release: null, settleBegin }
        entries.set(id, entry)
        handle
          .enqueue(
            (job) =>
              new Promise<void>((release) => {
                entry.release = release
                // Cancelled or outdated while it waited: its turn comes and goes without work.
                if (entry.state === 'ended') return release()
                entry.state = 'running'
                job.signal.addEventListener('abort', () => stop(entry, stopReasonOf(job.signal.reason)), { once: true })
                if (job.check().state === 'stale') return stop(entry, 'stale')
                settleBegin(turnFor(entry, job, handle))
              }),
            { timeoutMs: mode === 'suggest' ? SUGGEST_JOB_TIMEOUT_MS : ANSWER_JOB_TIMEOUT_MS }
          )
          .catch((error: unknown) => stop(entry, stopReasonOf(error)))
      })
    },
    cancel(id) {
      const entry = entries.get(id)
      if (entry) stop(entry, 'cancelled')
      ledger.settle(id, 'ended')
    },
    fail(id, message) {
      deps.send(IPC.streamError, { id, message })
      const entry = entries.get(id)
      if (entry) finish(entry)
      ledger.settle(id, 'ended')
    }
  }
}
