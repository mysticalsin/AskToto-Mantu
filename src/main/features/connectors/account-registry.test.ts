import { describe, expect, it } from 'vitest'
import { createMemoryConnectorAccountStore } from './account-store'
import { createConnectorAccountRegistry } from './account-registry'

const OWNER_A = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) }
const OWNER_B = { ownerKey: 'c'.repeat(64), tenantKey: 'd'.repeat(64) }

function makeRegistry(scope: typeof OWNER_A, store = createMemoryConnectorAccountStore(), clock = { value: 100 }) {
  const registry = createConnectorAccountRegistry({
    currentScope: () => scope,
    store,
    now: () => clock.value,
    uuid: (() => {
      let next = 1
      return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
    })()
  })
  return { registry, clock, store }
}

describe('connector account registry', () => {
  it('keeps multiple account refs stable, scoped, and private in renderer-safe views', async () => {
    const store = createMemoryConnectorAccountStore()
    const { registry } = makeRegistry(OWNER_A, store)
    const personal = await registry.ensureAccount({
      kind: 'outlook',
      providerAccountId: 'alice.personal@example.test',
      label: 'Personal'
    })
    const work = await registry.ensureAccount({
      kind: 'outlook',
      providerAccountId: 'alice.work@example.test',
      label: 'Work'
    })
    expect(personal).not.toBe(work)
    expect(personal).not.toContain('alice.personal')
    expect(registry.resolve('outlook')).toBeNull()
    expect(registry.resolve('outlook', work)).toBe(work)

    await registry.observe('outlook', personal, 'token_refresh_succeeded')
    await registry.observe('outlook', work, 'token_refresh_succeeded')
    const views = await registry.listViews()
    expect(views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountRef: personal, kind: 'outlook', label: 'Personal', health: 'healthy' }),
        expect.objectContaining({ accountRef: work, kind: 'outlook', label: 'Work', health: 'healthy' })
      ])
    )
    expect(JSON.stringify(views)).not.toContain('alice.personal@example.test')
    expect(JSON.stringify(views)).not.toContain('ownerKey')
    expect(JSON.stringify(views)).not.toContain('tenantKey')

    const reloaded = makeRegistry(OWNER_A, store).registry
    expect(await reloaded.listViews()).toEqual(views)
  })

  it('gates by health: degraded accounts allow reads, while connecting, reauth, and disconnected do not', async () => {
    const { registry } = makeRegistry(OWNER_A)
    const account = await registry.ensureAccount({
      kind: 'outlook',
      providerAccountId: 'alice@example.test',
      label: 'Alice'
    })
    expect(registry.isReady('outlook', account, 'read')).toBe(false)
    await registry.observe('outlook', account, 'token_refresh_succeeded')
    await registry.observe('outlook', account, 'transient_failure')
    expect(registry.isReady('outlook', account, 'read')).toBe(true)
    expect(registry.isReady('outlook', account, 'create')).toBe(false)
    await registry.observe('outlook', account, 'consent_required')
    expect(registry.isReady('outlook', account, 'read')).toBe(false)
    await registry.observe('outlook', account, 'user_disconnected')
    expect(registry.resolve('outlook', account)).toBeNull()
  })

  it('pauses and resumes onboarding without treating registration as successful authentication', async () => {
    const { registry } = makeRegistry(OWNER_A)
    const flow = await registry.beginOnboarding({ kind: 'outlook', label: 'Work' })
    expect(flow.status).toBe('pending')
    await registry.pausePendingFlows('app_quit')
    expect(await registry.listOnboardingFlows()).toMatchObject([{ flowId: flow.flowId, status: 'paused' }])
    const resumed = await registry.resumeOnboarding(flow.flowId)
    expect(resumed).toMatchObject({ ok: true, flow: { status: 'pending' } })

    const completed = await registry.completeOnboarding(
      flow.flowId,
      { providerAccountId: 'alice@example.test' },
      'token_refresh_succeeded'
    )
    expect(completed).toMatchObject({ ok: true, account: { health: 'healthy' }, flow: { status: 'completed' } })
  })

  it('recovers a pending flow as paused when the registry starts after an interrupted app session', async () => {
    const store = createMemoryConnectorAccountStore()
    const interrupted = makeRegistry(OWNER_A, store).registry
    const flow = await interrupted.beginOnboarding({ kind: 'outlook', label: 'Work' })
    const restarted = makeRegistry(OWNER_A, store).registry
    await restarted.prepareCurrentScope()
    expect(await restarted.listOnboardingFlows()).toMatchObject([
      { flowId: flow.flowId, status: 'paused', reason: 'app_quit' }
    ])
  })

  it('abandons timed-out onboarding and leaves an unrelated working account untouched', async () => {
    const { registry, clock } = makeRegistry(OWNER_A)
    const existing = await registry.ensureAccount({
      kind: 'outlook',
      providerAccountId: 'alice.personal@example.test',
      label: 'Personal'
    })
    await registry.observe('outlook', existing, 'token_refresh_succeeded')
    const flow = await registry.beginOnboarding({ kind: 'outlook', label: 'New work account' })
    clock.value = flow.expiresAt
    expect(await registry.listOnboardingFlows()).toEqual([])
    expect(await registry.listFlowHistory()).toMatchObject([
      { flowId: flow.flowId, status: 'abandoned', reason: 'timeout' }
    ])
    expect((await registry.listViews()).find((view) => view.accountRef === existing)?.health).toBe('healthy')
  })

  it('keeps each owner and tenant partition isolated in the same store', async () => {
    const store = createMemoryConnectorAccountStore()
    const first = makeRegistry(OWNER_A, store).registry
    const second = makeRegistry(OWNER_B, store).registry
    const a = await first.ensureAccount({
      kind: 'outlook',
      providerAccountId: 'same@example.test',
      label: 'First'
    })
    const b = await second.ensureAccount({
      kind: 'outlook',
      providerAccountId: 'same@example.test',
      label: 'Second'
    })
    expect(a).not.toBe(b)
    expect(await first.listViews()).toHaveLength(1)
    expect(await second.listViews()).toHaveLength(1)
    expect((await second.listViews())[0]?.label).toBe('Second')
  })
})
