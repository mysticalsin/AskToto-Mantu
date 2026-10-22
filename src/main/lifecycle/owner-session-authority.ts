import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, safeStorage, webContents } from 'electron'
import { OwnerSessionRefSchema } from '@shared/contracts/owner-session'
import type { OwnerSessionRef, OwnerSessionRevokeReason } from '@shared/contracts/owner-session'
import { authSessionGeneration, authStatus, authTenantId } from '../auth'

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
  /** Read-only: the signed-in owner's key right now, or null while signed out or before the salt has loaded. */
  currentOwnerKey(): string | null
  /** Read-only: the verified tenant's key right now, or null while signed out, before the salt has loaded, or when the tenant is unknown. */
  currentTenantKey(): string | null
  revokeAll(reason: OwnerSessionRevokeReason): void
  revokeFrame(webContentsId: number, reason: OwnerSessionRevokeReason): void
  onRevoked(cb: (ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void): () => void
}

export interface OwnerSessionAuthorityDeps {
  identityId(): string | null
  /** The verified sign-in tenant id (Entra `tid`), or null while signed out or when it is unknown. */
  tenantId(): string | null
  authGeneration(): number
  currentContextRevision(): number
  salt(): Buffer | null
  webContentsIdOf(frame: FrameLike): number | null
  now?(): number
  uuid?(): string
}

const KEY_CONTEXT = 'metis.owner-key.v1\0'
const TENANT_KEY_CONTEXT = 'metis.tenant-key.v1\0'
const SALT_BYTES = 32
const REVOKED_CAP = 256

/** HMAC-SHA256(salt, context + identity id), lowercase hex. Never contains the identity id. */
export function deriveOwnerKey(salt: Buffer, identityId: string): string {
  return createHmac('sha256', salt)
    .update(KEY_CONTEXT + identityId)
    .digest('hex')
}

/** HMAC-SHA256(salt, context + tenant id), lowercase hex. A different context from the owner key, so the two never collide. */
export function deriveTenantKey(salt: Buffer, tenantId: string): string {
  return createHmac('sha256', salt)
    .update(TENANT_KEY_CONTEXT + tenantId)
    .digest('hex')
}

function sameRef(a: OwnerSessionRef, b: OwnerSessionRef): boolean {
  return (
    a.v === b.v &&
    a.ownerKey === b.ownerKey &&
    a.tenantKey === b.tenantKey &&
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
  const RETIRED_CAP = 256
  const RETIRED_PER_FRAME_CAP = 64
  const REFUSED_MESSAGE = 'owner-session-refused'

  const now = deps.now ?? Date.now
  const uuid = deps.uuid ?? randomUUID
  const live = new Map<string, LiveEntry>()
  const byFrame = new Map<string, string>()
  // Superseded entries kept until revoked, so revocation can notify the exact retained refs.
  const retired = new Map<string, LiveEntry>()
  const revoked = new Set<string>()
  const listeners = new Set<(ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void>()

  const currentOwnerKey = (): string | null => {
    const identity = deps.identityId()
    const salt = deps.salt()
    return identity && salt ? deriveOwnerKey(salt, identity) : null
  }

  const currentTenantKey = (): string | null => {
    const tenant = deps.tenantId()
    const salt = deps.salt()
    return tenant && salt ? deriveTenantKey(salt, tenant) : null
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

  const retiredCountFor = (frameOwner: string): number => {
    let count = 0
    for (const entry of retired.values()) {
      if (entry.ref.frameOwner === frameOwner) count += 1
    }
    return count
  }

  const revokeMatching = (match: (entry: LiveEntry) => boolean, reason: OwnerSessionRevokeReason): void => {
    // Retired entries first (oldest first), then live ones.
    const hit = [...retired.values(), ...live.values()].filter(match)
    for (const entry of hit) {
      drop(entry)
      retired.delete(entry.ref.sessionId)
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
    currentOwnerKey,
    currentTenantKey,
    mint(frame, contextRevision) {
      const ownerKey = currentOwnerKey()
      if (!ownerKey) return null
      const tenantKey = currentTenantKey()
      if (!tenantKey) return null
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
        existing.ref.tenantKey === tenantKey &&
        existing.ref.authGeneration === authGeneration &&
        existing.ref.contextRevision === contextRevision
      ) {
        return existing.ref
      }
      if (existing && (retired.size >= RETIRED_CAP || retiredCountFor(frameOwner) >= RETIRED_PER_FRAME_CAP)) {
        throw new Error(REFUSED_MESSAGE)
      }
      const sessionId = uuid()
      if (live.has(sessionId) || retired.has(sessionId) || revoked.has(sessionId)) {
        throw new Error(REFUSED_MESSAGE)
      }
      // Parse and freeze before any mutation: a parse throw leaves all state unchanged.
      const ref = Object.freeze(
        OwnerSessionRefSchema.parse({
          v: 1,
          ownerKey,
          tenantKey,
          authGeneration,
          sessionId,
          frameOwner,
          contextRevision,
          issuedAt: now()
        })
      )
      if (existing) {
        drop(existing)
        retired.set(existing.ref.sessionId, existing)
      }
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
      if (entry.ref.tenantKey !== currentTenantKey()) return null
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
      if (currentTenantKey() !== ref.tenantKey) return { ok: false, reason: 'wrong-owner' }
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
    wrap: app.isPackaged && !process.env.ASKTOTO_LOCAL_KEYSTORE && safeStorage.isEncryptionAvailable(),
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
    tenantId: () => (authStatus().signedIn ? authTenantId() : null),
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
