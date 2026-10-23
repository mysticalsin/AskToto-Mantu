import { randomUUID } from 'node:crypto'
import { SNAPSHOT_GESTURES, type GrantResult, type SnapshotGesture } from '@shared/context-manifest'
import type { SnapshotStore } from './snapshot-store'

/** Where a granted document came from, as main observed it, when, and by which gesture. Never the content. */
export interface GrantProvenance {
  app: string | null
  sourceId: string
  observationId: string
  observedAt: number
  grantedAt: number
  gesture: SnapshotGesture
}

export interface DocumentGrant {
  grantId: string
  snapshotId: string
  ownerId: string
  generation: number
  sessionId: string
  expiresAt: number
  provenance: GrantProvenance
}

export interface DocumentGrantsDeps {
  store: Pick<SnapshotStore, 'metas' | 'onRemoved' | 'remove'>
  owner(): string | null
  generation(): number
  /** The main-owned id of the session or conversation in force; a grant ends when it changes. */
  sessionId(): string
  now(): number
  ttlMs?: number
  limit?: number
  newId?(): string
}

export interface DocumentGrants {
  /** "Use this whole document" for the session in force. The snapshot must be held, valid and the owner's. */
  grant(input: { snapshotId: string; gesture: SnapshotGesture }): GrantResult
  /** Grants still in force: same owner, same capture generation, same session, not expired. Drops the rest. */
  active(): DocumentGrant[]
  isGranted(snapshotId: string): boolean
  revoke(grantId: string): boolean
  revokeAll(reason: string): void
}

/** Owner-approved style lifetime for a conversation-scoped grant (G31 uses the same hour). */
export const DOCUMENT_GRANT_TTL_MS = 60 * 60_000
export const DOCUMENT_GRANT_LIMIT = 4

const GESTURES: ReadonlySet<string> = new Set(SNAPSHOT_GESTURES)

/**
 * Whole-document context grants (G46). A grant turns one explicit snapshot from "the next turn only" into "every turn
 * of this session". It is bound to the owner, the capture generation and the session, so a stop, a sign-out, an owner
 * switch, a lock or the end of the session ends it without anyone having to remember to.
 */
export function createDocumentGrants(deps: DocumentGrantsDeps): DocumentGrants {
  const ttlMs = deps.ttlMs ?? DOCUMENT_GRANT_TTL_MS
  const limit = deps.limit ?? DOCUMENT_GRANT_LIMIT
  const newId = deps.newId ?? (() => randomUUID().replace(/-/g, '').slice(0, 24))
  const grants = new Map<string, DocumentGrant>()

  const inForce = (g: DocumentGrant): boolean =>
    g.ownerId === deps.owner() &&
    g.generation === deps.generation() &&
    g.sessionId === deps.sessionId() &&
    deps.now() < g.expiresAt

  /** Ending a grant also deletes the document it covered: it must not fall back to being a one-turn snapshot. */
  const end = (id: string): void => {
    const g = grants.get(id)
    if (!g) return
    grants.delete(id)
    void deps.store.remove(g.snapshotId).catch(() => undefined)
  }

  const prune = (): void => {
    for (const [id, g] of [...grants]) if (!inForce(g)) end(id)
  }

  deps.store.onRemoved((snapshotId) => {
    for (const [id, g] of [...grants]) if (g.snapshotId === snapshotId) grants.delete(id)
  })

  return {
    grant({ snapshotId, gesture }) {
      if (!GESTURES.has(gesture)) return { ok: false, reason: 'invalid' }
      const ownerId = deps.owner()
      if (ownerId === null) return { ok: false, reason: 'signed-out' }
      prune()
      const meta = deps.store.metas().find((m) => m.snapshotId === snapshotId)
      if (!meta) return { ok: false, reason: 'not-found' }
      if (grants.size >= limit) return { ok: false, reason: 'limit' }
      const now = deps.now()
      const grant: DocumentGrant = {
        grantId: newId(),
        snapshotId,
        ownerId,
        generation: deps.generation(),
        sessionId: deps.sessionId(),
        // A grant never outlives the snapshot it covers.
        expiresAt: Math.min(now + ttlMs, meta.expiresAt),
        provenance: {
          app: meta.app,
          sourceId: meta.sourceId,
          observationId: meta.observationId,
          observedAt: meta.observedAt,
          grantedAt: now,
          gesture
        }
      }
      grants.set(grant.grantId, grant)
      return { ok: true, grantId: grant.grantId, expiresAt: grant.expiresAt }
    },
    active() {
      prune()
      return [...grants.values()]
    },
    isGranted(snapshotId) {
      prune()
      return [...grants.values()].some((g) => g.snapshotId === snapshotId)
    },
    revoke(grantId) {
      const had = grants.has(grantId)
      end(grantId)
      return had
    },
    revokeAll() {
      for (const id of [...grants.keys()]) end(id)
    }
  }
}
