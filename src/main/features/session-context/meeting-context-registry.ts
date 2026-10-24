import type { OwnerSessionRef } from '@shared/contracts/owner-session'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import { ContractError, type JsonValue } from '@shared/kernel/contract-data'
import { SessionContext, type ContextSnapshot, type SessionOutputKind } from '@shared/kernel/session-context'
import { SessionQueue } from '@shared/kernel/session-queue'
import { sessionScopeFor, type SessionScope } from '@shared/kernel/session-scope'
import { TranscriptLedger, TranscriptLedgerError, type TranscriptLedgerEvent } from '@shared/kernel/transcript-ledger'
import { canUpgradeSpeakerLabel } from '@shared/speaker-names'
import { speechSegmentToLedgerEvent } from '@shared/transcript-line-identity'
import { CorrectionTracker, type LineDeps } from './correction-scope'

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
  /**
   * G15: a correction, retraction or relabel outdated outputs this meeting already published (their ids, recorded with
   * `ContextHandle.recordOutput`). Fires once per output, content-free. The owner forgets nothing else: the next
   * request reads the corrected ledger on its own.
   */
  onOutputsStale?(frame: FrameKey, outputIds: readonly string[]): void
  /**
   * G73: an applied final (any revision) or retraction, after the ledger accepted it. Never fires for partials,
   * duplicates or stale revisions. The text is meeting content: a listener must not log it. A throwing listener is contained.
   */
  onUtterance?(
    frame: FrameKey,
    meetingStartedAt: number,
    utterance: {
      scope: SessionScope
      utteranceId: string
      revision: number
      state: 'final' | 'retracted'
      text: string
      lang?: string
    }
  ): void
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
  /** Aborted when the job is outdated (stop, permissions, screen, knowledge, a corrected line), times out, or the meeting ends. */
  readonly signal: AbortSignal
  /**
   * Whether this job's snapshot may still publish. Same contract as `ContextHandle.check`: a correction, retraction or
   * relabel of a line the snapshot contained makes it stale (`LINE_CORRECTED`), and aborts `signal`.
   */
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
  /**
   * Re-reads permissions, then asks the issuing SessionContext whether this snapshot is still the one in force. A line
   * of the snapshot that was corrected, retracted or relabelled since makes it stale with `LINE_CORRECTED` (G15): the
   * text it was built from is no longer the transcript.
   */
  check(): ContextCheck
  /**
   * Records a finished output (a delivered answer or suggestion) against the lines this snapshot contained. When one
   * of them is corrected later, `onOutputsStale` names the output once. Bounded; forgotten when the meeting ends.
   */
  recordOutput(outputId: string): void
  /**
   * Forgets an output recorded with `recordOutput`: a fast answer a deep stage superseded (G29). A later correction then
   * names the deep output only, never both stages of one turn.
   */
  retireOutput(outputId: string): void
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

/** Delivered outputs remembered per meeting for correction reporting; the oldest is forgotten first. */
export const MAX_RECORDED_OUTPUTS = 64

/** A real meeting commits thousands of finals; the ledger's own defaults are the reference kernel's smaller bounds. */
export const CONTEXT_LEDGER_LIMITS = { maxEvents: 60_000, maxUtterances: 8_000 } as const

const LOCAL_EPOCH = 1
const SPEAKER_IDS = { you: 'YOU', them: 'THEM', unknown: 'SPEAKER' } as const

/** One accepted job, held while it runs or waits so a correction can outdate it. */
interface LiveJob {
  readonly deps: LineDeps
  invalidate(): void
}

interface MeetingContext {
  readonly startedAt: number
  readonly frame: FrameKey
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
  /** G15: which lines were corrected, retracted or relabelled, and when (a counter), so outputs can be outdated. */
  readonly corrections: CorrectionTracker
  /** Jobs accepted and not yet settled; a correction aborts the ones whose snapshot contained the line. */
  readonly liveJobs: Set<LiveJob>
  /** Delivered outputs and the lines they read, oldest first. */
  readonly outputs: Map<string, LineDeps>
  readonly streamEpochs: Map<string, number>
  readonly localLines: Map<number, { utteranceId: string; speaker: 'you' | 'them' | 'unknown'; text: string }>
  /** Speaker name and language by utterance id, as the renderer reports them (a name can arrive after the line). */
  readonly labels: Map<string, { name?: string; lang?: string }>
  localSequence: number
  publishCount: number
  degraded: boolean
}

const MAX_LABELS = 20_000

/** The check code for a snapshot whose lines were corrected, retracted or relabelled after it was taken. */
export const LINE_CORRECTED = 'LINE_CORRECTED'

/** The utterance ids a snapshot's transcript contains (finals only; interim text never reaches a snapshot). */
const utteranceIdsOf = (snapshot: ContextSnapshot): string[] =>
  (snapshot.transcript.segments as ReadonlyArray<{ utteranceId?: unknown }>)
    .map((segment) => segment.utteranceId)
    .filter((id): id is string => typeof id === 'string')

type Label = { name?: string; lang?: string }
const labelReplaced = (previous: Label, next: Label): boolean =>
  (!!previous.name && !!next.name && previous.name !== next.name && !canUpgradeSpeakerLabel(previous.name)) ||
  (!!previous.lang && !!next.lang && previous.lang !== next.lang)

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
    // A name or language arriving for a line that had none (or a placeholder such as `Unknown speaker 2`) enriches it;
    // one label replacing another confirmed label changes what outputs that read the line said, so it is a correction.
    if (previous && labelReplaced(previous, next)) corrected(context, utteranceId)
    return true
  }

  /** One line of this meeting was corrected, retracted or relabelled: outdate every output that read it. */
  const corrected = (context: MeetingContext, utteranceId: string): void => {
    context.corrections.record(utteranceId)
    for (const job of [...context.liveJobs]) if (context.corrections.affects(job.deps)) job.invalidate()
    const stale: string[] = []
    for (const [outputId, lines] of context.outputs) {
      if (!context.corrections.affects(lines)) continue
      stale.push(outputId)
      context.outputs.delete(outputId)
    }
    if (stale.length === 0) return
    try {
      deps.onOutputsStale?.(context.frame, stale)
    } catch {
      // telling the renderer is best effort; the context already moved on
    }
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

  /** `checkFor`, plus G15: stale once a line the snapshot contained was corrected since. */
  const checkWith = (context: MeetingContext, snapshot: ContextSnapshot, lines: LineDeps) => (): ContextCheck => {
    const base = checkFor(context, snapshot)()
    if (base.state === 'stale') return base
    return context.corrections.affects(lines) ? { state: 'stale', code: LINE_CORRECTED } : base
  }

  const enqueue = <T>(
    context: MeetingContext,
    kind: SessionOutputKind,
    work: (job: AskJob) => PromiseLike<T> | T,
    lines: LineDeps,
    options?: EnqueueOptions
  ): Promise<T> => {
    const now = deps.now ?? Date.now
    const queuedAt = now()
    // The job reads the transcript its handle was built from, so a correction since then already outdates it.
    const outdated = new AbortController()
    const rejection = new Promise<never>((_resolve, reject) => {
      outdated.signal.addEventListener('abort', () => reject(outdated.signal.reason), { once: true })
    })
    rejection.catch(() => undefined)
    const live: LiveJob = { deps: lines, invalidate: () => outdated.abort(new ContractError('TASK_INVALIDATED')) }
    context.liveJobs.add(live)
    if (context.corrections.affects(lines)) live.invalidate()
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
          // Outdated while it waited for its turn: it never starts.
          if (outdated.signal.aborted) throw outdated.signal.reason
          const check = checkWith(context, snapshot, lines)
          return Promise.race([
            Promise.resolve(work({ signal: AbortSignal.any([signal, outdated.signal]), check })),
            rejection
          ])
        },
        options
      )
      .then((result) => result.value)
      .finally(() => {
        context.inFlight -= 1
        context.liveJobs.delete(live)
      })
  }

  const recordOutput = (context: MeetingContext, outputId: string, lines: LineDeps): void => {
    if (!context.session.active) return
    context.outputs.delete(outputId)
    context.outputs.set(outputId, lines)
    while (context.outputs.size > MAX_RECORDED_OUTPUTS) {
      const oldest = context.outputs.keys().next().value
      if (oldest === undefined) break
      context.outputs.delete(oldest)
    }
  }

  const close = (meetingStartedAt: number): void => {
    const context = contexts.get(meetingStartedAt)
    if (!context) return
    contexts.delete(meetingStartedAt)
    if (byFrame.get(context.frameOwner) === meetingStartedAt) byFrame.delete(context.frameOwner)
    context.queue.dispose()
    context.session.stop()
    context.liveJobs.clear()
    context.outputs.clear()
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
      // The ledger reports corrections before this context exists; the holder is read only when one fires.
      const holder: { context?: MeetingContext } = {}
      const context: MeetingContext = {
        startedAt: meetingStartedAt,
        frame: { processId: frame.processId, routingId: frame.routingId },
        frameOwner: frameOwnerOf(frame),
        scope,
        ledger: new TranscriptLedger(scope.scope, {
          ...CONTEXT_LEDGER_LIMITS,
          onCorrection: (correction) => {
            if (holder.context) corrected(holder.context, correction.utteranceId)
          }
        }),
        session,
        // A live conversation keeps talking while an answer streams; that moves the transcript, not the question.
        queue: new SessionQueue(session, {
          maxPending: ASK_QUEUE_MAX_PENDING,
          timeoutMs: ASK_QUEUE_TIMEOUT_MS,
          tolerate: ['transcript']
        }),
        screenSource: null,
        inFlight: 0,
        corrections: new CorrectionTracker(),
        liveJobs: new Set(),
        outputs: new Map(),
        streamEpochs: new Map(),
        localLines: new Map(),
        labels: new Map(),
        localSequence: 0,
        publishCount: 0,
        degraded: false
      }
      holder.context = context
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
    if (verdict.applied) {
      publish(context)
      if (event.state === 'final' || event.state === 'retracted') {
        try {
          deps.onUtterance?.(context.frame, context.startedAt, {
            scope: context.scope.scope,
            utteranceId: event.utteranceId,
            revision: event.revision,
            state: event.state,
            text: event.text,
            ...(context.labels.get(event.utteranceId)?.lang
              ? { lang: context.labels.get(event.utteranceId)?.lang }
              : {})
          })
        } catch {
          // a translation listener never changes the canonical transcript
        }
      }
    }
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
      // What this snapshot's prompt is built from: a later correction to any of these lines outdates its output.
      const lines = context.corrections.capture(utteranceIdsOf(snapshot))
      return {
        meetingStartedAt: context.startedAt,
        snapshot,
        check: checkWith(context, snapshot, lines),
        enqueue: (work, options) => enqueue(context, kind, work, lines, options),
        recordOutput: (outputId) => recordOutput(context, outputId, lines),
        retireOutput: (outputId) => void context.outputs.delete(outputId)
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
