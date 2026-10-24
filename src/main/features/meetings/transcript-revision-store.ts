import { AuditEventRecordSchema, type AuditEventRecord } from '@shared/contracts/audit-event'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import {
  applyRevisionEvent,
  DEFAULT_REVISION_LIMITS,
  emptyTranscriptRevision,
  type ApplyResult,
  type RevisionEvent,
  type RevisionLimits,
  type TranscriptRevision,
  type TranscriptRevisionDelta,
  type TranscriptSegment
} from '@shared/contracts/speech/transcript-revision'
import type { InputSessionStopReason } from '@shared/input-session'

export type CheckpointWriteOutcome = 'written' | 'sealed' | 'absent' | 'failed'
export type CheckpointResult =
  | { ok: true; revision: number }
  | { ok: false; error: 'sealed' | 'write-failed' | 'auth-changed' | 'absent' }
/** Rewrites the meeting's autosave drafts with `rev`; never creates a file. */
export type CheckpointWriter = (meetingStartedAt: number, rev: TranscriptRevision) => Promise<CheckpointWriteOutcome>

export type FrameOwner = `${number}:${number}`

export interface TranscriptStoreBinding {
  readonly meetingStartedAt: number
  readonly frameOwner: FrameOwner
  readonly owner: OwnerSessionRef | null
}

export type TranscriptStoreOpenResult = { ok: true } | { ok: false; reason: 'closed' | 'bound-elsewhere' | 'invalid' }

export interface TranscriptRevisionStore {
  open(binding: TranscriptStoreBinding): TranscriptStoreOpenResult
  apply(binding: TranscriptStoreBinding, ev: RevisionEvent): ApplyResult
  snapshot(meetingStartedAt: number): TranscriptRevision | null
  /** True while any meeting is open (recording): the probe data-rights erasure refuses on. Read only. */
  hasOpenSession(): boolean
  bindingOf(meetingStartedAt: number): { frameOwner: FrameOwner; ownerKey: string | null } | null
  finalize(binding: TranscriptStoreBinding): ApplyResult
  /** Releases the meeting and makes one best-effort checkpoint of its closing snapshot. */
  close(meetingStartedAt: number, reason: InputSessionStopReason): void
  /** Closes every open meeting owned by the owner session and returns the closed meetingStartedAt ids. */
  closeOwnedBy(sessionId: string, reason: InputSessionStopReason): number[]
  /** Stamps the meeting's current revision into its autosave drafts. Never throws, never emits onChange. */
  checkpoint(meetingStartedAt: number): Promise<CheckpointResult>
  onChange(listener: (delta: TranscriptRevisionDelta) => void): () => void
}

export interface TranscriptRevisionStoreDeps {
  limits?: RevisionLimits
  now?: () => number
  audit?: (event: 'ipc.refused', detail: AuditEventRecord) => void
  checkpointWriter?: CheckpointWriter
  authGeneration?: () => number
}

interface Entry {
  rev: TranscriptRevision
  readonly frameOwner: FrameOwner
  readonly owner: OwnerSessionRef | null
}

const FRAME_OWNER = /^\d+:\d+$/
const CLOSED_CAP = 64

function ownerMatches(opened: OwnerSessionRef | null, presented: OwnerSessionRef | null): boolean {
  // A session opened signed out stays usable after a mid-meeting sign-in on the same frame.
  if (opened === null) return true
  return (
    presented !== null && presented.ownerKey === opened.ownerKey && presented.authGeneration === opened.authGeneration
  )
}

export function createTranscriptRevisionStore(deps: TranscriptRevisionStoreDeps = {}): TranscriptRevisionStore {
  const limits = deps.limits ?? DEFAULT_REVISION_LIMITS
  const now = deps.now ?? Date.now
  const entries = new Map<number, Entry>()
  const closed = new Set<number>()
  const listeners = new Set<(delta: TranscriptRevisionDelta) => void>()

  const audit = (binding: TranscriptStoreBinding, reason: 'wrong-frame' | 'wrong-owner'): void => {
    try {
      const record = AuditEventRecordSchema.parse({
        v: 1,
        event: 'ipc.refused',
        ownerKey: binding.owner?.ownerKey ?? null,
        sessionId: binding.owner?.sessionId ?? null,
        surface: 'transcript.apply',
        outcome: 'refused',
        reason,
        privacyClass: 'P1',
        ts: now()
      })
      deps.audit?.('ipc.refused', record)
    } catch {
      // auditing is best effort and never changes the result
    }
  }

  // Starts synchronously (the auth check, the revision capture and the writer's own admission all run before
  // the first await), so a caller sealing right after this call still joins the write.
  const checkpointEntry = async (
    meetingStartedAt: number,
    entry: Entry,
    rev: TranscriptRevision
  ): Promise<CheckpointResult> => {
    // A meeting opened signed out (owner null) is never refused by an auth generation change.
    if (entry.owner !== null && deps.authGeneration && deps.authGeneration() !== entry.owner.authGeneration) {
      return { ok: false, error: 'auth-changed' }
    }
    const writer = deps.checkpointWriter
    if (!writer) return { ok: false, error: 'write-failed' }
    let outcome: CheckpointWriteOutcome
    try {
      outcome = await writer(meetingStartedAt, rev)
    } catch {
      outcome = 'failed'
    }
    switch (outcome) {
      case 'written':
        return { ok: true, revision: rev.revision }
      case 'sealed':
        return { ok: false, error: 'sealed' }
      case 'absent':
        return { ok: false, error: 'absent' }
      default:
        return { ok: false, error: 'write-failed' }
    }
  }

  const checkpoint = (meetingStartedAt: number): Promise<CheckpointResult> => {
    const entry = entries.get(meetingStartedAt)
    if (!entry) return Promise.resolve({ ok: false, error: 'sealed' })
    // Captured before any await: later applies must not change what this call writes.
    return checkpointEntry(meetingStartedAt, entry, entry.rev)
  }

  // The reason is for the caller's audit trail; every reason releases the same way. There is no closure audit
  // event in the catalog yet; none is added here. WP03-S15: the closing snapshot gets one checkpoint attempt.
  const close = (meetingStartedAt: number, _reason: InputSessionStopReason): void => {
    const entry = entries.get(meetingStartedAt)
    entries.delete(meetingStartedAt)
    closed.add(meetingStartedAt)
    while (closed.size > CLOSED_CAP) {
      const oldest = closed.values().next().value
      if (oldest === undefined) break
      closed.delete(oldest)
    }
    if (entry) void checkpointEntry(meetingStartedAt, entry, entry.rev)
  }

  const emit = (delta: TranscriptRevisionDelta): void => {
    for (const listener of [...listeners]) {
      try {
        listener(delta)
      } catch {
        // one throwing listener never stops the others
      }
    }
  }

  const apply = (binding: TranscriptStoreBinding, ev: RevisionEvent): ApplyResult => {
    const entry = entries.get(binding.meetingStartedAt)
    if (!entry) return { ok: false, reason: 'invalid' }
    if (entry.frameOwner !== binding.frameOwner) {
      audit(binding, 'wrong-frame')
      return { ok: false, reason: 'invalid' }
    }
    if (!ownerMatches(entry.owner, binding.owner)) {
      audit(binding, 'wrong-owner')
      return { ok: false, reason: 'invalid' }
    }
    const result = applyRevisionEvent(entry.rev, ev, limits)
    if (!result.ok) return result
    entry.rev = result.next
    const byId = new Map(result.next.segments.map((segment) => [segment.segmentId, segment]))
    const changed = result.changed
      .map((id) => byId.get(id))
      .filter((segment): segment is TranscriptSegment => segment !== undefined)
    emit({
      meetingStartedAt: binding.meetingStartedAt,
      revision: result.next.revision,
      changed,
      finalized: result.next.finalized
    })
    return result
  }

  return {
    open(binding) {
      const id = binding.meetingStartedAt
      if (!Number.isSafeInteger(id) || id <= 0 || !FRAME_OWNER.test(binding.frameOwner)) {
        return { ok: false, reason: 'invalid' }
      }
      if (closed.has(id)) return { ok: false, reason: 'closed' }
      const existing = entries.get(id)
      if (existing) {
        return existing.frameOwner === binding.frameOwner && ownerMatches(existing.owner, binding.owner)
          ? { ok: true }
          : { ok: false, reason: 'bound-elsewhere' }
      }
      for (const other of [...entries.keys()]) close(other, 'owner-replaced')
      entries.set(id, { rev: emptyTranscriptRevision(id), frameOwner: binding.frameOwner, owner: binding.owner })
      return { ok: true }
    },
    apply,
    snapshot(meetingStartedAt) {
      return entries.get(meetingStartedAt)?.rev ?? null
    },
    hasOpenSession: () => entries.size > 0,
    bindingOf(meetingStartedAt) {
      const entry = entries.get(meetingStartedAt)
      return entry ? { frameOwner: entry.frameOwner, ownerKey: entry.owner?.ownerKey ?? null } : null
    },
    finalize(binding) {
      return apply(binding, { kind: 'finalize' })
    },
    close,
    closeOwnedBy(sessionId, reason) {
      const closedIds: number[] = []
      for (const [id, entry] of [...entries]) {
        // Decision: a meeting opened signed out (owner null) is never closed by an owner revocation.
        if (entry.owner !== null && entry.owner.sessionId === sessionId) {
          close(id, reason)
          closedIds.push(id)
        }
      }
      return closedIds
    },
    checkpoint,
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
