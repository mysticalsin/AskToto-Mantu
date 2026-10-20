import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, safeStorage, webContents } from 'electron'
import { OwnerSessionRefSchema } from '@shared/contracts/owner-session'
import type { OwnerSessionRef, OwnerSessionRevokeReason } from '@shared/contracts/owner-session'
import { authSessionGeneration, authStatus } from '../auth'

/** Structural stand-in for Electron.WebFrameMain so tests can use plain objects. */
export interface FrameLike {
  readonly processId: number
  readonly routingId: number
}

export type OwnerSessionValidation =
  | { ok: true }
  | { ok: false; reason: 'stale-auth' | 'wrong-owner' | 'wrong-frame' | 'stale-context' | 'revoked' | 'unknown' }

export interface OwnerSessionAuthority {
  mint(frame: FrameLike, contextRevision: number): OwnerSessionRef | null
  validate(ref: OwnerSessionRef, frame: FrameLike): OwnerSessionValidation
  /** Read-only: the live ref for the frame under the current auth, or null. Never mints, drops or revokes. */
  current(frame: FrameLike): OwnerSessionRef | null
  revokeAll(reason: OwnerSessionRevokeReason): void
  revokeFrame(webContentsId: number, reason: OwnerSessionRevokeReason): void
  onRevoked(cb: (ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void): () => void
}

export interface OwnerSessionAuthorityDeps {
  identityId(): string | null
  authGeneration(): number
  currentContextRevision(): number
  salt(): Buffer | null
  webContentsIdOf(frame: FrameLike): number | null
  now?(): number
  uuid?(): string
}

const KEY_CONTEXT = 'metis.owner-key.v1\0'
const SALT_BYTES = 32
const REVOKED_CAP = 256

/** HMAC-SHA256(salt, context + identity id), lowercase hex. Never contains the identity id. */
export function deriveOwnerKey(salt: Buffer, identityId: string): string {
  return createHmac('sha256', salt)
    .update(KEY_CONTEXT + identityId)
    .digest('hex')
}

function sameRef(a: OwnerSessionRef, b: OwnerSessionRef): boolean {
  return (
    a.v === b.v &&
    a.ownerKey === b.ownerKey &&
    a.authGeneration === b.authGeneration &&
    a.sessionId === b.sessionId &&
    a.frameOwner === b.frameOwner &&
    a.contextRevision === b.contextRevision &&
    a.issuedAt === b.issuedAt
  )
}

interface LiveEntry {
  readonly ref: OwnerSessionRef
  readonly webContentsId: number
}

export function createOwnerSessionAuthority(deps: OwnerSessionAuthorityDeps): OwnerSessionAuthority {
  const now = deps.now ?? Date.now
  const uuid = deps.uuid ?? randomUUID
  const live = new Map<string, LiveEntry>()
  const byFrame = new Map<string, string>()
  const revoked = new Set<string>()
  const listeners = new Set<(ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void>()

  const currentOwnerKey = (): string | null => {
    const identity = deps.identityId()
    const salt = deps.salt()
    return identity && salt ? deriveOwnerKey(salt, identity) : null
  }

  const remember = (sessionId: string): void => {
    revoked.add(sessionId)
    while (revoked.size > REVOKED_CAP) {
      const oldest = revoked.values().next().value
      if (oldest === undefined) break
      revoked.delete(oldest)
    }
  }

  const drop = (entry: LiveEntry): void => {
    live.delete(entry.ref.sessionId)
    if (byFrame.get(entry.ref.frameOwner) === entry.ref.sessionId) byFrame.delete(entry.ref.frameOwner)
  }

  const revokeMatching = (match: (entry: LiveEntry) => boolean, reason: OwnerSessionRevokeReason): void => {
    const hit = [...live.values()].filter(match)
    for (const entry of hit) {
      drop(entry)
      remember(entry.ref.sessionId)
    }
    for (const entry of hit) {
      for (const listener of [...listeners]) {
        try {
          listener(entry.ref, reason)
        } catch {
          // a throwing listener must not stop the others
        }
      }
    }
  }

  return {
    mint(frame, contextRevision) {
      const ownerKey = currentOwnerKey()
      if (!ownerKey) return null
      const webContentsId = deps.webContentsIdOf(frame)
      if (webContentsId === null) return null
      if (!Number.isSafeInteger(frame.processId) || !Number.isSafeInteger(frame.routingId)) return null
      const frameOwner = `${frame.processId}:${frame.routingId}`
      const authGeneration = deps.authGeneration()
      const existingId = byFrame.get(frameOwner)
      const existing = existingId ? live.get(existingId) : undefined
      if (
        existing &&
        existing.ref.ownerKey === ownerKey &&
        existing.ref.authGeneration === authGeneration &&
        existing.ref.contextRevision === contextRevision
      ) {
        return existing.ref
      }
      if (existing) drop(existing)
      const ref = Object.freeze(
        OwnerSessionRefSchema.parse({
          v: 1,
          ownerKey,
          authGeneration,
          sessionId: uuid(),
          frameOwner,
          contextRevision,
          issuedAt: now()
        })
      )
      live.set(ref.sessionId, { ref, webContentsId })
      byFrame.set(frameOwner, ref.sessionId)
      return ref
    },
    current(frame) {
      const sessionId = byFrame.get(`${frame.processId}:${frame.routingId}`)
      const entry = sessionId ? live.get(sessionId) : undefined
      if (!entry) return null
      const ownerKey = currentOwnerKey()
      if (!ownerKey || entry.ref.ownerKey !== ownerKey) return null
      if (entry.ref.authGeneration !== deps.authGeneration()) return null
      return entry.ref
    },
    validate(ref, frame) {
      if (!OwnerSessionRefSchema.safeParse(ref).success) return { ok: false, reason: 'unknown' }
      const entry = live.get(ref.sessionId)
      if (!entry) return { ok: false, reason: revoked.has(ref.sessionId) ? 'revoked' : 'unknown' }
      if (!sameRef(entry.ref, ref)) return { ok: false, reason: 'unknown' }
      if (deps.authGeneration() !== ref.authGeneration) return { ok: false, reason: 'stale-auth' }
      const ownerKey = currentOwnerKey()
      if (!ownerKey || ownerKey !== ref.ownerKey) return { ok: false, reason: 'wrong-owner' }
      if (`${frame.processId}:${frame.routingId}` !== ref.frameOwner) return { ok: false, reason: 'wrong-frame' }
      if (deps.currentContextRevision() !== ref.contextRevision) return { ok: false, reason: 'stale-context' }
      return { ok: true }
    },
    revokeAll(reason) {
      revokeMatching(() => true, reason)
    },
    revokeFrame(webContentsId, reason) {
      revokeMatching((entry) => entry.webContentsId === webContentsId, reason)
    },
    onRevoked(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    }
  }
}

export interface OwnerKeySaltIo {
  readFile(p: string): Promise<Buffer>
  writeFile(p: string, data: Buffer, opts: { mode: number }): Promise<void>
  mkdir(p: string, opts: { recursive: true; mode: number }): Promise<unknown>
  rename(from: string, to: string): Promise<void>
}

export interface OwnerKeySaltCrypto {
  wrap: boolean
  encrypt(plain: string): Buffer
  decrypt(buf: Buffer): string
}

/**
 * Loads (or creates) the per-install owner-key salt. An existing non-empty file that cannot be decoded
 * fails closed: null is returned and the file is never overwritten or deleted.
 */
export async function loadOwnerKeySalt(
  path: string,
  io: OwnerKeySaltIo,
  crypto: OwnerKeySaltCrypto,
  random: (n: number) => Buffer = randomBytes
): Promise<Buffer | null> {
  let existing: Buffer | null = null
  try {
    existing = await io.readFile(path)
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') return null
  }
  if (existing && existing.length > 0) {
    try {
      const salt = crypto.wrap ? Buffer.from(crypto.decrypt(existing), 'base64') : existing
      return salt.length === SALT_BYTES ? Buffer.from(salt) : null
    } catch {
      return null
    }
  }
  try {
    const salt = random(SALT_BYTES)
    const payload = crypto.wrap ? crypto.encrypt(salt.toString('base64')) : salt
    await io.mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.tmp-${random(8).toString('hex')}`
    await io.writeFile(tmp, payload, { mode: 0o600 })
    await io.rename(tmp, path)
    return salt
  } catch {
    return null
  }
}

/** The only Electron-touching factory. The salt loads once in the background; mint is null until it resolves. */
export function createMainOwnerSessionAuthority(currentContextRevision: () => number): OwnerSessionAuthority {
  let salt: Buffer | null = null
  const path = join(app.getPath('userData'), 'identity', 'owner-key-salt.v1')
  const crypto: OwnerKeySaltCrypto = {
    wrap: app.isPackaged && safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (buf) => safeStorage.decryptString(buf)
  }
  loadOwnerKeySalt(path, { readFile: (p) => readFile(p), writeFile, mkdir, rename }, crypto)
    .then((loaded) => {
      salt = loaded
    })
    .catch(() => {
      salt = null
    })
  return createOwnerSessionAuthority({
    identityId: () => {
      const status = authStatus()
      const email = status.signedIn && typeof status.email === 'string' ? status.email.trim().toLowerCase() : ''
      return email.length > 0 ? email : null
    },
    authGeneration: () => authSessionGeneration(),
    currentContextRevision,
    salt: () => salt,
    webContentsIdOf: (frame) => {
      try {
        return webContents.fromFrame(frame as Electron.WebFrameMain)?.id ?? null
      } catch {
        return null
      }
    }
  })
}
