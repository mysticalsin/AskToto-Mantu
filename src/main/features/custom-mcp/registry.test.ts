import { describe, expect, it, vi } from 'vitest'
import { CUSTOM_MCP_ID } from '@shared/custom-mcp'
import { createCustomMcpRegistry, createMemoryCustomMcpStore, type NewRegistration } from './registry'

const key = (c: string) => c.repeat(64)
const scopeA = { ownerKey: key('a'), tenantKey: key('b') }
const scopeB = { ownerKey: key('c'), tenantKey: key('d') }

const draft = (over: Partial<NewRegistration> = {}): NewRegistration => ({
  label: 'Docs',
  transport: { kind: 'https', url: 'https://mcp.example.com/mcp' },
  auth: { type: 'bearer' },
  state: 'draft',
  health: 'unknown',
  tools: [],
  allowedTools: [],
  catalogRevision: 0,
  toolsFingerprint: '',
  policyDigest: '',
  ...over
})

function setup() {
  let scope: typeof scopeA | null = scopeA
  const clearSecret = vi.fn()
  const store = createMemoryCustomMcpStore()
  const registry = createCustomMcpRegistry({ currentScope: () => scope, store, clearSecret })
  return { registry, clearSecret, store, setScope: (s: typeof scope) => (scope = s) }
}

describe('custom MCP registry', () => {
  it('ids match the cmcp- regex and the mcpSecrets id rule', async () => {
    const { registry } = setup()
    const r = await registry.create(draft())
    if (!r.ok) throw new Error('create failed')
    expect(r.registration.id).toMatch(CUSTOM_MCP_ID)
    expect(r.registration.id).toMatch(/^[a-z0-9-]{1,40}$/i)
  })

  it('scopes are isolated and another scope id is not found', async () => {
    const { registry, setScope } = setup()
    const r = await registry.create(draft())
    if (!r.ok) throw new Error('create failed')
    setScope(scopeB)
    expect(await registry.list()).toEqual([])
    expect(await registry.get(r.registration.id)).toBeNull()
    expect(await registry.remove(r.registration.id)).toBe(false)
    expect(await registry.update(r.registration.id, (x) => x)).toBeNull()
    setScope(scopeA)
    expect(await registry.list()).toHaveLength(1)
  })

  it('without an owner scope nothing is created', async () => {
    const { registry, setScope } = setup()
    setScope(null)
    expect(await registry.create(draft())).toEqual({ ok: false, error: 'auth_required' })
    expect(await registry.list()).toEqual([])
  })

  it('max 8 per scope', async () => {
    const { registry } = setup()
    for (let i = 0; i < 8; i++) expect((await registry.create(draft())).ok).toBe(true)
    expect(await registry.create(draft())).toEqual({ ok: false, error: 'too_many_servers' })
  })

  it('remove clears the stored secret', async () => {
    const { registry, clearSecret } = setup()
    const r = await registry.create(draft())
    if (!r.ok) throw new Error('create failed')
    expect(await registry.remove(r.registration.id)).toBe(true)
    expect(clearSecret).toHaveBeenCalledWith(r.registration.id)
    expect(await registry.list()).toEqual([])
  })

  it('sign-out disables all registrations in that scope only', async () => {
    const { registry, setScope } = setup()
    const a = await registry.create(draft({ state: 'enabled' }))
    setScope(scopeB)
    const b = await registry.create(draft({ state: 'enabled' }))
    if (!a.ok || !b.ok) throw new Error('create failed')
    const changed = await registry.disableAll(scopeA)
    expect(changed).toEqual([a.registration.id])
    expect((await registry.get(b.registration.id))?.state).toBe('enabled')
    setScope(scopeA)
    expect((await registry.get(a.registration.id))?.state).toBe('disabled')
  })

  it('a corrupt entry in the file is dropped, not trusted', async () => {
    const { registry, store } = setup()
    const r = await registry.create(draft())
    if (!r.ok) throw new Error('create failed')
    const k = registry.scopeKey() as string
    const saved = (await store.load(k)) as { registrations: unknown[] }
    await store.save(k, { registrations: [...saved.registrations, { id: '../../x', state: 'enabled' }] })
    expect(await registry.list()).toHaveLength(1)
  })
})
