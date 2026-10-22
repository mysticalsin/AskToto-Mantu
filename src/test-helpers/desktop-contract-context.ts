import { check, copyData, canonical, freezeData } from '../main/features/desktop-contract/contract-data'

/**
 * Test double for the session context the desktop contracts consume (scope, permissions, issued
 * snapshots, generation and revision, change listeners). Mirrors the reference kernel behaviour the
 * dictation guard and routine coordinator tests rely on. Replace with the kernel SessionContext
 * once the kernel port lands.
 */
export interface FixtureScope {
  tenantId: string
  userId: string
  sessionId: string
}

export interface FixtureSnapshot {
  readonly scope: FixtureScope
  readonly generation: number
  readonly contextRevision: number
  readonly permissionFingerprint: string
  readonly outputKind: string
}

const OUTPUTS = new Set(['conversation', 'screen', 'manual', 'followup'])

export class FixtureSessionContext {
  readonly scope: FixtureScope
  private permissions: string[]
  private generation = 1
  private revision = 1
  private running = true
  private readonly issued = new WeakSet<object>()
  private readonly listeners = new Set<(reason: string) => void>()

  constructor(input: { scope: FixtureScope; permissions?: string[] }) {
    this.scope = freezeData(copyData(input.scope))
    this.permissions = [...new Set(input.permissions ?? [])].sort()
  }

  get active(): boolean {
    return this.running
  }

  get permissionFingerprint(): string {
    return canonical(this.permissions)
  }

  hasPermissions(required: string[]): boolean {
    return required.every((item) => this.permissions.includes(item))
  }

  assertActor(actor: FixtureScope): void {
    check(canonical(this.scope) === canonical(actor), 'SCOPE_MISMATCH')
  }

  snapshot(outputKind: string): FixtureSnapshot {
    check(this.running, 'SESSION_STOPPED')
    check(OUTPUTS.has(outputKind), 'OUTPUT_KIND')
    const snapshot = freezeData(
      copyData({
        scope: this.scope,
        generation: this.generation,
        contextRevision: this.revision,
        permissionFingerprint: this.permissionFingerprint,
        outputKind
      })
    )
    this.issued.add(snapshot)
    return snapshot
  }

  assertCurrent(snapshot: FixtureSnapshot): void {
    check(snapshot && this.issued.has(snapshot), 'SNAPSHOT_NOT_ISSUED')
    this.assertActor(snapshot.scope)
    check(this.running, 'SESSION_STOPPED')
    check(snapshot.generation === this.generation, 'STALE_GENERATION')
    check(snapshot.contextRevision === this.revision, 'STALE_CONTEXT')
    check(snapshot.permissionFingerprint === this.permissionFingerprint, 'STALE_PERMISSIONS')
  }

  isCurrent(snapshot: FixtureSnapshot): boolean {
    try {
      this.assertCurrent(snapshot)
      return true
    } catch {
      return false
    }
  }

  onChange(listener: (reason: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setPermissions(permissions: string[]): boolean {
    const next = [...new Set(permissions)].sort()
    if (canonical(next) === this.permissionFingerprint) return false
    this.permissions = next
    this.generation += 1
    this.revision += 1
    for (const listener of [...this.listeners]) {
      try {
        listener('permissions')
      } catch {
        // One observer cannot stop authority invalidation.
      }
    }
    return true
  }
}
