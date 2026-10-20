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

// checkpoint() is intentionally not part of this slice. It lands with WP03-S03, which needs the patch 0013 decision.

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
  bindingOf(meetingStartedAt: number): { frameOwner: FrameOwner; ownerKey: string | null } | null
  finalize(binding: TranscriptStoreBinding): ApplyResult
  close(meetingStartedAt: number, reason: InputSessionStopReason): void
  /** Closes every open meeting owned by the owner session and returns the closed meetingStartedAt ids. */
  closeOwnedBy(sessionId: string, reason: InputSessionStopReason): number[]
  onChange(listener: (delta: TranscriptRevisionDelta) => void): () => void
}

export interface TranscriptRevisionStoreDeps {
  limits?: RevisionLimits
  now?: () => number
  audit?: (event: 'ipc.refused', detail: AuditEventRecord) => void
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

  // The reason is for the caller's audit trail; S02 releases the same way for every reason.
  // There is no closure audit event in the catalog yet; none is added here.
  const close = (meetingStartedAt: number, _reason: InputSessionStopReason): void => {
    entries.delete(meetingStartedAt)
    closed.add(meetingStartedAt)
    while (closed.size > CLOSED_CAP) {
      const oldest = closed.values().next().value
      if (oldest === undefined) break
      closed.delete(oldest)
    }
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
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
