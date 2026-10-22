import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import { ContractError, type JsonValue } from '@shared/kernel/contract-data'
import { SessionContext, type ContextSnapshot, type SessionOutputKind } from '@shared/kernel/session-context'
import { SessionQueue } from '@shared/kernel/session-queue'
import { sessionScopeFor, type SessionScope } from '@shared/kernel/session-scope'
import { TranscriptLedger, TranscriptLedgerError, type TranscriptLedgerEvent } from '@shared/kernel/transcript-ledger'
import { speechSegmentToLedgerEvent } from '@shared/transcript-line-identity'

type SegmentEvent = Extract<CloudSpeechEvent, { type: 'segment' }>

export interface FrameKey {
  readonly processId: number
  readonly routingId: number
}

export interface MeetingScope {
  readonly scope: SessionScope
  readonly ownerKey: string
}

export interface MeetingContextRegistryDeps {
  /** The trusted scope for a frame's meeting, or null when nothing may be scoped (signed out). */
  resolveScope(frame: FrameKey, meetingStartedAt: number): MeetingScope | null
  /** The current permission set. Read at every snapshot and every freshness check; a change invalidates. */
  permissions(): readonly string[]
  /** Metadata-only: a ledger refusal code that left the context degraded. Never receives transcript text. */
  onDegraded?(code: string): void
  /** Queue health (G12 `queue_wait_ms`, `queue_depth_peak`). Counts and durations only; absent until G12 is plugged in. */
  queueHealth?: QueueHealthSink
  /** Monotonic milliseconds, injectable for tests. */
  now?(): number
}

/** The two G12 recorder methods this registry feeds. Structurally the responsiveness recorder's subset. */
export interface QueueHealthSink {
  recordLatency(id: 'queue_wait_ms', ms: number): void
  observePeak(id: 'queue_depth_peak', value: number): void
}

/** One ask's place in a meeting's queue: it stops when the context it was built from goes stale. */
export interface AskJob {
  /** Aborted when the job is outdated (stop, permissions, screen, knowledge), times out, or the meeting ends. */
  readonly signal: AbortSignal
  /** Whether this job's snapshot may still publish. Same contract as `ContextHandle.check`. */
  check(): ContextCheck
}

export interface EnqueueOptions {
  /** This job's own deadline in milliseconds (a streamed answer outlives the queue default). */
  readonly timeoutMs?: number
}

/** Whether work started from a snapshot may still publish. `advanced` means only transcript text moved on. */
export type ContextCheck =
  | { readonly state: 'current' }
  | { readonly state: 'advanced' }
  | { readonly state: 'stale'; readonly code: string }

export interface ContextHandle {
  readonly meetingStartedAt: number
  readonly snapshot: ContextSnapshot
  /** Re-reads permissions, then asks the issuing SessionContext whether this snapshot is still the one in force. */
  check(): ContextCheck
  /**
   * Runs `work` as a job on this meeting's SessionQueue: one active job, at most `ASK_QUEUE_MAX_PENDING` waiting, a
   * deadline, and abort on any change that outdates the snapshot (a new transcript line does not). Resolves with the
   * work's value; rejects with a ContractError (`QUEUE_FULL`, `TASK_INVALIDATED`, `TASK_TIMEOUT`, `QUEUE_CLOSED`, ...).
   * The queue is disposed when the meeting ends or its owner session is revoked.
   */
  enqueue<T>(work: (job: AskJob) => PromiseLike<T> | T, options?: EnqueueOptions): Promise<T>
}

export interface MeetingContextRegistry {
  /** One delivered relay segment. Finals only reach the ledger; partials are never usable context. */
  ingestDelivered(frame: FrameKey, meetingStartedAt: number, event: CloudSpeechEvent): void
  /** One line a renderer-side engine committed (local ASR, legacy cloud). */
  ingestLocalLine(
    frame: FrameKey,
    line: {
      startedAt: number
      t: number
      speaker: 'you' | 'them' | 'unknown'
      text: string
      name?: string
      lang?: string
    }
  ): boolean
  retractLocalLine(frame: FrameKey, line: { startedAt: number; t: number }): boolean
  /** A speaker name or language tag for a line, by its local commit time or its relay utterance id. */
  labelLine(
    frame: FrameKey,
    line: { startedAt: number; t?: number; utteranceId?: string; name?: string; lang?: string }
  ): boolean
  /**
   * The screen source main is observing changed (G16): a different display or region, or `null` once access to the
   * screen was withdrawn. Moves every open meeting's context, so an ask or suggestion still running from a snapshot
   * of the previous screen is outdated and stops. The same source seen again moves nothing.
   */
  observeScreen(sourceId: string | null, observedAtMs: number): void
  /** A snapshot for the meeting bound to this frame, or null when none is open (or the owner changed). */
  acquire(frame: FrameKey, kind: SessionOutputKind): ContextHandle | null
  close(meetingStartedAt: number): void
  closeFrame(frameOwner: string): void
  closeAll(): void
}

/** The context carries the most recent finals only; a request asks for a character tail of at most 20,000. */
export const CONTEXT_TRANSCRIPT_WINDOW = 512
/** Pending asks allowed behind the active one. A third is refused; the renderer cancels the one it replaces. */
export const ASK_QUEUE_MAX_PENDING = 2
/** Default job deadline. Callers streaming an answer pass their own. */
export const ASK_QUEUE_TIMEOUT_MS = 60_000

/** A real meeting commits thousands of finals; the ledger's own defaults are the reference kernel's smaller bounds. */
export const CONTEXT_LEDGER_LIMITS = { maxEvents: 60_000, maxUtterances: 8_000 } as const

const LOCAL_EPOCH = 1
const SPEAKER_IDS = { you: 'YOU', them: 'THEM', unknown: 'SPEAKER' } as const

interface MeetingContext {
  readonly startedAt: number
  readonly frameOwner: string
  readonly scope: MeetingScope
  readonly ledger: TranscriptLedger
  readonly session: SessionContext
  /** One queue per meeting: ask and suggest publish through it. Disposed with the meeting. */
  readonly queue: SessionQueue
  /** The screen source this context was last told about, so a repeat observation does not outdate anything. */
  screenSource: string | null
  /** Jobs accepted and not yet finished (the active one plus the pending ones), for queue health. */
  inFlight: number
  readonly streamEpochs: Map<string, number>
  readonly localLines: Map<number, { utteranceId: string; speaker: 'you' | 'them' | 'unknown'; text: string }>
  /** Speaker name and language by utterance id, as the renderer reports them (a name can arrive after the line). */
  readonly labels: Map<string, { name?: string; lang?: string }>
  localSequence: number
  publishCount: number
  degraded: boolean
}

const MAX_LABELS = 20_000

const frameOwnerOf = (frame: FrameKey): string => `${frame.processId}:${frame.routingId}`
const sameScope = (a: MeetingScope, b: MeetingScope): boolean =>
  a.ownerKey === b.ownerKey &&
  a.scope.tenantId === b.scope.tenantId &&
  a.scope.userId === b.scope.userId &&
  a.scope.sessionId === b.scope.sessionId

export function createMeetingContextRegistry(deps: MeetingContextRegistryDeps): MeetingContextRegistry {
  const contexts = new Map<number, MeetingContext>()
  const byFrame = new Map<string, number>()

  const degrade = (context: MeetingContext, error: unknown): void => {
    context.degraded = true
    const code =
      error instanceof TranscriptLedgerError || error instanceof ContractError ? error.code : 'LEDGER_FAILURE'
    try {
      deps.onDegraded?.(code)
    } catch {
      // reporting never changes the context
    }
  }

  const syncPermissions = (context: MeetingContext): void => {
    try {
      context.session.setPermissions(deps.permissions())
    } catch {
      // an unreadable permission set leaves the previous fingerprint in force; the next read retries
    }
  }

  /** Hands the ledger's usable finals to the SessionContext: one revision for every output. */
  const publish = (context: MeetingContext): void => {
    const snapshot = context.ledger.snapshot()
    // The context's own revision, because a label arriving later changes the text without a ledger event.
    context.publishCount += 1
    context.session.updateTranscript({
      scope: context.scope.scope,
      revision: context.publishCount,
      segments: snapshot.segments.slice(-CONTEXT_TRANSCRIPT_WINDOW).map((segment) => {
        const label = context.labels.get(segment.utteranceId)
        return label ? { ...segment, ...label } : segment
      }) as unknown as JsonValue[],
      interim: []
    })
  }

  /** Records a name or language for an utterance. Returns true when it changed what the context would render. */
  const setLabel = (context: MeetingContext, utteranceId: string, label: { name?: string; lang?: string }): boolean => {
    const previous = context.labels.get(utteranceId)
    const next = {
      ...previous,
      ...(label.name?.trim() ? { name: label.name } : {}),
      ...(label.lang ? { lang: label.lang } : {})
    }
    if (previous && previous.name === next.name && previous.lang === next.lang) return false
    if (!next.name && !next.lang) return false
    context.labels.delete(utteranceId)
    context.labels.set(utteranceId, next)
    while (context.labels.size > MAX_LABELS) {
      const oldest = context.labels.keys().next().value
      if (oldest === undefined) break
      context.labels.delete(oldest)
    }
    return true
  }

  const observeHealth = (record: (health: QueueHealthSink) => void): void => {
    if (!deps.queueHealth) return
    try {
      record(deps.queueHealth)
    } catch {
      // health is observation only; it never changes an ask
    }
  }

  /** Whether a snapshot may still publish: re-reads permissions, then asks the issuing SessionContext. */
  const checkFor = (context: MeetingContext, snapshot: ContextSnapshot) => (): ContextCheck => {
    syncPermissions(context)
    try {
      context.session.assertCurrent(snapshot)
      return { state: 'current' }
    } catch (error) {
      const code = error instanceof ContractError ? error.code : 'STALE'
      // Only transcript, screen or knowledge moved: the snapshot is older, not invalid.
      return code === 'STALE_CONTEXT' ? { state: 'advanced' } : { state: 'stale', code }
    }
  }

  const enqueue = <T>(
    context: MeetingContext,
    kind: SessionOutputKind,
    work: (job: AskJob) => PromiseLike<T> | T,
    options?: EnqueueOptions
  ): Promise<T> => {
    const now = deps.now ?? Date.now
    const queuedAt = now()
    context.inFlight += 1
    // A refused submit never joins the queue, so it is not a depth the queue reached.
    if (context.inFlight <= ASK_QUEUE_MAX_PENDING + 1)
      observeHealth((health) => health.observePeak('queue_depth_peak', context.inFlight))
    return context.queue
      .submit(
        kind,
        (snapshot, signal) => {
          const waited = Math.max(0, now() - queuedAt)
          observeHealth((health) => health.recordLatency('queue_wait_ms', waited))
          return work({ signal, check: checkFor(context, snapshot) })
        },
        options
      )
      .then((result) => result.value)
      .finally(() => {
        context.inFlight -= 1
      })
  }

  const close = (meetingStartedAt: number): void => {
    const context = contexts.get(meetingStartedAt)
    if (!context) return
    contexts.delete(meetingStartedAt)
    if (byFrame.get(context.frameOwner) === meetingStartedAt) byFrame.delete(context.frameOwner)
    context.queue.dispose()
    context.session.stop()
  }

  const open = (frame: FrameKey, meetingStartedAt: number): MeetingContext | null => {
    if (!Number.isSafeInteger(meetingStartedAt) || meetingStartedAt <= 0) return null
    let scope: MeetingScope | null
    try {
      scope = deps.resolveScope(frame, meetingStartedAt)
    } catch {
      scope = null
    }
    if (!scope) return null
    const existing = contexts.get(meetingStartedAt)
    if (existing) {
      return existing.frameOwner === frameOwnerOf(frame) && sameScope(existing.scope, scope) ? existing : null
    }
    // One live meeting at a time, as the transcript revision store does: a new meeting ends the previous one.
    for (const other of [...contexts.keys()]) close(other)
    try {
      const session = new SessionContext({ scope: scope.scope, permissions: deps.permissions(), mode: 'meeting' })
      const context: MeetingContext = {
        startedAt: meetingStartedAt,
        frameOwner: frameOwnerOf(frame),
        scope,
        ledger: new TranscriptLedger(scope.scope, CONTEXT_LEDGER_LIMITS),
        session,
        // A live conversation keeps talking while an answer streams; that moves the transcript, not the question.
        queue: new SessionQueue(session, {
          maxPending: ASK_QUEUE_MAX_PENDING,
          timeoutMs: ASK_QUEUE_TIMEOUT_MS,
          tolerate: ['transcript']
        }),
        screenSource: null,
        inFlight: 0,
        streamEpochs: new Map(),
        localLines: new Map(),
        labels: new Map(),
        localSequence: 0,
        publishCount: 0,
        degraded: false
      }
      contexts.set(meetingStartedAt, context)
      byFrame.set(context.frameOwner, meetingStartedAt)
      return context
    } catch {
      return null
    }
  }

  const ensureStream = (context: MeetingContext, streamId: string, epoch: number): void => {
    const known = context.streamEpochs.get(streamId)
    if (known !== undefined && epoch <= known) return
    context.ledger.startStream({ scope: context.scope.scope, streamId, epoch })
    context.streamEpochs.set(streamId, epoch)
  }

  const apply = (context: MeetingContext, event: TranscriptLedgerEvent): boolean => {
    ensureStream(context, event.streamId, event.streamEpoch)
    const verdict = context.ledger.apply(event)
    if (verdict.applied) publish(context)
    return verdict.applied || verdict.reason === 'duplicate-event' || verdict.reason === 'duplicate-revision'
  }

  return {
    ingestDelivered(frame, meetingStartedAt, event) {
      // Partials are never usable context and would spend the ledger's bounded event budget for nothing.
      if (event.type !== 'segment' || !event.segment.final) return
      const context = open(frame, meetingStartedAt)
      if (!context) return
      try {
        apply(context, speechSegmentToLedgerEvent(event as SegmentEvent, context.scope.scope))
      } catch (error) {
        degrade(context, error)
      }
    },

    ingestLocalLine(frame, line) {
      const context = open(frame, line.startedAt)
      if (!context) return false
      const known = context.localLines.get(line.t)
      if (known && known.speaker === line.speaker && known.text === line.text) return true
      try {
        context.localSequence += 1
        const sequence = context.localSequence
        const utteranceId = known ? `local:${line.t}:${sequence}` : `local:${line.t}`
        const startMs = Math.max(0, line.t - line.startedAt)
        setLabel(context, utteranceId, line)
        const accepted = apply(context, {
          eventId: `local:${line.startedAt}:${sequence}`,
          scope: context.scope.scope,
          streamId: `local.${line.speaker}`,
          streamEpoch: LOCAL_EPOCH,
          utteranceId,
          revision: 1,
          state: 'final',
          text: line.text,
          startMs,
          endMs: startMs,
          speakerId: SPEAKER_IDS[line.speaker]
        })
        if (accepted) context.localLines.set(line.t, { utteranceId, speaker: line.speaker, text: line.text })
        return accepted
      } catch (error) {
        degrade(context, error)
        return false
      }
    },

    retractLocalLine(frame, line) {
      const context = open(frame, line.startedAt)
      const known = context?.localLines.get(line.t)
      if (!context || !known) return false
      try {
        context.localSequence += 1
        const startMs = Math.max(0, line.t - line.startedAt)
        const retracted = apply(context, {
          eventId: `local:${line.startedAt}:${context.localSequence}`,
          scope: context.scope.scope,
          streamId: `local.${known.speaker}`,
          streamEpoch: LOCAL_EPOCH,
          utteranceId: known.utteranceId,
          revision: 2,
          state: 'retracted',
          text: '',
          startMs,
          endMs: startMs,
          speakerId: SPEAKER_IDS[known.speaker]
        })
        if (retracted) context.localLines.delete(line.t)
        return retracted
      } catch (error) {
        degrade(context, error)
        return false
      }
    },

    labelLine(frame, line) {
      const context = open(frame, line.startedAt)
      if (!context) return false
      const utteranceId =
        line.utteranceId ?? (line.t === undefined ? undefined : context.localLines.get(line.t)?.utteranceId)
      if (!utteranceId) return false
      try {
        if (setLabel(context, utteranceId, line)) publish(context)
        return true
      } catch (error) {
        degrade(context, error)
        return false
      }
    },

    acquire(frame, kind) {
      const startedAt = byFrame.get(frameOwnerOf(frame))
      const context = startedAt === undefined ? undefined : contexts.get(startedAt)
      if (!context || !context.session.active) return null
      let scope: MeetingScope | null
      try {
        scope = deps.resolveScope(frame, context.startedAt)
      } catch {
        scope = null
      }
      // The signed-in owner changed since the meeting opened: nothing of it may feed this frame's outputs.
      if (!scope || !sameScope(context.scope, scope)) return null
      syncPermissions(context)
      let snapshot: ContextSnapshot
      try {
        snapshot = context.session.snapshot(kind)
      } catch {
        return null
      }
      return {
        meetingStartedAt: context.startedAt,
        snapshot,
        check: checkFor(context, snapshot),
        enqueue: (work, options) => enqueue(context, kind, work, options)
      }
    },

    observeScreen(sourceId, observedAtMs) {
      for (const context of contexts.values()) {
        if (context.screenSource === sourceId) continue
        context.screenSource = sourceId
        try {
          context.session.setScreen(sourceId === null ? null : { scope: context.scope.scope, sourceId, observedAtMs })
        } catch {
          // an unusable observation leaves the context as it was
        }
      }
    },

    close,

    closeFrame(frameOwner) {
      for (const context of [...contexts.values()]) if (context.frameOwner === frameOwner) close(context.startedAt)
    },

    closeAll() {
      for (const startedAt of [...contexts.keys()]) close(startedAt)
    }
  }
}

/**
 * The trusted scope for a frame's meeting. The owner ref is read from the authority (minted on first use, never taken
 * from a renderer); the session id is the meeting, not the per-sign-in id. With no signed-in owner the scope exists
 * only while sign-in is not configured at all (an unconfigured build), under a fixed local identity; a configured but
 * signed-out app has no scope, so nothing is held.
 */
export function createMeetingScopeResolver(deps: {
  ownerSession: {
    current(frame: FrameKey): OwnerSessionRef | null
    mint(frame: FrameKey, contextRevision: number): OwnerSessionRef | null
  }
  contextRevision(): number
  unsignedAllowed(): boolean
}): MeetingContextRegistryDeps['resolveScope'] {
  const sessionIdOf = (startedAt: number): string => `meeting-${startedAt}`
  return (frame, startedAt) => {
    let ref = deps.ownerSession.current(frame)
    if (!ref) {
      try {
        ref = deps.ownerSession.mint(frame, deps.contextRevision())
      } catch {
        ref = null
      }
    }
    if (ref) {
      return { scope: sessionScopeFor(ref, sessionIdOf(startedAt)), ownerKey: ref.ownerKey }
    }
    if (!deps.unsignedAllowed()) return null
    return {
      scope: sessionScopeFor({ tenantKey: 'local', ownerKey: 'local' }, sessionIdOf(startedAt)),
      ownerKey: 'local'
    }
  }
}
