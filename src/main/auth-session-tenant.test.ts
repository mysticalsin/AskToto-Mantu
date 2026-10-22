import { describe, expect, it, vi } from 'vitest'
import { createOwnerSessionAuthority } from './lifecycle/owner-session-authority'
import { bootMemoryPartitions } from './memory-partition/boot'
import { memoryAccess, resetMemoryAccessForTests } from './memory-partition/memory-access'
import { createSessionTenantResolver, tenantFromAccount } from './auth-session-tenant'
import type { AuthSession } from './auth-session-policy'

vi.mock('electron', () => ({ app: {}, safeStorage: {}, webContents: {} }))
vi.mock('./auth', () => ({ authStatus: vi.fn(), authSessionGeneration: vi.fn() }))

const TENANT = '00000000-0000-4000-8000-00000000c0de'
const OID = '11111111-1111-4111-8111-111111111111'
const cfg = { clientId: 'synthetic-client', tenantId: TENANT.toUpperCase(), allowedDomain: 'example.com' }

const restored = (patch: Partial<AuthSession> = {}): AuthSession => ({
  email: 'person@example.com',
  domain: 'example.com',
  tid: '',
  at: 1,
  ...patch
})

describe('tenantFromAccount', () => {
  it('reads the tenant from the id-token claim, the account tenant or homeAccountId (<oid>.<tid>)', () => {
    expect(
      tenantFromAccount({ homeAccountId: `${OID}.${TENANT}`, idTokenClaims: { tid: TENANT.toUpperCase() } }, TENANT)
    ).toBe(TENANT)
    expect(tenantFromAccount({ homeAccountId: `${OID}.x`, tenantId: TENANT }, TENANT)).toBe(TENANT)
    expect(tenantFromAccount({ homeAccountId: `${OID}.${TENANT}` }, TENANT)).toBe(TENANT)
  })

  it('refuses a tenant that is not the configured one, and anything that is not a GUID', () => {
    const other = '00000000-0000-4000-8000-0000000000ff'
    expect(tenantFromAccount({ homeAccountId: `${OID}.${other}` }, TENANT)).toBeNull()
    expect(tenantFromAccount({ homeAccountId: 'not-a-guid', tenantId: 'also-not' }, TENANT)).toBeNull()
    expect(tenantFromAccount({ homeAccountId: '' }, TENANT)).toBeNull()
  })
})

describe('session tenant resolver', () => {
  const setup = (
    session: AuthSession | null,
    accounts: Array<Record<string, unknown>>,
    config: typeof cfg | null = cfg
  ) => {
    const state = { session }
    const listAccounts = vi.fn(async () => accounts as never)
    const resolver = createSessionTenantResolver({
      session: () => state.session,
      config: () => config,
      accounts: listAccounts
    })
    return { state, resolver, listAccounts }
  }

  it('keeps the session’s own tenant and never asks MSAL for it', async () => {
    const t = setup(restored({ tid: TENANT.toUpperCase() }), [])
    await t.resolver.settle()
    expect(t.resolver.tenantId()).toBe(TENANT)
    expect(t.listAccounts).not.toHaveBeenCalled()
  })

  it('derives the tenant of a restored session without one from the cached MSAL account of the same user', async () => {
    const t = setup(restored(), [
      { username: 'someone.else@example.com', homeAccountId: `${OID}.00000000-0000-4000-8000-0000000000ff` },
      { username: 'Person@Example.com', homeAccountId: `${OID}.${TENANT}` }
    ])
    expect(t.resolver.tenantId()).toBeNull() // before it is settled nothing is assumed
    await t.resolver.settle()
    expect(t.resolver.tenantId()).toBe(TENANT)
    await t.resolver.settle()
    expect(t.listAccounts).toHaveBeenCalledTimes(1)
  })

  it('stays unknown when there is no cached account for the user, no configuration, or the cache fails', async () => {
    const none = setup(restored(), [{ username: 'someone.else@example.com', homeAccountId: `${OID}.${TENANT}` }])
    await none.resolver.settle()
    expect(none.resolver.tenantId()).toBeNull()
    const unconfigured = setup(
      restored(),
      [{ username: 'person@example.com', homeAccountId: `${OID}.${TENANT}` }],
      null
    )
    await unconfigured.resolver.settle()
    expect(unconfigured.resolver.tenantId()).toBeNull()
    const failing = setup(restored(), [])
    failing.listAccounts.mockRejectedValueOnce(new Error('cache unreadable'))
    await failing.resolver.settle()
    expect(failing.resolver.tenantId()).toBeNull()
  })

  it('a derived tenant belongs to the session it was derived for, never to the next one', async () => {
    const t = setup(restored(), [{ username: 'person@example.com', homeAccountId: `${OID}.${TENANT}` }])
    await t.resolver.settle()
    t.state.session = restored({ email: 'person@example.com' }) // a new session object, as a new sign-in makes
    expect(t.resolver.tenantId()).toBeNull()
  })
})

describe('an upgraded install whose stored session has no tenant id', () => {
  const SALT = Buffer.alloc(32, 7)
  const LEDGER = { text: null as string | null }

  it('opens the adopting owner’s partition from the cached MSAL account instead of going unavailable', async () => {
    resetMemoryAccessForTests()
    const session = restored()
    const resolver = createSessionTenantResolver({
      session: () => session,
      config: () => cfg,
      accounts: async () => [{ username: 'person@example.com', homeAccountId: `${OID}.${TENANT}` }] as never
    })
    const authority = createOwnerSessionAuthority({
      identityId: () => session.email,
      tenantId: () => resolver.tenantId(),
      authGeneration: () => 1,
      currentContextRevision: () => 1,
      salt: () => SALT,
      webContentsIdOf: () => null
    })
    const partitions = bootMemoryPartitions({
      ownerSession: authority,
      authGeneration: () => 1,
      signedIn: () => true,
      unsignedAllowed: () => false,
      settleIdentity: () => resolver.settle(),
      ledger: {
        read: async () => LEDGER.text,
        write: async (text) => {
          LEDGER.text = text
        }
      },
      legacyOwnerHint: async () => null,
      audit: () => undefined,
      onPartitionChange: () => undefined
    })
    expect(memoryAccess()).toEqual({ status: 'unavailable' }) // before the tenant is known: refused, not guessed
    const access = await partitions.activate()
    expect(access).toMatchObject({ status: 'ok', legacy: true, relRoot: '.brain' })
    expect(JSON.parse(LEDGER.text ?? '{}').legacy.ownerKey).toBe(authority.currentOwnerKey())
    resetMemoryAccessForTests()
  })

  it('falls back to unavailable when the account is not cached either', async () => {
    resetMemoryAccessForTests()
    const session = restored()
    const resolver = createSessionTenantResolver({
      session: () => session,
      config: () => cfg,
      accounts: async () => []
    })
    const authority = createOwnerSessionAuthority({
      identityId: () => session.email,
      tenantId: () => resolver.tenantId(),
      authGeneration: () => 1,
      currentContextRevision: () => 1,
      salt: () => SALT,
      webContentsIdOf: () => null
    })
    const partitions = bootMemoryPartitions({
      ownerSession: authority,
      authGeneration: () => 1,
      signedIn: () => true,
      unsignedAllowed: () => false,
      settleIdentity: () => resolver.settle(),
      ledger: { read: async () => null, write: async () => undefined },
      legacyOwnerHint: async () => null,
      audit: () => undefined,
      onPartitionChange: () => undefined
    })
    expect(await partitions.activate()).toEqual({ status: 'unavailable' })
    resetMemoryAccessForTests()
  })
})
