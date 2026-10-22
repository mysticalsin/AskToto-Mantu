import { z } from 'zod'
import {
  ContractError,
  type ContractErrorCode,
  type JsonValue,
  canonical,
  copyData,
  freezeData,
  requireCondition
} from './contract-data'
import { type SessionScope, assertSameScope, validateScope } from './session-scope'

export type { SessionScope } from './session-scope'

export const SESSION_OUTPUT_KINDS = ['conversation', 'screen', 'manual', 'followup'] as const
export type SessionOutputKind = (typeof SESSION_OUTPUT_KINDS)[number]

export type SessionChangeReason = 'transcript' | 'screen' | 'knowledge' | 'permissions' | 'stop' | 'resume'

/** The canonical transcript envelope. Segment and interim shapes belong to the transcript ledger. */
export interface TranscriptSnapshot {
  readonly scope: SessionScope
  readonly revision: number
  readonly segments: readonly JsonValue[]
  readonly interim: readonly JsonValue[]
}

export interface ScreenObservation {
  readonly scope: SessionScope
  readonly sourceId: string
  readonly observedAtMs: number
  readonly [extra: string]: unknown
}

export interface KnowledgeReference {
  readonly scope: SessionScope
  readonly [extra: string]: unknown
}

/** A frozen, authority-issued view of the session. Only the issuing SessionContext accepts it back. */
export interface ContextSnapshot {
  readonly scope: SessionScope
  readonly generation: number
  readonly contextRevision: number
  readonly permissionFingerprint: string
  readonly outputKind: SessionOutputKind
  readonly mode: string
  readonly objective: string
  readonly transcript: TranscriptSnapshot
  readonly screen: ScreenObservation | null
  readonly knowledge: readonly KnowledgeReference[]
}

export interface SessionContextOptions {
  scope: SessionScope
  permissions?: readonly string[]
  mode?: string
  objective?: string
}

const OutputKindSchema = z.enum(SESSION_OUTPUT_KINDS)
const PermissionsSchema = z.array(z.unknown()).max(64)
const PermissionIdSchema = z.string().regex(/^[a-z][a-z0-9_.:-]{0,79}$/)
const ModeSchema = z.string().max(80)
const ObjectiveSchema = z.string().max(2_000)
const RevisionSchema = z.number().int().nonnegative().safe()
const ArraySchema = z.array(z.unknown())
const ScreenIdSchema = z.string().max(128)
const ScreenTimeSchema = z.number().int().nonnegative().safe()
const RecordSchema = z.record(z.unknown())

function check<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, code: ContractErrorCode): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ContractError(code)
  return parsed.data
}

function normalizePermissions(permissions: unknown): string[] {
  const list = check(PermissionsSchema, permissions, 'PERMISSIONS_SHAPE')
  const ids = list.map((permission) => check(PermissionIdSchema, permission, 'PERMISSION_ID'))
  return [...new Set(ids)].sort()
}

/** Authority belongs to this instance. A caller-created lookalike snapshot is rejected. */
export class SessionContext {
  readonly #scope: SessionScope
  #permissions: string[]
  #generation = 1
  #revision = 1
  #active = true
  readonly #issued = new WeakSet<object>()
  readonly #listeners = new Set<(reason: SessionChangeReason) => void>()
  readonly #mode: string
  readonly #objective: string
  #transcript: TranscriptSnapshot
  #screen: ScreenObservation | null = null
  #knowledge: KnowledgeReference[] = []

  constructor({ scope, permissions = [], mode = 'meeting', objective = '' }: SessionContextOptions) {
    this.#scope = validateScope(scope)
    this.#permissions = normalizePermissions(permissions)
    this.#mode = check(ModeSchema, mode, 'MODE')
    this.#objective = check(ObjectiveSchema, objective, 'OBJECTIVE')
    this.#transcript = { scope: this.#scope, revision: 0, segments: [], interim: [] }
  }

  get scope(): SessionScope {
    return this.#scope
  }

  get active(): boolean {
    return this.#active
  }

  get generation(): number {
    return this.#generation
  }

  get revision(): number {
    return this.#revision
  }

  get permissionFingerprint(): string {
    return canonical(this.#permissions)
  }

  hasPermissions(required: readonly string[]): boolean {
    return required.every((item) => this.#permissions.includes(item))
  }

  assertActor(actor: unknown): void {
    assertSameScope(this.#scope, actor)
  }

  snapshot(outputKind: SessionOutputKind): ContextSnapshot {
    requireCondition(this.#active, 'SESSION_STOPPED')
    const kind = check(OutputKindSchema, outputKind, 'OUTPUT_KIND')
    const snapshot = freezeData(
      copyData({
        scope: this.#scope,
        generation: this.#generation,
        contextRevision: this.#revision,
        permissionFingerprint: this.permissionFingerprint,
        outputKind: kind,
        mode: this.#mode,
        objective: this.#objective,
        transcript: this.#transcript,
        screen: this.#screen,
        knowledge: this.#knowledge
      })
    ) as unknown as ContextSnapshot
    this.#issued.add(snapshot)
    return snapshot
  }

  assertCurrent(snapshot: ContextSnapshot): void {
    requireCondition(snapshot && typeof snapshot === 'object' && this.#issued.has(snapshot), 'SNAPSHOT_NOT_ISSUED')
    this.assertActor(snapshot.scope)
    requireCondition(this.#active, 'SESSION_STOPPED')
    requireCondition(snapshot.generation === this.#generation, 'STALE_GENERATION')
    requireCondition(snapshot.contextRevision === this.#revision, 'STALE_CONTEXT')
    requireCondition(snapshot.permissionFingerprint === this.permissionFingerprint, 'STALE_PERMISSIONS')
  }

  isCurrent(snapshot: ContextSnapshot): boolean {
    try {
      this.assertCurrent(snapshot)
      return true
    } catch {
      return false
    }
  }

  onChange(listener: (reason: SessionChangeReason) => void): () => void {
    requireCondition(typeof listener === 'function', 'LISTENER')
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #changed(reason: SessionChangeReason, newGeneration = false): void {
    if (newGeneration) this.#generation += 1
    this.#revision += 1
    for (const listener of [...this.#listeners]) {
      try {
        listener(reason)
      } catch {
        // One observer cannot stop authority invalidation.
      }
    }
  }

  updateTranscript(transcript: TranscriptSnapshot): boolean {
    const copied = copyData(transcript)
    const record = check(RecordSchema, copied, 'TRANSCRIPT_SHAPE')
    this.assertActor(record.scope)
    const revision = check(RevisionSchema, record.revision, 'TRANSCRIPT_REVISION')
    const segments = check(ArraySchema, record.segments, 'TRANSCRIPT_SHAPE')
    const interim = check(ArraySchema, record.interim, 'TRANSCRIPT_SHAPE')
    requireCondition(revision >= this.#transcript.revision, 'TRANSCRIPT_REGRESSION')
    if (revision === this.#transcript.revision) {
      requireCondition(canonical(copied) === canonical(this.#transcript), 'TRANSCRIPT_REVISION_COLLISION')
      return false
    }
    this.#transcript = {
      scope: this.#scope,
      revision,
      segments: segments as JsonValue[],
      interim: interim as JsonValue[]
    }
    this.#changed('transcript')
    return true
  }

  setScreen(observation: ScreenObservation | null): boolean {
    let next: ScreenObservation | null = null
    if (observation !== null) {
      const record = check(RecordSchema, copyData(observation), 'DATA_OBJECT')
      this.assertActor(record.scope)
      check(ScreenIdSchema, record.sourceId, 'SCREEN_ID')
      check(ScreenTimeSchema, record.observedAtMs, 'SCREEN_TIME')
      next = record as unknown as ScreenObservation
    }
    if (canonical(next) === canonical(this.#screen)) return false
    this.#screen = next
    this.#changed('screen')
    return true
  }

  setKnowledge(references: readonly KnowledgeReference[]): boolean {
    const next = check(ArraySchema, copyData(references), 'KNOWLEDGE_SHAPE')
    for (const reference of next) this.assertActor(check(RecordSchema, reference, 'KNOWLEDGE_SHAPE').scope)
    if (canonical(next) === canonical(this.#knowledge)) return false
    this.#knowledge = next as unknown as KnowledgeReference[]
    this.#changed('knowledge')
    return true
  }

  setPermissions(permissions: readonly string[]): boolean {
    const next = normalizePermissions(permissions)
    if (canonical(next) === this.permissionFingerprint) return false
    this.#permissions = next
    this.#changed('permissions', true)
    return true
  }

  stop(): boolean {
    if (!this.#active) return false
    this.#active = false
    this.#changed('stop', true)
    return true
  }

  resume(): boolean {
    if (this.#active) return false
    this.#active = true
    this.#changed('resume', true)
    return true
  }
}
