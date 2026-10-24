/**
 * Test-only stand-in for SessionContext (G02), implementing the structural InterventionContext view:
 * snapshots are issued by the instance, and any context change invalidates them. Synthetic data only.
 */
import type {
  InterventionContext,
  InterventionScope,
  InterventionSegment,
  InterventionSnapshot
} from '../shared/intervention-contract'

export class FakeContextError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

export const SYNTHETIC_SCOPE: InterventionScope = {
  tenantId: 'synthetic-tenant',
  userId: 'synthetic-user',
  sessionId: 'synthetic-session'
}

export function syntheticSegments(
  scope: InterventionScope,
  count: number,
  text = 'Synthetic final text'
): InterventionSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    scope,
    state: 'final',
    utteranceId: `synthetic-utterance-${index}`,
    streamId: 'microphone',
    streamEpoch: 1,
    revision: 1,
    speakerId: 'YOU',
    text
  }))
}

export class FakeSessionContext implements InterventionContext<InterventionSnapshot> {
  readonly scope: InterventionScope
  generation = 1
  revision = 1
  private active = true
  private permissions: string[] = []
  private objective: string
  private segments: InterventionSegment[] = []
  private screen: string | null = null
  private readonly issued = new WeakSet<object>()
  private readonly listeners = new Set<(reason: string) => void>()

  constructor(scope: InterventionScope = SYNTHETIC_SCOPE, objective = 'Synthetic meeting objective') {
    this.scope = scope
    this.objective = objective
  }

  get permissionFingerprint(): string {
    return JSON.stringify([...this.permissions].sort())
  }

  snapshot(_outputKind: 'conversation' | 'manual' = 'conversation'): InterventionSnapshot & {
    permissionFingerprint: string
  } {
    if (!this.active) throw new FakeContextError('SESSION_STOPPED')
    const snapshot = Object.freeze({
      scope: this.scope,
      generation: this.generation,
      contextRevision: this.revision,
      permissionFingerprint: this.permissionFingerprint,
      objective: this.objective,
      screen: this.screen,
      transcript: Object.freeze({ scope: this.scope, segments: Object.freeze([...this.segments]) })
    })
    this.issued.add(snapshot)
    return snapshot
  }

  assertCurrent(snapshot: InterventionSnapshot & { permissionFingerprint?: string }): void {
    if (!snapshot || !this.issued.has(snapshot)) throw new FakeContextError('SNAPSHOT_NOT_ISSUED')
    if (!this.active) throw new FakeContextError('SESSION_STOPPED')
    if (snapshot.generation !== this.generation) throw new FakeContextError('STALE_GENERATION')
    if (snapshot.contextRevision !== this.revision) throw new FakeContextError('STALE_CONTEXT')
    if (snapshot.permissionFingerprint !== this.permissionFingerprint) throw new FakeContextError('STALE_PERMISSIONS')
  }

  isCurrent(snapshot: InterventionSnapshot): boolean {
    try {
      this.assertCurrent(snapshot)
      return true
    } catch {
      return false
    }
  }

  onChange(listener: (reason: string) => void): () => boolean {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setTranscript(segments: InterventionSegment[]): void {
    this.segments = segments
    this.changed('transcript')
  }

  setScreen(text: string): void {
    this.screen = text
    this.changed('screen')
  }

  setPermissions(permissions: string[]): void {
    this.permissions = permissions
    this.generation += 1
    this.changed('permissions')
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    this.generation += 1
    this.changed('stop')
  }

  resume(): void {
    if (this.active) return
    this.active = true
    this.generation += 1
    this.changed('resume')
  }

  private changed(reason: string): void {
    this.revision += 1
    for (const listener of [...this.listeners]) listener(reason)
  }
}
