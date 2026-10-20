import { describe, expect, it, vi } from 'vitest'
import type { OwnerSessionRef } from '@shared/contracts/owner-session'

vi.mock('electron', () => ({ app: {}, safeStorage: {}, webContents: {} }))
vi.mock('../auth', () => ({ authStatus: vi.fn(), authSessionGeneration: vi.fn() }))

import {
  createOwnerSessionAuthority,
  deriveOwnerKey,
  loadOwnerKeySalt,
  type OwnerKeySaltCrypto,
  type OwnerKeySaltIo
} from './owner-session-authority'

const frameA = { processId: 12, routingId: 3 }
const frameB = { processId: 13, routingId: 4 }

function setup() {
  const state = {
    identity: 'person@example.com' as string | null,
    gen: 1,
    rev: 10,
    salt: Buffer.alloc(32, 9) as Buffer | null
  }
  const wcByFrame = new Map<string, number>([
    ['12:3', 1],
    ['13:4', 2]
  ])
  let n = 0
  const authority = createOwnerSessionAuthority({
    identityId: () => state.identity,
    authGeneration: () => state.gen,
    currentContextRevision: () => state.rev,
    salt: () => state.salt,
    webContentsIdOf: (frame) => wcByFrame.get(`${frame.processId}:${frame.routingId}`) ?? null,
    now: () => 1_700_000_000_000,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  })
  return { state, authority }
}

function mustMint(authority: ReturnType<typeof setup>['authority'], frame = frameA, rev = 10): OwnerSessionRef {
  const ref = authority.mint(frame, rev)
  if (!ref) throw new Error('expected a ref')
  return ref
}

describe('owner-session authority', () => {
  it('mints null when signed out', () => {
    const { state, authority } = setup()
    state.identity = null
    expect(authority.mint(frameA, 10)).toBeNull()
    state.identity = 'person@example.com'
    state.salt = null
    expect(authority.mint(frameA, 10)).toBeNull()
  })

  it('refuses a ref after auth generation advances', () => {
    const { state, authority } = setup()
    const ref = mustMint(authority)
    expect(authority.validate(ref, frameA)).toEqual({ ok: true })
    state.gen += 1
    expect(authority.validate(ref, frameA)).toEqual({ ok: false, reason: 'stale-auth' })
  })

  it('refuses a ref presented from a different frame owner', () => {
    const { authority } = setup()
    const ref = mustMint(authority)
    expect(authority.validate(ref, frameB)).toEqual({ ok: false, reason: 'wrong-frame' })
  })

  it('refuses a forged ref with a matching shape but unknown sessionId', () => {
    const { authority } = setup()
    const ref = mustMint(authority)
    const forged = { ...ref, sessionId: '11111111-1111-4111-8111-111111111111' }
    expect(authority.validate(forged, frameA)).toEqual({ ok: false, reason: 'unknown' })
    const mutated = { ...ref, ownerKey: 'f'.repeat(64) }
    expect(authority.validate(mutated, frameA)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses a malformed presented ref as unknown', () => {
    const { authority } = setup()
    const ref = mustMint(authority)
    expect(authority.validate({ ...ref, extra: 1 } as unknown as OwnerSessionRef, frameA)).toEqual({
      ok: false,
      reason: 'unknown'
    })
    expect(authority.validate({ ...ref, v: 2 } as unknown as OwnerSessionRef, frameA)).toEqual({
      ok: false,
      reason: 'unknown'
    })
  })

  it('revokeFrame leaves other webContents refs valid', () => {
    const { authority } = setup()
    const first = mustMint(authority, frameA)
    const second = mustMint(authority, frameB)
    authority.revokeFrame(1, 'renderer-reset')
    expect(authority.validate(first, frameA)).toEqual({ ok: false, reason: 'revoked' })
    expect(authority.validate(second, frameB)).toEqual({ ok: true })
  })

  it('ownerKey is stable across mints for one identity and differs across identities', () => {
    const { state, authority } = setup()
    const first = mustMint(authority, frameA, 10)
    state.rev = 11
    const second = mustMint(authority, frameA, 11)
    expect(second.ownerKey).toBe(first.ownerKey)
    state.identity = 'other@example.com'
    const third = mustMint(authority, frameB, 11)
    expect(third.ownerKey).not.toBe(first.ownerKey)
    expect(first.ownerKey).toMatch(/^[0-9a-f]{64}$/)
    expect(first.ownerKey).not.toContain('person')
    expect(first.ownerKey).toBe(deriveOwnerKey(Buffer.alloc(32, 9), 'person@example.com'))
  })

  it('validate reports revoked after revokeAll and notifies listeners', () => {
    const { authority } = setup()
    const ref = mustMint(authority)
    const received = vi.fn()
    const removed = vi.fn()
    authority.onRevoked(() => {
      throw new Error('listener failure')
    })
    authority.onRevoked(received)
    const off = authority.onRevoked(removed)
    off()
    authority.revokeAll('sign-out')
    expect(received).toHaveBeenCalledWith(ref, 'sign-out')
    expect(removed).not.toHaveBeenCalled()
    expect(authority.validate(ref, frameA)).toEqual({ ok: false, reason: 'revoked' })
  })

  it('mint returns the same ref for an unchanged frame', () => {
    const { authority } = setup()
    const first = mustMint(authority)
    const second = mustMint(authority)
    expect(second).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
  })

  it('refuses stale context revision', () => {
    const { state, authority } = setup()
    const ref = mustMint(authority)
    state.rev = 11
    expect(authority.validate(ref, frameA)).toEqual({ ok: false, reason: 'stale-context' })
  })
})

function fakeIo(files = new Map<string, Buffer>()) {
  const log = {
    mkdirs: [] as Array<{ path: string; mode: number }>,
    writes: [] as Array<{ path: string; mode: number }>,
    renames: [] as Array<{ from: string; to: string }>
  }
  const io: OwnerKeySaltIo = {
    async readFile(p) {
      const found = files.get(p)
      if (!found) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return found
    },
    async writeFile(p, data, opts) {
      log.writes.push({ path: p, mode: opts.mode })
      files.set(p, Buffer.from(data))
    },
    async mkdir(p, opts) {
      log.mkdirs.push({ path: p, mode: opts.mode })
    },
    async rename(from, to) {
      log.renames.push({ from, to })
      const data = files.get(from)
      if (data) files.set(to, data)
      files.delete(from)
    }
  }
  return { io, files, log }
}

const plainCrypto: OwnerKeySaltCrypto = {
  wrap: false,
  encrypt: () => {
    throw new Error('unused')
  },
  decrypt: () => {
    throw new Error('unused')
  }
}
const path = '/profile/identity/owner-key-salt.v1'
const fixedRandom = (n: number) => Buffer.alloc(n, 7)

describe('loadOwnerKeySalt', () => {
  it('loadOwnerKeySalt generates, persists atomically and reloads the same salt', async () => {
    const { io, files, log } = fakeIo()
    const salt = await loadOwnerKeySalt(path, io, plainCrypto, fixedRandom)
    expect(salt).toEqual(Buffer.alloc(32, 7))
    expect(log.mkdirs).toEqual([{ path: '/profile/identity', mode: 0o700 }])
    expect(log.writes).toHaveLength(1)
    expect(log.writes[0].path.startsWith(`${path}.tmp-`)).toBe(true)
    expect(log.writes[0].mode).toBe(0o600)
    expect(log.renames).toEqual([{ from: log.writes[0].path, to: path }])
    expect(files.get(path)).toEqual(Buffer.alloc(32, 7))
    const again = await loadOwnerKeySalt(path, io, plainCrypto, fixedRandom)
    expect(again).toEqual(salt)
    expect(log.writes).toHaveLength(1)
    expect(log.renames).toHaveLength(1)
  })

  it('loadOwnerKeySalt wraps with safeStorage when available', async () => {
    const { io, files } = fakeIo()
    const wrapped: OwnerKeySaltCrypto = {
      wrap: true,
      encrypt: (plain) => Buffer.from(`enc:${plain}`),
      decrypt: (buf) => buf.toString().slice(4)
    }
    const salt = await loadOwnerKeySalt(path, io, wrapped, fixedRandom)
    expect(salt).toEqual(Buffer.alloc(32, 7))
    expect(files.get(path)).not.toEqual(salt)
    const again = await loadOwnerKeySalt(path, io, wrapped, fixedRandom)
    expect(again).toEqual(salt)
  })

  it('loadOwnerKeySalt fails closed on an undecodable salt file without overwriting it', async () => {
    const short = Buffer.from([1, 2, 3, 4, 5])
    const plain = fakeIo(new Map([[path, short]]))
    expect(await loadOwnerKeySalt(path, plain.io, plainCrypto, fixedRandom)).toBeNull()
    expect(plain.log.writes).toHaveLength(0)
    expect(plain.log.renames).toHaveLength(0)
    expect(plain.files.get(path)).toEqual(Buffer.from([1, 2, 3, 4, 5]))

    const throwing: OwnerKeySaltCrypto = {
      wrap: true,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => {
        throw new Error('cannot decrypt')
      }
    }
    const wrapped = fakeIo(new Map([[path, Buffer.from('opaque-bytes')]]))
    expect(await loadOwnerKeySalt(path, wrapped.io, throwing, fixedRandom)).toBeNull()
    expect(wrapped.log.writes).toHaveLength(0)
    expect(wrapped.log.renames).toHaveLength(0)
    expect(wrapped.files.get(path)).toEqual(Buffer.from('opaque-bytes'))
  })
})
