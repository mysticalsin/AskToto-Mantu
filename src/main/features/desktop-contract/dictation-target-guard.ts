import { check, data, digest, exactKeys, ident, textDigest, time } from './contract-data'

/**
 * Foreground-safe dictation handoff. No keyboard events, no clipboard, no native code here.
 * A trusted OS adapter supplies target state; the action guard executes the exact prepared args.
 * Native insertion MUST atomically compare the expected target before writing.
 *
 * Ported from the 2.12 reference `dictation-target-guard.mjs`. One deliberate change: the reference
 * dropped the previous draft inside `begin()`. This port preserves every unfinished or uninserted
 * draft (see `priorDrafts`) before a new activation replaces it.
 */

const TARGET_KEYS = [
  'appId',
  'processInstanceId',
  'windowId',
  'elementId',
  'focusRevision',
  'selectionRevision',
  'documentRevision',
  'editable',
  'secure',
  'observedAtMs'
] as const

const MAX_TEXT_BYTES = 32_768
/** Most preserved drafts kept per guard. The oldest is evicted first, after `onDraftPreserved` ran. */
export const MAX_PRIOR_DRAFTS = 16

/** Owner of a dictation. Structurally the kernel session scope. */
export interface DictationActor {
  tenantId: string
  userId: string
  sessionId: string
}

/** What the guard needs from the session context (the kernel SessionContext satisfies this). */
export interface DictationContext {
  assertActor(actor: DictationActor): void
  snapshot(outputKind: 'manual'): object
  assertCurrent(snapshot: object): void
  hasPermissions(required: string[]): boolean
  onChange(listener: (reason: string) => void): () => void
}

export interface DictationTarget {
  appId: string
  processInstanceId: string
  windowId: string
  elementId: string
  focusRevision: number
  selectionRevision: number
  documentRevision: string
  editable: boolean
  secure: boolean
  observedAtMs: number
}

export type DictationActivation = 'dictation-ui' | 'dictation-shortcut'
export type DictationMode = 'hold' | 'handsfree'
export type DictationState =
  | 'listening'
  | 'draft'
  | 'prepared'
  | 'dispatched'
  | 'verified'
  | 'no_effect'
  | 'uncertain'
  | 'review'

export interface DictationLease {
  readonly id: string
  readonly mode: DictationMode
  readonly signal: AbortSignal
}

export interface DictationInsertArgs {
  operationId: string
  text: string
  textHash: string
  target: DictationTarget
  targetFingerprint: string
  transcriptRevision: number
}

export interface DictationInsertRequest {
  kind: 'dictation.insert'
  args: DictationInsertArgs
  argsHash: string
}

export interface DictationReceipt {
  operationId: string
  argsHash: string
  targetFingerprint: string
  textHash: string
}

export type DictationOutcome = 'verified' | 'no_effect' | 'uncertain'

export interface DictationResult {
  outcome: string
  evidenceId: string
  reconciled?: boolean
}

export interface DictationInspection {
  operationId: string
  state: DictationState
  text: string
  transcriptRevision: number
  targetFingerprint: string
  result: DictationResult | null
}

export type PriorDraftReason = 'superseded' | 'dispose'

/** A draft kept after its dictation ended without a verified insertion. */
export interface PriorDraft {
  operationId: string
  text: string
  textHash: string
  transcriptRevision: number
  targetFingerprint: string
  state: DictationState
  reason: PriorDraftReason
  preservedAtMs: number
}

export interface DictationTargetGuardOptions {
  now?: () => number
  targetFreshnessMs?: number
  /** Called synchronously for each preserved draft so the host can persist it. Errors are contained. */
  onDraftPreserved?: (draft: PriorDraft) => void
}

interface DictationRecord {
  id: string
  snapshot: object
  target: DictationTarget
  targetFingerprint: string
  state: DictationState
  transcriptRevision: number
  text: string
  textHash: string
  revoked: boolean
  controller: AbortController
  request: DictationInsertRequest | null
  result: DictationResult | null
}

interface IssuedRequest {
  record: DictationRecord
  consumed: boolean
}

export class DictationTargetGuard {
  private readonly context: DictationContext
  private readonly now: () => number
  private readonly freshnessMs: number
  private readonly onDraftPreserved: ((draft: PriorDraft) => void) | null
  private readonly leases = new WeakMap<object, DictationRecord>()
  private readonly requests = new WeakMap<object, IssuedRequest>()
  private readonly preserved: PriorDraft[] = []
  private sequence = 0
  private current: DictationRecord | null = null
  private readonly off: () => void
  private disposed = false

  constructor(context: DictationContext, options: DictationTargetGuardOptions = {}) {
    const { now = Date.now, targetFreshnessMs = 2_000, onDraftPreserved } = options
    check(
      context &&
        (['assertActor', 'snapshot', 'assertCurrent', 'hasPermissions', 'onChange'] as const).every(
          (key) => typeof context[key] === 'function'
        ),
      'CONTEXT'
    )
    check(typeof now === 'function', 'CLOCK')
    check(onDraftPreserved === undefined || typeof onDraftPreserved === 'function', 'DRAFT_SINK')
    time(now)
    check(
      Number.isSafeInteger(targetFreshnessMs) && targetFreshnessMs > 0 && targetFreshnessMs <= 10_000,
      'TARGET_FRESHNESS'
    )
    this.context = context
    this.now = now
    this.freshnessMs = targetFreshnessMs
    this.onDraftPreserved = onDraftPreserved ?? null
    this.off = context.onChange(() => this.interrupt('context-changed'))
  }

  private validTarget(value: unknown): DictationTarget {
    const target = data(value) as DictationTarget
    exactKeys(target, TARGET_KEYS, 'TARGET_SCHEMA')
    for (const field of ['appId', 'processInstanceId', 'windowId', 'elementId', 'documentRevision'] as const) {
      ident(target[field], 'TARGET_ID')
    }
    for (const field of ['focusRevision', 'selectionRevision'] as const) {
      check(Number.isSafeInteger(target[field]) && target[field] >= 0, 'TARGET_REVISION')
    }
    check(target.editable === true && target.secure === false, 'TARGET_NOT_ALLOWED')
    const now = time(this.now)
    check(
      Number.isSafeInteger(target.observedAtMs) &&
        target.observedAtMs <= now &&
        now - target.observedAtMs <= this.freshnessMs,
      'TARGET_STALE'
    )
    return target
  }

  private fingerprint(target: DictationTarget): string {
    const { observedAtMs: _observedAtMs, ...identity } = target
    return digest(identity)
  }

  private available(): void {
    check(!this.disposed, 'DICTATION_DISPOSED')
  }

  private currentRecord(lease: unknown): DictationRecord {
    this.available()
    const record = lease && typeof lease === 'object' ? this.leases.get(lease) : undefined
    check(record && record === this.current, 'DICTATION_NOT_CURRENT')
    return record
  }

  private authority(record: DictationRecord, actor: DictationActor): void {
    this.context.assertActor(actor)
    this.context.assertCurrent(record.snapshot)
    check(this.context.hasPermissions(['dictation.insert']), 'PERMISSION_DENIED')
    check(!record.revoked, 'DICTATION_REVOKED')
  }

  /**
   * Keeps the text of a dictation that ended without a verified insertion. Preservation never
   * depends on the sink: a throwing sink is contained and the in-memory copy stays.
   */
  private preserve(record: DictationRecord, reason: PriorDraftReason): void {
    if (record.state === 'verified' || record.text.trim().length === 0) return
    const draft = data<PriorDraft>({
      operationId: record.id,
      text: record.text,
      textHash: record.textHash,
      transcriptRevision: record.transcriptRevision,
      targetFingerprint: record.targetFingerprint,
      state: record.state,
      reason,
      preservedAtMs: time(this.now)
    })
    if (this.preserved.some((entry) => entry.operationId === draft.operationId)) return
    this.preserved.push(draft)
    if (this.preserved.length > MAX_PRIOR_DRAFTS) this.preserved.shift()
    if (this.onDraftPreserved) {
      try {
        this.onDraftPreserved(draft)
      } catch {
        // The host sink cannot stop a new dictation or lose the in-memory copy.
      }
    }
  }

  /** Activation must originate in the trusted dedicated dictation UI or shortcut. */
  begin(input: { actor: DictationActor; target: unknown; activation: string; mode: string }): DictationLease {
    this.available()
    this.context.assertActor(input.actor)
    check(input.activation === 'dictation-ui' || input.activation === 'dictation-shortcut', 'DICTATION_ACTIVATION')
    check(input.mode === 'hold' || input.mode === 'handsfree', 'DICTATION_MODE')
    check(this.context.hasPermissions(['dictation.insert']), 'PERMISSION_DENIED')
    const freshTarget = this.validTarget(input.target)
    if (this.current) {
      check(!['dispatched', 'uncertain'].includes(this.current.state), 'INSERTION_RECONCILIATION_REQUIRED')
      this.interrupt('superseded')
      this.preserve(this.current, 'superseded')
    }
    const record: DictationRecord = {
      id: `dictation:${++this.sequence}`,
      snapshot: this.context.snapshot('manual'),
      target: freshTarget,
      targetFingerprint: this.fingerprint(freshTarget),
      state: 'listening',
      transcriptRevision: -1,
      text: '',
      textHash: textDigest(''),
      revoked: false,
      controller: new AbortController(),
      request: null,
      result: null
    }
    const lease: DictationLease = Object.freeze({ id: record.id, mode: input.mode, signal: record.controller.signal })
    this.leases.set(lease, record)
    this.current = record
    return lease
  }

  /** ASR output changes a draft only. It cannot call an application or insert text. */
  revise(lease: DictationLease, input: { actor: DictationActor; revision: number; text: string }): boolean {
    const record = this.currentRecord(lease)
    this.authority(record, input.actor)
    check(record.state === 'listening' || record.state === 'draft', 'DICTATION_STATE')
    check(Number.isSafeInteger(input.revision) && input.revision >= 0, 'TRANSCRIPT_REVISION')
    check(typeof input.text === 'string' && Buffer.byteLength(input.text, 'utf8') <= MAX_TEXT_BYTES, 'DICTATION_TEXT')
    if (input.revision === record.transcriptRevision) {
      check(input.text === record.text, 'TRANSCRIPT_REVISION_COLLISION')
      return false
    }
    check(input.revision > record.transcriptRevision, 'TRANSCRIPT_REGRESSION')
    record.text = input.text
    record.textHash = textDigest(input.text)
    record.transcriptRevision = input.revision
    record.state = 'draft'
    return true
  }

  private matchTarget(record: DictationRecord, target: unknown): DictationTarget {
    let observed: DictationTarget
    try {
      observed = this.validTarget(target)
    } catch (error) {
      this.interrupt('target-unavailable')
      throw error
    }
    if (this.fingerprint(observed) !== record.targetFingerprint) {
      this.interrupt('target-changed')
      check(false, 'DICTATION_TARGET_CHANGED')
    }
    return observed
  }

  /** Returns immutable action-guard arguments. Presenting these does not dispatch. */
  prepare(lease: DictationLease, input: { actor: DictationActor; currentTarget: unknown }): DictationInsertRequest {
    const record = this.currentRecord(lease)
    this.authority(record, input.actor)
    check(record.state === 'draft' && record.text.trim().length > 0, 'DICTATION_STATE')
    this.matchTarget(record, input.currentTarget)
    const args = data<DictationInsertArgs>({
      operationId: record.id,
      text: record.text,
      textHash: record.textHash,
      target: record.target,
      targetFingerprint: record.targetFingerprint,
      transcriptRevision: record.transcriptRevision
    })
    const request = data<DictationInsertRequest>({ kind: 'dictation.insert', args, argsHash: digest(args) })
    this.requests.set(request, { record, consumed: false })
    record.request = request
    record.state = 'prepared'
    return request
  }

  /** Synchronous one-use native-dispatch handoff after the action-guard approval. */
  takeForDispatch(
    request: DictationInsertRequest,
    input: { actor: DictationActor; currentTarget: unknown }
  ): DictationInsertArgs {
    this.available()
    const issued = request && typeof request === 'object' ? this.requests.get(request) : undefined
    check(issued && issued.record === this.current, 'INSERTION_NOT_ISSUED')
    const record = issued.record
    this.authority(record, input.actor)
    check(!issued.consumed && record.state === 'prepared', 'INSERTION_CONSUMED')
    this.matchTarget(record, input.currentTarget)
    issued.consumed = true
    record.state = 'dispatched'
    return request.args
  }

  /** Native result or action-guard readback only. Caller acknowledgments are not observation. */
  settle(
    request: DictationInsertRequest,
    input: {
      actor: DictationActor
      outcome: string
      receipt?: Partial<DictationReceipt> | null
      evidenceId: string
    }
  ): DictationInspection {
    this.available()
    this.context.assertActor(input.actor)
    const issued = request && typeof request === 'object' ? this.requests.get(request) : undefined
    check(issued && issued.record === this.current && issued.consumed, 'INSERTION_NOT_ISSUED')
    const record = issued.record
    check(record.state === 'dispatched' && !record.revoked, 'INSERTION_RECONCILIATION_REQUIRED')
    this.context.assertCurrent(record.snapshot)
    check(['verified', 'no_effect', 'uncertain'].includes(input.outcome), 'INSERTION_OUTCOME')
    ident(input.evidenceId, 'EVIDENCE_ID')
    const receipt = input.receipt ?? null
    if (input.outcome === 'verified') {
      const matches =
        receipt !== null &&
        receipt.operationId === request.args.operationId &&
        receipt.argsHash === request.argsHash &&
        receipt.targetFingerprint === record.targetFingerprint &&
        receipt.textHash === record.textHash
      if (!matches) {
        record.state = 'uncertain'
        record.revoked = true
        record.result = data({ outcome: 'uncertain', evidenceId: 'guard:receipt-mismatch' })
        return this.requireInspection()
      }
    }
    record.state = input.outcome as DictationOutcome
    record.result = data({ outcome: input.outcome, evidenceId: input.evidenceId })
    return this.requireInspection()
  }

  private interrupt(reason: string): void {
    const record = this.current
    if (!record || record.state === 'verified' || record.state === 'no_effect') return
    record.revoked = true
    record.controller.abort(reason)
    record.state = record.state === 'dispatched' || record.state === 'uncertain' ? 'uncertain' : 'review'
    record.result = data({ outcome: record.state, evidenceId: `control:${reason}` })
  }

  cancel(): DictationInspection | null {
    this.available()
    this.interrupt('cancel')
    return this.inspect()
  }

  /** Reconciliation never retries. A new dictation requires an explicit fresh activation. */
  reconcile(input: {
    actor: DictationActor
    operationId: string
    outcome: string
    evidenceId: string
  }): DictationInspection {
    this.available()
    this.context.assertActor(input.actor)
    const record = this.current
    check(record && record.id === input.operationId && record.state === 'uncertain', 'UNRESOLVED_INSERTION')
    check(input.outcome === 'verified' || input.outcome === 'no_effect', 'RECONCILIATION_OUTCOME')
    ident(input.evidenceId, 'EVIDENCE_ID')
    record.state = input.outcome
    record.result = data({ outcome: input.outcome, evidenceId: input.evidenceId, reconciled: true })
    return this.requireInspection()
  }

  inspect(): DictationInspection | null {
    const item = this.current
    if (!item) return null
    return data<DictationInspection>({
      operationId: item.id,
      state: item.state,
      text: item.text,
      transcriptRevision: item.transcriptRevision,
      targetFingerprint: item.targetFingerprint,
      result: item.result
    })
  }

  private requireInspection(): DictationInspection {
    const inspection = this.inspect()
    check(inspection, 'DICTATION_NOT_CURRENT')
    return inspection
  }

  /**
   * Drafts kept from earlier dictations, oldest first. Works after `dispose` so a user can still
   * recover text. Needs only the owning actor; it grants no insertion authority.
   */
  priorDrafts(input: { actor: DictationActor }): readonly PriorDraft[] {
    this.context.assertActor(input.actor)
    return data<PriorDraft[]>([...this.preserved])
  }

  /** Explicit user discard of one preserved draft. Returns false when it is not held. */
  discardPriorDraft(input: { actor: DictationActor; operationId: string }): boolean {
    this.context.assertActor(input.actor)
    const index = this.preserved.findIndex((entry) => entry.operationId === input.operationId)
    if (index < 0) return false
    this.preserved.splice(index, 1)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.interrupt('dispose')
    if (this.current) this.preserve(this.current, 'dispose')
    this.off()
    this.disposed = true
  }
}
