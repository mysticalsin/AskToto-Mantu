import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron')

const sink = vi.hoisted(() => ({ audits: [] as unknown[][] }))
vi.mock('./logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logger')>()
  return {
    ...actual,
    mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    auditLog: (...args: unknown[]): void => {
      sink.audits.push(args)
    }
  }
})

const OWNER_A = 'a'.repeat(64)
const OWNER_B = 'b'.repeat(64)

function deps(over: Partial<import('./credential-account-switch').AccountSwitchDeps> = {}): {
  deps: import('./credential-account-switch').AccountSwitchDeps
  order: string[]
  remembered: { value: string | null }
} {
  const order: string[] = []
  const remembered = { value: null as string | null }
  return {
    order,
    remembered,
    deps: {
      currentOwnerKey: () => OWNER_B,
      readRememberedOwner: async () => remembered.value,
      rememberOwner: async (key) => {
        order.push('remember')
        remembered.value = key
      },
      cleanup: async () => {
        order.push('cleanup')
        return { failed: 0 }
      },
      ...over
    }
  }
}

beforeEach(() => {
  sink.audits.length = 0
})

describe('G20: account-switch detection', () => {
  it('remembers the first owner and cleans nothing', async () => {
    const { reconcileSignedInOwner } = await import('./credential-account-switch')
    const t = deps()
    expect(await reconcileSignedInOwner(t.deps)).toBe('first-owner')
    expect(t.order).toEqual(['remember'])
    expect(t.remembered.value).toBe(OWNER_B)
  })

  it('does nothing when the same owner signs in again (session expiry must not cost the user their keys)', async () => {
    const { reconcileSignedInOwner } = await import('./credential-account-switch')
    const t = deps()
    t.remembered.value = OWNER_B
    expect(await reconcileSignedInOwner(t.deps)).toBe('same-owner')
    expect(t.order).toEqual([])
  })

  it('cleans up before it remembers a different owner', async () => {
    const { reconcileSignedInOwner } = await import('./credential-account-switch')
    const t = deps()
    t.remembered.value = OWNER_A
    expect(await reconcileSignedInOwner(t.deps)).toBe('switched')
    expect(t.order).toEqual(['cleanup', 'remember'])
    expect(t.remembered.value).toBe(OWNER_B)
    expect(sink.audits).toEqual([['credential.account_switch', { outcome: 'switched' }]])
  })

  it('keeps the previous owner on record when cleanup is incomplete, so the next sign-in retries it', async () => {
    const { reconcileSignedInOwner } = await import('./credential-account-switch')
    const t = deps({ cleanup: async () => ({ failed: 2 }) })
    t.remembered.value = OWNER_A
    expect(await reconcileSignedInOwner(t.deps)).toBe('switch-incomplete')
    expect(t.remembered.value).toBe(OWNER_A)
    expect(sink.audits).toEqual([['credential.account_switch', { outcome: 'switch-incomplete' }]])
  })

  it('never rejects: a throwing cleanup or store is an incomplete switch', async () => {
    const { reconcileSignedInOwner } = await import('./credential-account-switch')
    const a = deps({
      cleanup: async () => {
        throw new Error('synthetic-cleanup-failure')
      }
    })
    a.remembered.value = OWNER_A
    expect(await reconcileSignedInOwner(a.deps)).toBe('switch-incomplete')
    const b = deps({
      readRememberedOwner: async () => {
        throw new Error('synthetic-read-failure')
      }
    })
    expect(await reconcileSignedInOwner(b.deps)).toBe('owner-unknown')
    expect(JSON.stringify(sink.audits)).not.toContain('synthetic-')
  })

  it('does nothing while the owner key is not available yet (salt still loading)', async () => {
    const { reconcileSignedInOwner } = await import('./credential-account-switch')
    const t = deps({ currentOwnerKey: () => null })
    t.remembered.value = OWNER_A
    expect(await reconcileSignedInOwner(t.deps)).toBe('owner-unknown')
    expect(t.order).toEqual([])
    expect(t.remembered.value).toBe(OWNER_A)
  })
})

describe('G20: the remembered-owner record', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metis-owner-record-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips the owner key and stores nothing else (no identity, no email)', async () => {
    const { ownerRecordStore } = await import('./credential-account-switch')
    const store = ownerRecordStore(dir)
    expect(await store.read()).toBeNull()
    await store.write(OWNER_A)
    expect(await store.read()).toBe(OWNER_A)
    expect(readFileSync(join(dir, 'identity', 'last-owner-key.v1'), 'utf8').trim()).toBe(OWNER_A)
    await store.write(OWNER_B)
    expect(await store.read()).toBe(OWNER_B)
  })

  it('reads anything that is not a 64-hex owner key as no record', async () => {
    const { ownerRecordStore } = await import('./credential-account-switch')
    mkdirSync(join(dir, 'identity'), { recursive: true })
    writeFileSync(join(dir, 'identity', 'last-owner-key.v1'), 'someone@example.test')
    expect(await ownerRecordStore(dir).read()).toBeNull()
  })

  it('refuses to write a value that is not an owner key', async () => {
    const { ownerRecordStore } = await import('./credential-account-switch')
    await expect(ownerRecordStore(dir).write('someone@example.test')).rejects.toThrow()
  })
})

describe('G20: the lifecycle facade', () => {
  it('runs sign-out cleanup on every session end, never throws, and runs the afterSignIn step after the switch check', async () => {
    const { createCredentialLifecycle } = await import('./credential-lifecycle')
    const events: string[] = []
    const lifecycle = createCredentialLifecycle({
      generation: () => 1,
      cleanup: async (trigger) => {
        events.push(`cleanup:${trigger}`)
        return { failed: 0 }
      },
      reconcile: async () => {
        events.push('reconcile')
        return 'same-owner'
      }
    })
    lifecycle.onSessionCleared()
    await lifecycle.flush()
    await lifecycle.onSignedIn(() => events.push('after'))
    await lifecycle.onProfileReset()
    expect(events).toEqual(['cleanup:signOut', 'reconcile', 'after', 'cleanup:reset'])
  })

  it('a failing cleanup never blocks the sign-in continuation', async () => {
    const { createCredentialLifecycle } = await import('./credential-lifecycle')
    const after = vi.fn()
    const lifecycle = createCredentialLifecycle({
      generation: () => 1,
      cleanup: async () => {
        throw new Error('synthetic-boom')
      },
      reconcile: async () => {
        throw new Error('synthetic-boom')
      }
    })
    lifecycle.onSessionCleared()
    await expect(lifecycle.flush()).resolves.toBeUndefined()
    await lifecycle.onSignedIn(after)
    expect(after).toHaveBeenCalledTimes(1)
    await expect(lifecycle.onProfileReset()).resolves.toBeUndefined()
  })

  it('captures the auth session generation when the session ends, not when the cleanup runs', async () => {
    const { createCredentialLifecycle } = await import('./credential-lifecycle')
    let generation = 5
    const seen: Array<number | undefined> = []
    const lifecycle = createCredentialLifecycle({
      generation: () => generation,
      cleanup: async (_trigger, context) => {
        seen.push(context?.generation)
        return { failed: 0 }
      },
      reconcile: async () => 'same-owner'
    })
    lifecycle.onSessionCleared()
    generation = 6 // a sign-in lands before the queued cleanup runs
    await lifecycle.flush()
    expect(seen).toEqual([5])
  })
})
