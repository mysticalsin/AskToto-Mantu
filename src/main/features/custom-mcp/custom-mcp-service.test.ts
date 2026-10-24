import { describe, expect, it } from 'vitest'
import type { CustomMcpDraftPayload, CustomMcpView } from '@shared/custom-mcp'
import { AddressRefusedError } from '../../mcp/mcpClient'
import { createCustomMcpService, type CustomMcpWire, type WireTarget } from './custom-mcp-service'
import { readCustomMcpPolicy } from './policy'
import { createCustomMcpRegistry, createMemoryCustomMcpStore } from './registry'

const key = (c: string) => c.repeat(64)
const scope = { ownerKey: key('a'), tenantKey: key('b') }

const readTool = {
  name: 'search_docs',
  description: 'Search the docs',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
}
const writeTool = {
  name: 'create_note',
  description: 'Create a note',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
}

function setup(opts: { tools?: unknown[]; policyJson?: string } = {}) {
  let tools: unknown[] = opts.tools ?? [readTool, writeTool]
  let adminJson: string | null = opts.policyJson ?? null
  let clock = 1_000_000
  const targets: WireTarget[] = []
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let callResult: { isError?: boolean; content?: unknown } = { content: [{ type: 'text', text: 'done' }] }
  let listError: unknown = null
  let callError: unknown = null
  const wire: CustomMcpWire = {
    async listTools(target) {
      targets.push(target)
      if (listError) throw listError
      return tools
    },
    async callTool(_target, name, args) {
      calls.push({ name, args })
      if (callError) throw callError
      return callResult
    }
  }
  const secrets = new Map<string, string>()
  const registry = createCustomMcpRegistry({
    currentScope: () => scope,
    store: createMemoryCustomMcpStore(),
    clearSecret: (id) => void secrets.delete(id),
    now: () => clock
  })
  const service = createCustomMcpService({
    registry,
    policy: () => readCustomMcpPolicy(adminJson, null),
    secrets: {
      set: (id, v) => void secrets.set(id, v),
      get: (id) => secrets.get(id) ?? '',
      has: (id) => secrets.has(id)
    },
    wire,
    scope: () => scope,
    now: () => clock
  })
  const payload = (over: Partial<CustomMcpDraftPayload> = {}): CustomMcpDraftPayload => ({
    label: 'Docs',
    transport: { kind: 'https', url: 'https://mcp.example.com/mcp' },
    auth: { type: 'bearer' },
    secret: 'sekret-token',
    ...over
  })
  const onboard = async (allowed = ['search_docs', 'create_note']): Promise<CustomMcpView> => {
    const d = await service.draft(payload())
    if (!d.ok) throw new Error(`draft refused ${d.error}`)
    const c = await service.confirm({
      id: d.server.id,
      reviewTokenId: d.server.reviewTokenId as string,
      allowedTools: allowed
    })
    if (!c.ok) throw new Error(`confirm refused ${c.error}`)
    return c.server
  }
  return {
    service,
    registry,
    secrets,
    targets,
    calls,
    payload,
    onboard,
    setTools: (t: unknown[]) => (tools = t),
    setAdmin: (j: string | null) => (adminJson = j),
    setCallResult: (r: typeof callResult) => (callResult = r),
    setListError: (e: unknown) => (listError = e),
    setCallError: (e: unknown) => (callError = e),
    advance: (ms: number) => (clock += ms)
  }
}

describe('custom MCP service', () => {
  it('stdio draft refused without admin allow, naming the rule', async () => {
    const { service } = setup()
    const r = await service.draft({
      label: 'Local',
      transport: { kind: 'stdio', executable: '/usr/bin/true', args: [], env: {} },
      auth: { type: 'none' }
    })
    expect(r).toEqual({ ok: false, error: 'policy_blocked', rule: 'customMcp.allowStdio' })
  })

  it('stdio stays refused in this build even when the admin policy allows it (host not shipped yet)', async () => {
    const admin = JSON.stringify({
      customMcp: { allowStdio: true, stdioExecutables: [{ path: '/usr/bin/true', sha256: 'a'.repeat(64) }] }
    })
    const { service } = setup({ policyJson: admin })
    const r = await service.draft({
      label: 'Local',
      transport: { kind: 'stdio', executable: '/usr/bin/true', args: [], env: {} },
      auth: { type: 'none' }
    })
    expect(r.ok).toBe(false)
  })

  it('refuses private, http and credentialed endpoints naming the rule, without a probe', async () => {
    const { service, targets, payload } = setup()
    for (const [url, rule] of [
      ['http://mcp.example.com/mcp', 'customMcp.https'],
      ['https://10.0.0.4/mcp', 'customMcp.allowPrivateNetwork'],
      ['https://u:p@mcp.example.com/mcp', 'customMcp.credentials']
    ] as const) {
      expect(await service.draft(payload({ transport: { kind: 'https', url } }))).toEqual({
        ok: false,
        error: 'endpoint_refused',
        rule
      })
    }
    expect(targets).toHaveLength(0)
  })

  it('a probe validates tools, sends the secret only as the configured header and lands in review', async () => {
    const { service, targets, payload, secrets } = setup()
    const r = await service.draft(payload())
    if (!r.ok) throw new Error('refused')
    expect(r.server).toMatchObject({ state: 'review', transport: 'https', target: 'mcp.example.com', hasSecret: true })
    expect(r.server.tools.map((t) => [t.name, t.effect, t.allowed])).toEqual([
      ['search_docs', 'read', false],
      ['create_note', 'create', false]
    ])
    expect(targets[0].headers).toEqual({ Authorization: 'Bearer sekret-token' })
    expect(JSON.stringify(r)).not.toContain('sekret-token')
    expect(secrets.size).toBe(1)
    const header = await service.draft(payload({ auth: { type: 'header', headerName: 'X-Api-Key' } }))
    expect(header.ok).toBe(true)
    expect(targets[1].headers).toEqual({ 'X-Api-Key': 'sekret-token' })
  })

  it('bearer/header auth without a secret is invalid input', async () => {
    const { service, payload } = setup()
    expect(await service.draft(payload({ secret: undefined }))).toEqual({ ok: false, error: 'invalid_input' })
  })

  it('probe failure and schema failure leave a draft with a named code, nothing callable', async () => {
    const t = setup()
    t.setListError(new Error('boom with https://secret.example/path'))
    const failed = await t.service.draft(t.payload())
    expect(failed).toEqual({ ok: false, error: 'probe_failed' })
    t.setListError(null)
    t.setTools([{ name: 'bad name', inputSchema: { type: 'object' } }])
    expect(await t.service.draft(t.payload())).toEqual({
      ok: false,
      error: 'schema_invalid',
      rule: 'customMcp.toolName'
    })
    const list = await t.service.list()
    if (!list.ok) throw new Error('list refused')
    expect(list.servers.every((s) => s.state === 'draft')).toBe(true)
    t.setListError(new AddressRefusedError('x'))
    expect(await t.service.draft(t.payload())).toMatchObject({ ok: false, error: 'endpoint_refused' })
  })

  it('enable requires a valid unexpired review token bound to the digest', async () => {
    const t = setup()
    const d = await t.service.draft(t.payload())
    if (!d.ok) throw new Error('refused')
    const id = d.server.id
    const token = d.server.reviewTokenId as string
    expect(await t.service.confirm({ id, reviewTokenId: 'f'.repeat(32), allowedTools: ['search_docs'] })).toEqual({
      ok: false,
      error: 'review_required'
    })
    expect(await t.service.confirm({ id, reviewTokenId: token, allowedTools: [] })).toEqual({
      ok: false,
      error: 'invalid_input'
    })
    expect(await t.service.confirm({ id, reviewTokenId: token, allowedTools: ['not_declared'] })).toEqual({
      ok: false,
      error: 'tool_not_allowed'
    })
    t.advance(11 * 60_000)
    expect(await t.service.confirm({ id, reviewTokenId: token, allowedTools: ['search_docs'] })).toEqual({
      ok: false,
      error: 'review_expired'
    })
  })

  it('token replay is refused after a successful confirm', async () => {
    const t = setup()
    const d = await t.service.draft(t.payload())
    if (!d.ok) throw new Error('refused')
    const input = { id: d.server.id, reviewTokenId: d.server.reviewTokenId as string, allowedTools: ['search_docs'] }
    expect((await t.service.confirm(input)).ok).toBe(true)
    expect(await t.service.confirm(input)).toEqual({ ok: false, error: 'review_required' })
  })

  it('a token minted under one policy cannot confirm after the policy changed', async () => {
    const t = setup()
    const d = await t.service.draft(t.payload())
    if (!d.ok) throw new Error('refused')
    t.setAdmin(JSON.stringify({ customMcp: { maxTools: 1 } }))
    const r = await t.service.confirm({
      id: d.server.id,
      reviewTokenId: d.server.reviewTokenId as string,
      allowedTools: ['search_docs']
    })
    expect(r).toEqual({ ok: false, error: 'policy_blocked', rule: 'customMcp.maxTools' })
  })

  it('reads run through the executor without a card; the declared read-only hint decides, not the description', async () => {
    const t = setup()
    const s = await t.onboard()
    const r = await t.service.proposeCall({ id: s.id, tool: 'search_docs', args: { q: 'hello' } })
    expect(r).toMatchObject({ ok: true, effect: 'read', output: { content: [{ type: 'text', text: 'done' }] } })
    expect(t.calls).toEqual([{ name: 'search_docs', args: { q: 'hello' } }])
  })

  it('write call without confirm → not_approved, and the server is never called', async () => {
    const t = setup()
    const s = await t.onboard()
    const proposal = await t.service.proposeCall({ id: s.id, tool: 'create_note', args: { text: 'hi' } })
    expect(proposal).toMatchObject({ ok: true, effect: 'create' })
    expect(t.calls).toHaveLength(0)
    expect(await t.service.confirmCall({ proposalId: 'e'.repeat(32) })).toEqual({ ok: false, error: 'not_approved' })
    expect(t.calls).toHaveLength(0)
  })

  it('confirmed write returns a bound receipt, runs once, and cannot be replayed', async () => {
    const t = setup()
    const s = await t.onboard()
    const proposal = await t.service.proposeCall({ id: s.id, tool: 'create_note', args: { text: 'hi' } })
    if (!proposal.ok || !('proposalId' in proposal)) throw new Error('no proposal')
    const done = await t.service.confirmCall({ proposalId: proposal.proposalId })
    expect(done).toMatchObject({ ok: true, effect: 'create' })
    expect((done as { observation: string }).observation).toContain(`cmcp.${s.id}.create_note`)
    expect(t.calls).toEqual([{ name: 'create_note', args: { text: 'hi' } }])
    expect(await t.service.confirmCall({ proposalId: proposal.proposalId })).toEqual({
      ok: false,
      error: 'not_approved'
    })
    expect(t.calls).toHaveLength(1)
  })

  it('an expired write proposal is refused', async () => {
    const t = setup()
    const s = await t.onboard()
    const proposal = await t.service.proposeCall({ id: s.id, tool: 'create_note', args: { text: 'hi' } })
    if (!proposal.ok || !('proposalId' in proposal)) throw new Error('no proposal')
    t.advance(60_000)
    expect(await t.service.confirmCall({ proposalId: proposal.proposalId })).toEqual({
      ok: false,
      error: 'not_approved'
    })
  })

  it('invalid args never reach the server', async () => {
    const t = setup()
    const s = await t.onboard()
    expect(await t.service.proposeCall({ id: s.id, tool: 'search_docs', args: {} })).toEqual({
      ok: false,
      error: 'invalid_input'
    })
    expect(await t.service.proposeCall({ id: s.id, tool: 'create_note', args: { text: { nested: 1 } } })).toEqual({
      ok: false,
      error: 'invalid_input'
    })
    expect(t.calls).toHaveLength(0)
  })

  it('a tool the owner did not allow is refused', async () => {
    const t = setup()
    const s = await t.onboard(['search_docs'])
    expect(await t.service.proposeCall({ id: s.id, tool: 'create_note', args: { text: 'x' } })).toEqual({
      ok: false,
      error: 'tool_not_allowed'
    })
    expect(await t.service.proposeCall({ id: s.id, tool: 'undeclared', args: {} })).toEqual({
      ok: false,
      error: 'tool_not_allowed'
    })
  })

  it('refresh with changed tools → stale_catalog, nothing callable, pending proposal fails catalog_changed', async () => {
    const t = setup()
    const s = await t.onboard()
    const proposal = await t.service.proposeCall({ id: s.id, tool: 'create_note', args: { text: 'hi' } })
    if (!proposal.ok || !('proposalId' in proposal)) throw new Error('no proposal')
    t.setTools([readTool, { ...writeTool, description: 'Create a note and also email it' }])
    const refreshed = await t.service.refresh(s.id)
    if (!refreshed.ok) throw new Error('refresh refused')
    expect(refreshed.server.state).toBe('stale_catalog')
    expect(refreshed.server.tools.every((x) => !x.allowed)).toBe(true)
    expect(await t.service.confirmCall({ proposalId: proposal.proposalId })).toEqual({
      ok: false,
      error: 'not_approved'
    })
    expect(await t.service.proposeCall({ id: s.id, tool: 'search_docs', args: { q: 'x' } })).toEqual({
      ok: false,
      error: 'review_required'
    })
    expect(t.calls).toHaveLength(0)
    // re-review enables again
    const again = await t.service.confirm({
      id: s.id,
      reviewTokenId: refreshed.server.reviewTokenId as string,
      allowedTools: ['search_docs']
    })
    expect(again.ok).toBe(true)
  })

  it('refresh with an unchanged catalog keeps the registration enabled and healthy', async () => {
    const t = setup()
    const s = await t.onboard()
    const r = await t.service.refresh(s.id)
    expect(r).toMatchObject({ ok: true, server: { state: 'enabled', health: 'healthy' } })
  })

  it('policy change after enable → policy_blocked and calls refuse naming the rule', async () => {
    const t = setup()
    const s = await t.onboard()
    t.setAdmin(JSON.stringify({ customMcp: { allow: false } }))
    const list = await t.service.list()
    expect(list).toMatchObject({ ok: true, servers: [{ state: 'policy_blocked', rule: 'customMcp.allow' }] })
    expect(await t.service.proposeCall({ id: s.id, tool: 'search_docs', args: { q: 'x' } })).toEqual({
      ok: false,
      error: 'policy_blocked',
      rule: 'customMcp.allow'
    })
    expect(t.calls).toHaveLength(0)
  })

  it('a grant-only policy change (digest) sends an enabled server back to stale_catalog', async () => {
    const t = setup()
    await t.onboard()
    t.setAdmin(JSON.stringify({ customMcp: { allowedHosts: ['mcp.example.com'] } }))
    const list = await t.service.list()
    expect(list).toMatchObject({ ok: true, servers: [{ state: 'stale_catalog' }] })
  })

  it('output over cap → call_failed (output_invalid), server errors are not forwarded', async () => {
    const t = setup()
    const s = await t.onboard()
    t.setCallResult({ content: [{ type: 'text', text: 'x'.repeat(64 * 1024 + 1) }] })
    expect(await t.service.proposeCall({ id: s.id, tool: 'search_docs', args: { q: 'x' } })).toEqual({
      ok: false,
      error: 'call_failed'
    })
    t.setCallResult({ isError: true, content: [{ type: 'text', text: 'leaky server detail' }] })
    const r = await t.service.proposeCall({ id: s.id, tool: 'search_docs', args: { q: 'x' } })
    expect(r).toEqual({ ok: false, error: 'call_failed' })
  })

  it('non-text output parts are dropped', async () => {
    const t = setup()
    const s = await t.onboard()
    t.setCallResult({
      content: [
        { type: 'image', data: 'AAAA' },
        { type: 'text', text: 'ok' }
      ]
    })
    const r = await t.service.proposeCall({ id: s.id, tool: 'search_docs', args: { q: 'x' } })
    expect(r).toMatchObject({ ok: true, output: { content: [{ type: 'text', text: 'ok' }] } })
  })

  it('disable stops calls; remove clears the secret; sign-out disables', async () => {
    const t = setup()
    const s = await t.onboard()
    expect(t.secrets.size).toBe(1)
    await t.service.onRevoked(scope)
    expect(await t.service.proposeCall({ id: s.id, tool: 'search_docs', args: { q: 'x' } })).toEqual({
      ok: false,
      error: 'review_required'
    })
    expect(await t.service.remove(s.id)).toEqual({ ok: true })
    expect(t.secrets.size).toBe(0)
    expect(await t.service.remove(s.id)).toEqual({ ok: false, error: 'not_found' })
  })

  it('repeated transient failures mark the server failing and stop calls', async () => {
    const t = setup()
    const s = await t.onboard()
    t.setCallError(new Error('network down'))
    for (let i = 0; i < 3; i++) {
      expect(await t.service.proposeCall({ id: s.id, tool: 'search_docs', args: { q: 'x' } })).toEqual({
        ok: false,
        error: 'call_failed'
      })
    }
    expect(await t.service.list()).toMatchObject({ ok: true, servers: [{ health: 'failing' }] })
    expect(await t.service.proposeCall({ id: s.id, tool: 'search_docs', args: { q: 'x' } })).toEqual({
      ok: false,
      error: 'review_required'
    })
    expect(t.calls).toHaveLength(3)
  })
})
