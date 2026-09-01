/**
 * pushQueue.ts — Wave 4: a durable, idempotent retry queue for outbound MCP actions (CRM "push to
 * BidStack", "book next steps" into Plane/ClickUp). mcp:push (index.ts) already makes one live attempt
 * synchronously so the renderer gets an immediate ok/error; this queue is the safety net underneath it —
 * a failed attempt is recorded here instead of lost, and a background tick (processDue) retries it with
 * backoff until it succeeds or is dead-lettered.
 *
 * Persisted as plain JSON under userData/mcp-push-queue.json (NOT under `.brain/` — this is transport
 * bookkeeping, not derived meeting knowledge, so it has no reason to inherit the meetings-folder/OneDrive/
 * at-rest-encryption semantics `.brain/` files do). Same atomic tmp-then-rename write speaker-id.ts's
 * voiceprints.json uses, for the same reason: a crash mid-write must never leave a half-written queue.
 *
 * Confidentiality is enforced HERE, not only at the mcp:push call site, so every current and future
 * enqueuer (a future auto-push from brain consolidation, say) inherits the guarantee for free: a
 * confidential action is never sent, no matter how many times processDue retries it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { mainLog, auditLog } from '../logger'

export type OutboundActionKind = 'create_task' | 'update_deal' | 'log_note'

export interface OutboundAction {
  id: string
  /** The mcpConnections `kind` this action targets (e.g. 'bidstack' | 'plane' | 'clickup') — a plain
   *  string, not shared/ipc.ts's McpConnectionKind enum, so this module has no compile-time dependency
   *  on the IPC layer; callers pass a real connection kind, enforced at the index.ts call site instead. */
  kind: string
  action: OutboundActionKind
  payload: Record<string, unknown>
  attempts: number
  nextAt: number
  lastError?: string
  meetingFile?: string
  /** The actual MCP tool name to call on retry (mcpClient.ts's pushToMcp `toolName`). `action` above is
   *  only the small 3-way classification metrics/audit care about; the tool name is the connection's own
   *  vocabulary (per-connection, operator/user-configured) and is what a retry must call verbatim. */
  toolName: string
  /** Set at enqueue time (see isConfidential) — never sent, ever, regardless of attempts/backoff. */
  confidential?: boolean
  /** Set once `attempts` reaches maxAttempts. Left in place (not deleted) so a dead action is still
   *  inspectable/exportable rather than silently vanishing. */
  deadLetter?: boolean
}

export interface EnqueueInput {
  kind: string
  action: OutboundActionKind
  payload: Record<string, unknown>
  toolName: string
  meetingFile?: string
  confidential?: boolean
  /** Override the derived idempotency key — only needed by a caller replaying a specific known action. */
  id?: string
}

export interface PushResult {
  ok: boolean
  error?: string
  result?: unknown
}

export interface PushQueueDeps {
  storePath?: () => string
  now?: () => number
  maxAttempts?: number
}

const DEFAULT_MAX_ATTEMPTS = 5
const ACTION_KINDS = new Set<OutboundActionKind>(['create_task', 'update_deal', 'log_note'])
// Small, deterministic backoff steps (mirrors provider-health.ts's cooldown shape) rather than a raw
// exponent that could balloon to hours after just a few failures — an MCP endpoint being briefly
// unreachable should retry within the hour, not tomorrow.
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000]

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)]
}

/** Deterministic id from the action's own content — same kind+toolName+meetingFile+payload enqueued
 *  twice (e.g. mcp:push's own failure-path enqueue running again after a renderer retry) collapses to
 *  the SAME queue entry instead of sending the same CRM write twice. */
export function outboundActionId(
  input: Pick<EnqueueInput, 'kind' | 'toolName' | 'meetingFile' | 'payload'>
): string {
  const basis = JSON.stringify([input.kind, input.toolName, input.meetingFile ?? '', input.payload])
  return createHash('sha256').update(basis).digest('hex').slice(0, 24)
}

function contentId(input: Pick<EnqueueInput, 'kind' | 'toolName' | 'meetingFile' | 'payload'>): string {
  return outboundActionId(input)
}

/** "Check payload or flag": a caller may mark an action confidential either directly (enqueue's own
 *  `confidential`) or by putting `confidential: true` inside the payload itself — Review.tsx's push
 *  payload is a flat object McpArgValueSchema already allows a boolean value in, so a future caller can
 *  set this with no IPC schema change at all. Either spelling is normalized onto the action's own
 *  top-level flag at enqueue time (see enqueue below), so every later check only ever reads one place. */
function isConfidential(input: { confidential?: boolean; payload: Record<string, unknown> }): boolean {
  return input.confidential === true || input.payload?.confidential === true
}

/** Coerce a hand-edited / corrupt on-disk row into a safe OutboundAction, or drop it. Without this,
 *  `attempts: "oops"` becomes NaN after `+= 1` and `NaN >= maxAttempts` is forever false → infinite
 *  retry. Same for a missing nextAt (always "due"). */
function sanitizeAction(raw: unknown): OutboundAction | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (typeof a.id !== 'string' || !a.id) return null
  if (typeof a.kind !== 'string' || !a.kind) return null
  if (typeof a.action !== 'string' || !ACTION_KINDS.has(a.action as OutboundActionKind)) return null
  if (typeof a.toolName !== 'string' || !a.toolName) return null
  if (!a.payload || typeof a.payload !== 'object' || Array.isArray(a.payload)) return null
  const attemptsRaw = typeof a.attempts === 'number' && Number.isFinite(a.attempts) ? a.attempts : 0
  const attempts = Math.max(0, Math.floor(attemptsRaw))
  const nextAt =
    typeof a.nextAt === 'number' && Number.isFinite(a.nextAt) ? a.nextAt : 0
  const out: OutboundAction = {
    id: a.id,
    kind: a.kind,
    action: a.action as OutboundActionKind,
    payload: a.payload as Record<string, unknown>,
    toolName: a.toolName,
    attempts,
    nextAt
  }
  if (typeof a.lastError === 'string') out.lastError = a.lastError
  if (typeof a.meetingFile === 'string') out.meetingFile = a.meetingFile
  if (a.confidential === true) out.confidential = true
  if (a.deadLetter === true) out.deadLetter = true
  return out
}

export interface ProcessDueResult {
  processed: number
  succeeded: number
  deadLettered: number
  skippedConfidential: number
}

export interface ProcessIdResult {
  id: string
  ok: boolean
  error?: string
  deadLetter: boolean
  attempts: number
  skippedConfidential: boolean
  result?: unknown
}

export interface PushQueue {
  enqueue: (input: EnqueueInput) => OutboundAction
  /** Attempts every due, non-confidential, non-dead-lettered action via `pushFn`. Never throws — a
   *  `pushFn` rejection is treated the same as `{ ok: false, error }`. Single-flight: a second call
   *  while one is in progress returns zeros immediately (never double-sends the same action). */
  processDue: (pushFn: (action: OutboundAction) => Promise<PushResult>) => Promise<ProcessDueResult>
  /** Tony Operator Retry: process these ids now (still confidential-blocked, still bounded). */
  processIds: (
    ids: string[],
    pushFn: (action: OutboundAction) => Promise<PushResult>
  ) => Promise<ProcessDueResult & { results: ProcessIdResult[] }>
  get: (id: string) => OutboundAction | undefined
  /** Clear dead-letter and make due. Confidential rows stay unsent. */
  requeue: (id: string) => OutboundAction | null
  pending: () => OutboundAction[]
}

const EMPTY_RESULT: ProcessDueResult = { processed: 0, succeeded: 0, deadLettered: 0, skippedConfidential: 0 }

export function createPushQueue(deps: PushQueueDeps = {}): PushQueue {
  const storePath = deps.storePath ?? (() => join(app.getPath('userData'), 'mcp-push-queue.json'))
  const now = deps.now ?? (() => Date.now())
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  let actions: OutboundAction[] | null = null
  /** Single-flight lock — overlapping timer ticks must not process the same row twice in parallel. */
  let processing = false

  const load = (): OutboundAction[] => {
    if (actions) return actions
    try {
      const parsed = JSON.parse(readFileSync(storePath(), 'utf8')) as { actions?: unknown }
      const raw = Array.isArray(parsed.actions) ? parsed.actions : []
      actions = raw.map(sanitizeAction).filter((a): a is OutboundAction => a !== null)
    } catch {
      actions = [] // absent or corrupt — treated as an empty queue, never a crash
    }
    return actions
  }
  const save = (): void => {
    try {
      const p = storePath()
      mkdirSync(dirname(p), { recursive: true })
      const tmp = `${p}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, actions: load() }, null, 2), { mode: 0o600 })
      renameSync(tmp, p)
    } catch (e) {
      mainLog.warn('[mcp-push-queue] save failed', e instanceof Error ? e.message : String(e))
    }
  }

  function enqueue(input: EnqueueInput): OutboundAction {
    const list = load()
    const id = input.id ?? contentId(input)
    const existing = list.find((a) => a.id === id)
    if (existing) return existing // idempotent: the same logical action never queues twice
    const action: OutboundAction = {
      id,
      kind: input.kind,
      action: input.action,
      payload: input.payload,
      toolName: input.toolName,
      attempts: 0,
      nextAt: now(),
      ...(input.meetingFile ? { meetingFile: input.meetingFile } : {}),
      ...(isConfidential(input) ? { confidential: true } : {})
    }
    list.push(action)
    save()
    auditLog('mcp.push.queued', { kind: action.kind, action: action.action, confidential: !!action.confidential })
    return action
  }

  async function runBatch(
    pushFn: (action: OutboundAction) => Promise<PushResult>,
    onlyIds: Set<string> | null
  ): Promise<ProcessDueResult & { results: ProcessIdResult[] }> {
    if (processing) return { ...EMPTY_RESULT, results: [] }
    processing = true
    try {
      const list = load()
      const t = now()
      let processed = 0
      let succeeded = 0
      let deadLettered = 0
      let skippedConfidential = 0
      const results: ProcessIdResult[] = []
      for (const action of [...list]) {
        if (onlyIds) {
          if (!onlyIds.has(action.id)) continue
        } else if (action.deadLetter || action.nextAt > t) {
          continue
        }
        if (isConfidential(action)) {
          skippedConfidential++
          auditLog('mcp.push.skipped_confidential', { kind: action.kind, action: action.action })
          results.push({
            id: action.id,
            ok: false,
            error: 'confidential',
            deadLetter: !!action.deadLetter,
            attempts: action.attempts,
            skippedConfidential: true
          })
          continue
        }
        processed++
        let result: PushResult
        try {
          result = await pushFn(action)
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
        if (result.ok) {
          succeeded++
          const idx = list.indexOf(action)
          if (idx !== -1) list.splice(idx, 1)
          results.push({
            id: action.id,
            ok: true,
            deadLetter: false,
            attempts: action.attempts,
            skippedConfidential: false,
            result: result.result
          })
          continue
        }
        const prev = Number.isFinite(action.attempts) ? action.attempts : 0
        action.attempts = prev + 1
        action.lastError = result.error
        if (action.attempts >= maxAttempts) {
          action.deadLetter = true
          deadLettered++
          auditLog('mcp.push.dead_letter', { kind: action.kind, action: action.action, attempts: action.attempts })
        } else {
          action.nextAt = now() + backoffFor(action.attempts)
          auditLog('mcp.push.retried', { kind: action.kind, action: action.action, attempts: action.attempts })
        }
        results.push({
          id: action.id,
          ok: false,
          error: result.error,
          deadLetter: !!action.deadLetter,
          attempts: action.attempts,
          skippedConfidential: false
        })
      }
      save()
      return { processed, succeeded, deadLettered, skippedConfidential, results }
    } finally {
      processing = false
    }
  }

  async function processDue(
    pushFn: (action: OutboundAction) => Promise<PushResult>
  ): Promise<ProcessDueResult> {
    const r = await runBatch(pushFn, null)
    return {
      processed: r.processed,
      succeeded: r.succeeded,
      deadLettered: r.deadLettered,
      skippedConfidential: r.skippedConfidential
    }
  }

  async function processIds(
    ids: string[],
    pushFn: (action: OutboundAction) => Promise<PushResult>
  ): Promise<ProcessDueResult & { results: ProcessIdResult[] }> {
    return runBatch(pushFn, new Set(ids.filter(Boolean)))
  }

  function get(id: string): OutboundAction | undefined {
    return load().find((a) => a.id === id)
  }

  function requeue(id: string): OutboundAction | null {
    const list = load()
    const action = list.find((a) => a.id === id)
    if (!action) return null
    if (isConfidential(action)) return null
    delete action.deadLetter
    action.attempts = 0
    action.nextAt = now()
    save()
    auditLog('mcp.push.operator_requeue', { kind: action.kind, action: action.action })
    return action
  }

  function pending(): OutboundAction[] {
    return [...load()]
  }

  return { enqueue, processDue, processIds, get, requeue, pending }
}

/** Process-wide singleton — the queue main/index.ts's mcp:push handler and the retry timer both use. */
export const pushQueue: PushQueue = createPushQueue()
