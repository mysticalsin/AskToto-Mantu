import { randomUUID } from 'node:crypto'
import {
  SNAPSHOT_GESTURES,
  type ContextRefusal,
  type HeldSnapshot,
  type SnapshotGesture,
  type SnapshotKind,
  type SnapshotResult
} from '@shared/context-manifest'

/**
 * What one explicit capture observed, as main saw it. `generation` is the screen-observation revocation epoch the
 * frame was taken in (G16), `sourceId` and `observationId` name what it is of. The text is whatever main read from
 * it (an on-device reading of the screen, or of the document in the foreground window).
 */
export interface ObservedContent {
  sourceId: string
  observationId: string
  generation: number
  capturedAt: number
  text: string
  /** The app or window main observed in the foreground; null when it could not tell. */
  app: string | null
}

/** Sealed bytes by id. The only thing that ever touches disk. */
export interface SnapshotIo {
  write(id: string, data: Buffer): Promise<void>
  read(id: string): Promise<Buffer | null>
  remove(id: string): Promise<void>
  purge(): Promise<void>
}

export interface SnapshotMeta {
  snapshotId: string
  kind: SnapshotKind
  ownerId: string
  generation: number
  sourceId: string
  observationId: string
  app: string | null
  gesture: SnapshotGesture
  observedAt: number
  createdAt: number
  expiresAt: number
  bytes: number
}

export interface SnapshotStoreDeps {
  io: SnapshotIo
  /** Encrypts the record for disk (the app's own secret sealing). */
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  /** The owner in force (the active memory partition), or null when none is open. */
  owner(): string | null
  /** The screen-observation generation in force now. */
  generation(): number
  now(): number
  newId?(): string
  ttlMs?: number
  limit?: number
  maxChars?: number
}

export interface SnapshotStore {
  /**
   * The ONLY way a snapshot comes to exist: the owner explicitly asked (a typed or spoken screen or document intent,
   * or the capture button). `observe` runs only after the gesture is accepted; its result is dropped if access was
   * revoked, the owner changed or the capture generation moved while it ran.
   */
  request(
    input: { gesture: SnapshotGesture; kind: SnapshotKind },
    observe: () => Promise<ObservedContent>
  ): Promise<SnapshotResult>
  /** The held snapshots that are still valid for the owner in force, without their text. */
  list(): HeldSnapshot[]
  read(snapshotId: string): Promise<{ meta: SnapshotMeta; text: string } | null>
  /** The valid snapshots in the order taken. */
  metas(): SnapshotMeta[]
  remove(snapshotId: string): Promise<boolean>
  /** Drops what is no longer valid (expired, another owner, an older generation) and deletes its file. */
  sweep(): Promise<void>
  /** Sign-out, stop, owner switch, lock: forgets every snapshot, drops pending requests, deletes every file. */
  revokeAll(reason: string): Promise<void>
  onRemoved(listener: (snapshotId: string) => void): void
}

export const SNAPSHOT_TTL_MS = 15 * 60_000
export const SNAPSHOT_LIMIT = 4
/** A whole document, not a page of it; bounded so one snapshot cannot fill a prompt. */
export const SNAPSHOT_MAX_CHARS = 60_000

const GESTURES: ReadonlySet<string> = new Set(SNAPSHOT_GESTURES)

export function createSnapshotStore(deps: SnapshotStoreDeps): SnapshotStore {
  const ttlMs = deps.ttlMs ?? SNAPSHOT_TTL_MS
  const limit = deps.limit ?? SNAPSHOT_LIMIT
  const maxChars = deps.maxChars ?? SNAPSHOT_MAX_CHARS
  const newId = deps.newId ?? (() => randomUUID().replace(/-/g, '').slice(0, 24))
  const held = new Map<string, SnapshotMeta>()
  const removedListeners: Array<(id: string) => void> = []
  let epoch = 0

  const valid = (meta: SnapshotMeta): boolean =>
    meta.ownerId === deps.owner() && meta.generation === deps.generation() && deps.now() < meta.expiresAt

  const drop = async (id: string): Promise<void> => {
    held.delete(id)
    for (const listener of removedListeners) listener(id)
    try {
      await deps.io.remove(id)
    } catch {
      // an unreadable file is already unusable; the next purge removes it
    }
  }

  const summary = (meta: SnapshotMeta): HeldSnapshot => ({
    snapshotId: meta.snapshotId,
    kind: meta.kind,
    sourceId: meta.sourceId,
    app: meta.app,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    granted: false,
    bytes: meta.bytes
  })

  const refuse = (reason: ContextRefusal): SnapshotResult => ({ ok: false, reason })

  return {
    async request(input, observe) {
      if (!GESTURES.has(input.gesture)) return refuse('invalid')
      const ownerId = deps.owner()
      if (ownerId === null) return refuse('signed-out')
      const startedIn = epoch
      let observed: ObservedContent
      try {
        observed = await observe()
      } catch {
        return refuse('capture-failed')
      }
      // Revoked, switched owner or moved on while the capture ran: its pending work is dropped, never stored.
      if (startedIn !== epoch || deps.owner() !== ownerId || observed.generation !== deps.generation())
        return refuse('stale')
      const text = observed.text.trim().slice(0, maxChars)
      if (!text) return refuse('no-text')
      while (held.size >= limit) {
        const oldest = held.keys().next().value
        if (oldest === undefined) break
        await drop(oldest)
      }
      const now = deps.now()
      const meta: SnapshotMeta = {
        snapshotId: newId(),
        kind: input.kind,
        ownerId,
        generation: observed.generation,
        sourceId: observed.sourceId,
        observationId: observed.observationId,
        app: observed.app,
        gesture: input.gesture,
        observedAt: observed.capturedAt,
        createdAt: now,
        expiresAt: now + ttlMs,
        bytes: Buffer.byteLength(text, 'utf8')
      }
      try {
        await deps.io.write(meta.snapshotId, deps.seal(JSON.stringify({ meta, text })))
      } catch {
        return refuse('capture-failed')
      }
      if (startedIn !== epoch) {
        await deps.io.remove(meta.snapshotId).catch(() => undefined)
        return refuse('stale')
      }
      held.set(meta.snapshotId, meta)
      return { ok: true, snapshot: summary(meta) }
    },
    list() {
      return [...held.values()].filter(valid).map(summary)
    },
    metas() {
      return [...held.values()].filter(valid)
    },
    async read(snapshotId) {
      const meta = held.get(snapshotId)
      if (!meta) return null
      if (!valid(meta)) {
        await drop(snapshotId)
        return null
      }
      try {
        const sealed = await deps.io.read(snapshotId)
        if (!sealed) return null
        const record = JSON.parse(deps.open(sealed)) as { text?: unknown }
        return typeof record.text === 'string' ? { meta, text: record.text } : null
      } catch {
        return null
      }
    },
    async remove(snapshotId) {
      if (!held.has(snapshotId)) return false
      await drop(snapshotId)
      return true
    },
    async sweep() {
      for (const [id, meta] of [...held]) if (!valid(meta)) await drop(id)
    },
    async revokeAll() {
      epoch += 1
      for (const id of [...held.keys()]) await drop(id)
      await deps.io.purge().catch(() => undefined)
    },
    onRemoved(listener) {
      removedListeners.push(listener)
    }
  }
}
