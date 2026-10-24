import {
  InterventionError,
  type InterventionContext,
  type InterventionDecision,
  type InterventionExistingRules,
  type InterventionScope,
  type InterventionSnapshot
} from '@shared/intervention-contract'
import type { InterventionOutcome, InterventionPath, InterventionShadowRecord } from '@shared/intervention-shadow'
import { InterventionPolicy } from '@shared/kernel/intervention-policy'

export type { InterventionShadowRecord } from '@shared/intervention-shadow'

/**
 * Renderer-side InterventionPolicy gate (G70). Every unsolicited copilot card (the question auto-answer and an
 * adopted shadow card) is decided here, bound to a snapshot of the live session so stale work can be dropped.
 *
 * The classifier is off (D-15): the policy is built disabled, so a decision equals today's rules exactly.
 * Segments stay empty until G74 supplies a classifier, because a disabled policy never builds classifier input.
 */

export type InterventionScopeChange = 'stop' | 'resume' | 'meeting-switch' | 'sign-out' | 'permission-revoked'

export type InterventionEvent =
  | { kind: 'final' | 'correction' | 'retraction'; lineId: string }
  | { kind: 'scope'; change: InterventionScopeChange }

const INVALID_LINES_CAP = 256
const RECORD_RING_CAP = 64
const REASON_MAX = 64

const meetingSessionId = (meetingStartMs: number): string => `meeting-${Math.max(0, Math.trunc(meetingStartMs))}`

/** Context for one renderer session: a scope epoch (`generation`) and a transcript revision (`contextRevision`). */
export class LiveInterventionContext implements InterventionContext<InterventionSnapshot> {
  generation = 1
  contextRevision = 1
  private scope: InterventionScope
  private readonly issued = new WeakSet<object>()
  private readonly triggers = new WeakMap<object, string>()
  private readonly invalidLines = new Set<string>()
  private readonly listeners = new Set<(reason: string) => void>()

  constructor(meetingStartMs: number) {
    this.scope = { tenantId: 'local', userId: 'local', sessionId: meetingSessionId(meetingStartMs) }
  }

  issue(triggerLineId?: string): InterventionSnapshot {
    const snapshot: InterventionSnapshot = Object.freeze({
      scope: this.scope,
      generation: this.generation,
      contextRevision: this.contextRevision,
      objective: '',
      transcript: Object.freeze({ scope: this.scope, segments: Object.freeze([]) })
    })
    this.issued.add(snapshot)
    if (triggerLineId !== undefined) this.triggers.set(snapshot, triggerLineId)
    return snapshot
  }

  observe(event: InterventionEvent): void {
    if (event.kind === 'scope') {
      this.generation += 1
      this.contextRevision += 1
      this.invalidLines.clear()
      this.notify(`scope:${event.change}`)
      return
    }
    this.contextRevision += 1
    if (event.kind !== 'final') {
      if (this.invalidLines.size >= INVALID_LINES_CAP) {
        const oldest = this.invalidLines.values().next().value
        if (oldest !== undefined) this.invalidLines.delete(oldest)
      }
      this.invalidLines.add(event.lineId)
    }
    this.notify(event.kind)
  }

  /** A new meeting: the next snapshots carry its session id. Call before observing the scope change. */
  setMeeting(meetingStartMs: number): void {
    this.scope = { ...this.scope, sessionId: meetingSessionId(meetingStartMs) }
  }

  assertCurrent(snapshot: InterventionSnapshot): void {
    if (!snapshot || !this.issued.has(snapshot)) throw new InterventionError('SCOPE_MISMATCH')
    if (snapshot.generation !== this.generation) throw new InterventionError('SCOPE_MISMATCH')
    if (snapshot.contextRevision !== this.contextRevision) throw new InterventionError('INTERVENTION_TRANSCRIPT')
  }

  isCurrent(snapshot: InterventionSnapshot): boolean {
    try {
      this.assertCurrent(snapshot)
      return true
    } catch {
      return false
    }
  }

  /** The scope changed, or the line that triggered this snapshot was corrected or retracted. */
  isHardInvalidated(snapshot: InterventionSnapshot): boolean {
    if (!snapshot || !this.issued.has(snapshot) || snapshot.generation !== this.generation) return true
    const trigger = this.triggers.get(snapshot)
    return trigger !== undefined && this.invalidLines.has(trigger)
  }

  onChange(listener: (reason: string) => void): () => boolean {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(reason: string): void {
    for (const listener of [...this.listeners]) listener(reason)
  }
}

// A classifier is not configured (D-15). The policy is disabled, so this is never reached; if a future change
// enables the policy without a real classifier it fails closed into the existing rules.
const noClassifier = (): never => {
  throw new InterventionError('INTERVENTION_CLASSIFIER')
}

export interface InterventionGateOptions {
  meetingStartMs: number
  /** Receives every record (the preload's content-free shadow report). A throwing sink never breaks a decision. */
  report?: (record: InterventionShadowRecord) => void
}

export interface InterventionDecisionRecordInput {
  path: InterventionPath
  decision: InterventionDecision
  outcome: InterventionOutcome
}

const toReasonCode = (reason: string): string =>
  reason.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, REASON_MAX) || 'unknown'

export class InterventionGate {
  private readonly context: LiveInterventionContext
  private readonly policy: InterventionPolicy
  private readonly report: ((record: InterventionShadowRecord) => void) | undefined
  private readonly ring: InterventionShadowRecord[] = []

  constructor(options: InterventionGateOptions) {
    this.context = new LiveInterventionContext(options.meetingStartMs)
    this.policy = new InterventionPolicy(this.context, { classify: noClassifier, enabled: false })
    this.report = options.report
  }

  get generation(): number {
    return this.context.generation
  }

  get contextRevision(): number {
    return this.context.contextRevision
  }

  observe(event: InterventionEvent): void {
    this.context.observe(event)
  }

  startMeeting(meetingStartMs: number): void {
    this.context.setMeeting(meetingStartMs)
    this.context.observe({ kind: 'scope', change: 'meeting-switch' })
  }

  issue(triggerLineId?: string): InterventionSnapshot {
    return this.context.issue(triggerLineId)
  }

  /**
   * One policy decision for `path`, bound to a fresh snapshot. With the classifier off the decision is the
   * existing rules untouched. A policy error degrades to the same existing rules, never to a guess.
   */
  async decide(
    _path: InterventionPath,
    existingRules: InterventionExistingRules,
    triggerLineId?: string
  ): Promise<{ decision: InterventionDecision; snapshot: InterventionSnapshot }> {
    const snapshot = this.context.issue(triggerLineId)
    try {
      const decision = await this.policy.evaluate({ snapshot, existingRules })
      return { decision, snapshot }
    } catch {
      const decision: InterventionDecision = Object.freeze({
        stage: 'intervention-classification' as const,
        status: 'existing-rules' as const,
        shouldGenerate: existingRules.shouldGenerate,
        reason: toReasonCode(existingRules.reason),
        scope: { ...snapshot.scope },
        generation: snapshot.generation,
        contextRevision: snapshot.contextRevision
      })
      return { decision, snapshot }
    }
  }

  isCurrent(snapshot: InterventionSnapshot): boolean {
    return this.context.isCurrent(snapshot)
  }

  isHardInvalidated(snapshot: InterventionSnapshot): boolean {
    return this.context.isHardInvalidated(snapshot)
  }

  record(input: InterventionDecisionRecordInput): void {
    const { path, decision, outcome } = input
    this.push({
      path,
      status: decision.status,
      shouldGenerate: decision.shouldGenerate,
      reason: toReasonCode(decision.reason),
      outcome,
      generation: decision.generation,
      contextRevision: decision.contextRevision
    })
  }

  /** A stale-drop of work bound to `snapshot` (no fresh decision exists for it). */
  recordStaleDrop(path: InterventionPath, snapshot: InterventionSnapshot, reason = 'stale'): void {
    this.push({
      path,
      status: 'stale',
      shouldGenerate: false,
      reason: toReasonCode(reason),
      outcome: 'stale-drop',
      generation: snapshot.generation,
      contextRevision: snapshot.contextRevision
    })
  }

  records(): readonly InterventionShadowRecord[] {
    return [...this.ring]
  }

  private push(entry: InterventionShadowRecord): void {
    const record: InterventionShadowRecord = Object.freeze(entry)
    this.ring.push(record)
    if (this.ring.length > RECORD_RING_CAP) this.ring.shift()
    try {
      this.report?.(record)
    } catch {
      // The sink is best-effort telemetry; a failure must never change what the user sees.
    }
  }
}

export interface TranscriptLineLike {
  t: number
  text: string
  provisional?: boolean
}

const lineId = (t: number): string => `t${t}`

/** Renderer-local transcript diff: a new `t` is a final, changed text on the same `t` a correction, a missing `t` a retraction. */
export function diffTranscriptLines(
  prev: readonly TranscriptLineLike[],
  next: readonly TranscriptLineLike[]
): InterventionEvent[] {
  const before = new Map<number, string>()
  for (const line of prev) if (!line.provisional) before.set(line.t, line.text)
  const events: InterventionEvent[] = []
  const seen = new Set<number>()
  for (const line of next) {
    if (line.provisional) continue
    seen.add(line.t)
    const old = before.get(line.t)
    if (old === undefined) events.push({ kind: 'final', lineId: lineId(line.t) })
    else if (old !== line.text) events.push({ kind: 'correction', lineId: lineId(line.t) })
  }
  for (const t of before.keys()) if (!seen.has(t)) events.push({ kind: 'retraction', lineId: lineId(t) })
  return events
}

export const transcriptLineId = lineId
