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
const frameC = { processId: 14, routingId: 5 }
const frameD = { processId: 15, routingId: 6 }
const frameE = { processId: 16, routingId: 7 }

function setup(uuidOverride?: () => string) {
  const state = {
    identity: 'person@example.com' as string | null,
    gen: 1,
    rev: 10,
    salt: Buffer.alloc(32, 9) as Buffer | null
  }
  const wcByFrame = new Map<string, number>([
    ['12:3', 1],
    ['13:4', 2],
    ['14:5', 3],
    ['15:6', 4],
    ['16:7', 5],
    [`${Number.MAX_SAFE_INTEGER + 1}:3`, 9]
  ])
  let n = 0
  const authority = createOwnerSessionAuthority({
    identityId: () => state.identity,
    authGeneration: () => state.gen,
    currentContextRevision: () => state.rev,
    salt: () => state.salt,
    webContentsIdOf: (frame) => wcByFrame.get(`${frame.processId}:${frame.routingId}`) ?? null,
    now: () => 1_700_000_000_000,
    uuid: uuidOverride ?? (() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`)
  })
  return { state, authority }
}

function mustMint(authority: ReturnType<typeof setup>['authority'], frame = frameA, rev = 10): OwnerSessionRef {
  const ref = authority.mint(frame, rev)
  if (!ref) throw new Error('expected a ref')
  return ref
}

function expectRefused(action: () => unknown, forbidden: string[] = []): void {
  let error: unknown
  try {
    action()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toBe('owner-session-refused')
  for (const secret of forbidden) expect(message).not.toContain(secret)
}

describe('owner-session authority', () => {
  it('current returns the live ref for a frame without minting or revoking', () => {
    const { state, authority } = setup()
    const revoked = vi.fn()
    authority.onRevoked(revoked)
    expect(authority.current(frameA)).toBeNull()
    const ref = mustMint(authority)
    expect(authority.current(frameA)).toBe(ref)
    state.gen++
    expect(authority.current(frameA)).toBeNull()
    expect(authority.validate(ref, frameA)).toEqual({ ok: false, reason: 'stale-auth' })
    expect(revoked).not.toHaveBeenCalled()
  })

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

  it('retains superseded refs without notifying on refresh and revokes them before the current ref', () => {
    const { state, authority } = setup()
    const received: OwnerSessionRef[] = []
    authority.onRevoked((ref) => received.push(ref))

    const first = mustMint(authority, frameA, 10)
    state.rev = 11
    const second = mustMint(authority, frameA, 11)

    expect(second.sessionId).not.toBe(first.sessionId)
    expect(received).toEqual([])
    expect(authority.current(frameA)).toBe(second)
    expect(authority.validate(first, frameA)).not.toEqual({ ok: true })
    expect(authority.validate(second, frameA)).toEqual({ ok: true })

    authority.revokeAll('sign-out')

    expect(received).toHaveLength(2)
    expect(received[0]).toBe(first)
    expect(received[1]).toBe(second)
    expect(authority.current(frameA)).toBeNull()
    expect(authority.validate(first, frameA)).toEqual({ ok: false, reason: 'revoked' })
    expect(authority.validate(second, frameA)).toEqual({ ok: false, reason: 'revoked' })
  })

  it('revokes a frame lineage in order without revoking another frame lineage', () => {
    const { state, authority } = setup()
    const received: OwnerSessionRef[] = []
    authority.onRevoked((ref) => received.push(ref))

    const firstA = mustMint(authority, frameA, 10)
    state.rev = 11
    const firstB = mustMint(authority, frameB, 11)
    state.rev = 12
    const secondA = mustMint(authority, frameA, 12)
    state.rev = 13
    const secondB = mustMint(authority, frameB, 13)
    expect(received).toEqual([])

    authority.revokeFrame(1, 'renderer-reset')

    expect(received).toHaveLength(2)
    expect(received[0]).toBe(firstA)
    expect(received[1]).toBe(secondA)
    expect(authority.current(frameA)).toBeNull()
    expect(authority.validate(firstA, frameA)).toEqual({ ok: false, reason: 'revoked' })
    expect(authority.validate(secondA, frameA)).toEqual({ ok: false, reason: 'revoked' })
    expect(authority.current(frameB)).toBe(secondB)
    expect(authority.validate(firstB, frameB)).not.toEqual({ ok: true })
    expect(authority.validate(secondB, frameB)).toEqual({ ok: true })

    authority.revokeAll('sign-out')
    expect(received).toHaveLength(4)
    expect(received[2]).toBe(firstB)
    expect(received[3]).toBe(secondB)
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

  it('isolates throwing listeners while notifying every retained ref', () => {
    const { state, authority } = setup()
    const first = mustMint(authority, frameA, 10)
    state.rev = 11
    const second = mustMint(authority, frameA, 11)
    const received: OwnerSessionRef[] = []
    authority.onRevoked(() => {
      throw new Error('listener failure')
    })
    authority.onRevoked((ref) => received.push(ref))

    expect(() => authority.revokeAll('sign-out')).not.toThrow()
    expect(received).toHaveLength(2)
    expect(received[0]).toBe(first)
    expect(received[1]).toBe(second)
  })

  it('removes a revocation snapshot before callbacks so reentrant revocation is harmless', () => {
    const { state, authority } = setup()
    const first = mustMint(authority, frameA, 10)
    state.rev = 11
    const second = mustMint(authority, frameA, 11)
    state.rev = 12
    const received: OwnerSessionRef[] = []
    let reentered = false
    const createdRef: { current: OwnerSessionRef | null } = { current: null }
    authority.onRevoked((ref) => {
      received.push(ref)
      if (!reentered) {
        reentered = true
        authority.revokeAll('sign-out')
        createdRef.current = mustMint(authority, frameA, 12)
      }
    })

    authority.revokeAll('sign-out')

    expect(received).toHaveLength(2)
    expect(received[0]).toBe(first)
    expect(received[1]).toBe(second)
    const created = createdRef.current
    if (!created) throw new Error('expected reentrant mint to create a ref')
    expect(authority.current(frameA)).toBe(created)
    expect(authority.validate(created, frameA)).toEqual({ ok: true })

    authority.revokeAll('sign-out')
    expect(received).toHaveLength(3)
    expect(received[2]).toBe(created)
    expect(authority.current(frameA)).toBeNull()
  })

  it('mint returns the same ref for an unchanged frame', () => {
    const { authority } = setup()
    const received: OwnerSessionRef[] = []
    authority.onRevoked((ref) => received.push(ref))
    const first = mustMint(authority)
    const second = mustMint(authority)
    expect(second).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    authority.revokeAll('sign-out')
    expect(received).toHaveLength(1)
    expect(received[0]).toBe(first)
    authority.revokeAll('sign-out')
    expect(received).toHaveLength(1)
  })

  it('keeps the live ref when building a replacement ref fails schema validation', () => {
    const { state, authority } = setup()
    const received: OwnerSessionRef[] = []
    authority.onRevoked((ref) => received.push(ref))
    const first = mustMint(authority, frameA, 10)
    state.rev = 11
    const second = mustMint(authority, frameA, 11)

    expect(() => authority.mint(frameA, -1)).toThrow()

    expect(authority.current(frameA)).toBe(second)
    expect(authority.validate(second, frameA)).toEqual({ ok: true })
    expect(received).toEqual([])

    authority.revokeAll('sign-out')
    expect(received).toHaveLength(2)
    expect(received[0]).toBe(first)
    expect(received[1]).toBe(second)
  })

  it('refuses refresh at the per-frame cap without eviction and succeeds after revocation', () => {
    let nextId = 0
    const uuid = vi.fn(() => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`)
    const unsafeFrame = { processId: Number.MAX_SAFE_INTEGER + 1, routingId: 3 }
    const { state, authority } = setup(uuid)
    const received: OwnerSessionRef[] = []
    authority.onRevoked((ref) => received.push(ref))
    const lineage = [mustMint(authority, frameA, 10)]

    for (let revision = 11; revision <= 74; revision += 1) {
      state.rev = revision
      lineage.push(mustMint(authority, frameA, revision))
    }

    const current = lineage[lineage.length - 1]
    const uuidCallsAtCap = uuid.mock.calls.length
    expect(lineage).toHaveLength(65)
    expectRefused(() => authority.mint(frameA, 75), [current.sessionId, current.ownerKey, current.frameOwner])
    expect(uuid).toHaveBeenCalledTimes(uuidCallsAtCap)
    expect(authority.current(frameA)).toBe(current)
    expect(received).toEqual([])
    expect(authority.mint(frameA, 74)).toBe(current)
    const frameBFirst = mustMint(authority, frameB, 20)
    const frameBCurrent = mustMint(authority, frameB, 21)
    expect(authority.current(frameB)).toBe(frameBCurrent)
    expect(received).toEqual([])
    expect(authority.mint({ processId: 900, routingId: 9 }, 10)).toBeNull()
    expect(authority.mint(unsafeFrame, 10)).toBeNull()

    state.identity = null
    expect(authority.mint(frameA, 75)).toBeNull()
    expect(received).toEqual([])

    authority.revokeAll('sign-out')
    const expected = [...lineage.slice(0, -1), frameBFirst, current, frameBCurrent]
    expect(received).toHaveLength(expected.length)
    expected.forEach((ref, index) => expect(received[index]).toBe(ref))
    state.identity = 'person@example.com'
    expect(mustMint(authority, frameA, 75)).not.toBe(current)
  })

  it('refuses refresh at the global cap without evicting refs from any frame', () => {
    const { state, authority } = setup()
    const received: OwnerSessionRef[] = []
    authority.onRevoked((ref) => received.push(ref))
    const frames = [frameA, frameB, frameC, frameD]
    const retired: OwnerSessionRef[] = []
    const current: OwnerSessionRef[] = []

    frames.forEach((frame, frameIndex) => {
      let revision = 100 + frameIndex * 100
      let latest = mustMint(authority, frame, revision)
      for (let refresh = 0; refresh < 64; refresh += 1) {
        retired.push(latest)
        revision += 1
        state.rev = revision
        latest = mustMint(authority, frame, revision)
      }
      current.push(latest)
    })
    const fifth = mustMint(authority, frameE, 900)
    expect(retired).toHaveLength(256)
    const before = authority.current(frameE)

    expectRefused(() => authority.mint(frameE, 901), [fifth.sessionId, fifth.ownerKey, fifth.frameOwner])
    expect(authority.current(frameE)).toBe(before)
    expect(received).toEqual([])

    authority.revokeAll('sign-out')
    const expected = [...retired, ...current, fifth]
    expect(received).toHaveLength(expected.length)
    expected.forEach((ref, index) => expect(received[index]).toBe(ref))
  })

  it('refuses live, retained and revoked UUID collisions without changing authority state', () => {
    const id1 = '00000000-0000-4000-8000-000000000001'
    const id2 = '00000000-0000-4000-8000-000000000002'

    const liveIds = [id1, id1]
    const liveCase = setup(() => liveIds.shift() ?? id2)
    const liveRef = mustMint(liveCase.authority, frameA, 10)
    const liveReceived: OwnerSessionRef[] = []
    liveCase.authority.onRevoked((ref) => liveReceived.push(ref))
    expectRefused(() => liveCase.authority.mint(frameB, 10), [id1, liveRef.ownerKey, liveRef.frameOwner])
    expect(liveCase.authority.current(frameA)).toBe(liveRef)
    expect(liveCase.authority.current(frameB)).toBeNull()
    expect(liveReceived).toEqual([])

    const retainedIds = [id1, id2, id1]
    const retainedCase = setup(() => retainedIds.shift() ?? id2)
    const retainedReceived: OwnerSessionRef[] = []
    retainedCase.authority.onRevoked((ref) => retainedReceived.push(ref))
    const first = mustMint(retainedCase.authority, frameA, 10)
    const second = mustMint(retainedCase.authority, frameA, 11)
    expectRefused(() => retainedCase.authority.mint(frameA, 12), [id1, first.ownerKey, first.frameOwner])
    expect(retainedCase.authority.current(frameA)).toBe(second)
    expect(retainedReceived).toEqual([])
    retainedCase.authority.revokeAll('sign-out')
    expect(retainedReceived).toEqual([first, second])

    const revokedIds = [id1, id1]
    const revokedCase = setup(() => revokedIds.shift() ?? id2)
    const revokedReceived: OwnerSessionRef[] = []
    revokedCase.authority.onRevoked((ref) => revokedReceived.push(ref))
    const revoked = mustMint(revokedCase.authority, frameA, 10)
    revokedCase.authority.revokeAll('sign-out')
    expectRefused(() => revokedCase.authority.mint(frameA, 10), [id1, revoked.ownerKey, revoked.frameOwner])
    expect(revokedCase.authority.current(frameA)).toBeNull()
    expect(revokedCase.authority.validate(revoked, frameA)).toEqual({ ok: false, reason: 'revoked' })
    expect(revokedReceived).toEqual([revoked])
  })

  it('retains refs across auth and owner changes until explicit revocation', () => {
    const { state, authority } = setup()
    const received: OwnerSessionRef[] = []
    authority.onRevoked((ref) => received.push(ref))
    const first = mustMint(authority, frameA, 10)
    state.gen += 1
    const second = mustMint(authority, frameA, 10)
    state.identity = 'other@example.com'
    const third = mustMint(authority, frameA, 10)

    expect(received).toEqual([])
    expect(authority.current(frameA)).toBe(third)
    expect(authority.validate(first, frameA)).not.toEqual({ ok: true })
    expect(authority.validate(second, frameA)).not.toEqual({ ok: true })

    authority.revokeAll('auth-changed')

    expect(received).toHaveLength(3)
    expect(received[0]).toBe(first)
    expect(received[1]).toBe(second)
    expect(received[2]).toBe(third)
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
