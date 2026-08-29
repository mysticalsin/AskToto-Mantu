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
}

export interface PushQueueDeps {
  storePath?: () => string
  now?: () => number
  maxAttempts?: number
}

const DEFAULT_MAX_ATTEMPTS = 5
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
function contentId(input: Pick<EnqueueInput, 'kind' | 'toolName' | 'meetingFile' | 'payload'>): string {
  const basis = JSON.stringify([input.kind, input.toolName, input.meetingFile ?? '', input.payload])
  return createHash('sha256').update(basis).digest('hex').slice(0, 24)
}

/** "Check payload or flag": a caller may mark an action confidential either directly (enqueue's own
 *  `confidential`) or by putting `confidential: true` inside the payload itself — Review.tsx's push
 *  payload is a flat object McpArgValueSchema already allows a boolean value in, so a future caller can
 *  set this with no IPC schema change at all. Either spelling is normalized onto the action's own
 *  top-level flag at enqueue time (see enqueue below), so every later check only ever reads one place. */
function isConfidential(input: { confidential?: boolean; payload: Record<string, unknown> }): boolean {
  return input.confidential === true || input.payload?.confidential === true
}

export interface PushQueue {
  enqueue: (input: EnqueueInput) => OutboundAction
  /** Attempts every due, non-confidential, non-dead-lettered action via `pushFn`. Never throws — a
   *  `pushFn` rejection is treated the same as `{ ok: false, error }`. */
  processDue: (pushFn: (action: OutboundAction) => Promise<PushResult>) => Promise<{
    processed: number
    succeeded: number
    deadLettered: number
    skippedConfidential: number
  }>
  pending: () => OutboundAction[]
}

export function createPushQueue(deps: PushQueueDeps = {}): PushQueue {
  const storePath = deps.storePath ?? (() => join(app.getPath('userData'), 'mcp-push-queue.json'))
  const now = deps.now ?? (() => Date.now())
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  let actions: OutboundAction[] | null = null
  const load = (): OutboundAction[] => {
    if (actions) return actions
    try {
      const parsed = JSON.parse(readFileSync(storePath(), 'utf8')) as { actions?: OutboundAction[] }
      actions = Array.isArray(parsed.actions) ? parsed.actions : []
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

  async function processDue(
    pushFn: (action: OutboundAction) => Promise<PushResult>
  ): Promise<{ processed: number; succeeded: number; deadLettered: number; skippedConfidential: number }> {
    const list = load()
    const t = now()
    let processed = 0
    let succeeded = 0
    let deadLettered = 0
    let skippedConfidential = 0
    for (const action of list) {
      if (action.deadLetter || action.nextAt > t) continue
      // Never process if the meeting is confidential — checked on every tick, not only at enqueue time,
      // so this holds even if a future caller ever mutates payload/confidential after enqueueing.
      if (isConfidential(action)) {
        skippedConfidential++
        auditLog('mcp.push.skipped_confidential', { kind: action.kind, action: action.action })
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
        continue
      }
      action.attempts += 1
      action.lastError = result.error
      if (action.attempts >= maxAttempts) {
        action.deadLetter = true
        deadLettered++
        auditLog('mcp.push.dead_letter', { kind: action.kind, action: action.action, attempts: action.attempts })
      } else {
        action.nextAt = now() + backoffFor(action.attempts)
        auditLog('mcp.push.retried', { kind: action.kind, action: action.action, attempts: action.attempts })
      }
    }
    save()
    return { processed, succeeded, deadLettered, skippedConfidential }
  }

  function pending(): OutboundAction[] {
    return [...load()]
  }

  return { enqueue, processDue, pending }
}

/** Process-wide singleton — the queue main/index.ts's mcp:push handler and the retry timer both use. */
export const pushQueue: PushQueue = createPushQueue()
