import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DUST_EMPTY_AGENTS_ERROR,
  DUST_UNAUTHORIZED_ERROR,
  DUST_WORKSPACE_MISSING_SETUP_ERROR,
  decideDustInstantValidate,
  formatDustConnectedMessage,
  proveDustConnection
} from './dust-validate'

const metis = { sId: 'metis-base', name: 'Métis' }
const thinker = { sId: 'think-1', name: 'Thinker' }

describe('decideDustInstantValidate', () => {
  it('fails loud when the workspace is missing — no green Connected', () => {
    expect(decideDustInstantValidate({ workspaceId: '', test: { ok: true }, list: { ok: true, agents: [metis] } })).toEqual({
      ok: false,
      reason: 'workspace-missing',
      message: DUST_WORKSPACE_MISSING_SETUP_ERROR
    })
    expect(decideDustInstantValidate({ test: { ok: true }, list: { ok: true, agents: [metis] } }).ok).toBe(false)
  })

  it('the live credentials banner is unauthorized, never Connected', () => {
    const result = decideDustInstantValidate({
      workspaceId: 'ws-1',
      test: { ok: false, error: 'The request does not have valid authentication credentials.' },
      list: { ok: false, error: 'The request does not have valid authentication credentials.' }
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toBe('unauthorized')
    expect(result.message).not.toMatch(/^Connected/)
  })

  it('connect with a bad key fails (401) and is not ok', () => {
    const result = decideDustInstantValidate({
      workspaceId: 'ws-1',
      test: { ok: false, error: '401 Unauthorized — invalid API key' },
      list: { ok: false, error: '401 Unauthorized — invalid API key' }
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toBe('unauthorized')
    expect(result.message).toMatch(/401/)
  })

  it('connect with a good mock returns agents and names the selected one', () => {
    const result = decideDustInstantValidate(
      {
        workspaceId: 'ws-1',
        test: { ok: true },
        list: { ok: true, agents: [metis, thinker] }
      },
      'metis-base'
    )
    expect(result).toEqual({
      ok: true,
      agentCount: 2,
      selectedName: 'Métis',
      message: 'Connected. Workspace ws-1. 2 agents. Base: Métis.'
    })
  })

  it('empty list is not ok — even when the credential ping claimed success', () => {
    const result = decideDustInstantValidate({
      workspaceId: 'ws-1',
      test: { ok: true },
      list: { ok: true, agents: [] }
    })
    expect(result).toEqual({
      ok: false,
      reason: 'empty-agents',
      message: DUST_EMPTY_AGENTS_ERROR
    })
  })

  it('a restricted list that arrives as ok:false with the empty-agents sentence is still empty-agents', () => {
    const result = decideDustInstantValidate({
      workspaceId: 'ws-1',
      test: { ok: false, error: DUST_EMPTY_AGENTS_ERROR },
      list: { ok: false, error: DUST_EMPTY_AGENTS_ERROR }
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toBe('empty-agents')
  })

  it('a dead session fails loud instead of Connected', () => {
    const result = decideDustInstantValidate({
      workspaceId: 'ws-1',
      test: { ok: false, error: 'Your Dust CLI session ended. Run dust login again.' },
      list: { ok: false, error: 'Your Dust CLI session ended. Run dust login again.' }
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toBe('session-dead')
  })

  it('does not treat a credential ping alone as success — list is required', () => {
    const result = decideDustInstantValidate({
      workspaceId: 'ws-1',
      test: { ok: true },
      list: null
    })
    expect(result.ok).toBe(false)
  })
})

describe('formatDustConnectedMessage', () => {
  it('shows the agent count and selected agent, never "Loading agents…"', () => {
    expect(formatDustConnectedMessage({ agentCount: 1, selectedName: 'Métis', workspaceId: 'abc' })).toBe(
      'Connected. Workspace abc. 1 agent. Base: Métis.'
    )
    expect(formatDustConnectedMessage({ agentCount: 3 })).toBe('Connected. 3 agents.')
    expect(formatDustConnectedMessage({ agentCount: 2, selectedId: 'raw-sid' })).toBe('Connected. 2 agents. Base: raw-sid.')
  })
})

describe('proveDustConnection', () => {
  it('does not ping Dust when the workspace is missing', async () => {
    const testApiKey = vi.fn(async () => ({ ok: true }))
    const listAgents = vi.fn(async () => ({ ok: true, agents: [metis] }))
    const result = await proveDustConnection({
      workspaceId: '  ',
      testApiKey,
      listAgents
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toBe('workspace-missing')
    expect(testApiKey).not.toHaveBeenCalled()
    expect(listAgents).not.toHaveBeenCalled()
  })

  it('live-pings testApiKey and listAgents and succeeds only when agents load', async () => {
    const result = await proveDustConnection({
      workspaceId: 'ws-1',
      selectedAgentId: 'metis-base',
      testApiKey: async () => ({ ok: true }),
      listAgents: async () => ({ ok: true, agents: [metis] })
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.agentCount).toBe(1)
    expect(result.message).toContain('1 agent')
    expect(result.message).toContain('Métis')
    expect(result.message).not.toMatch(/Loading agents/)
  })

  it('connect with a bad key fails in the prove helper (UI uses this verdict)', async () => {
    const result = await proveDustConnection({
      workspaceId: 'ws-1',
      testApiKey: async () => ({ ok: false, error: '401 Unauthorized' }),
      listAgents: async () => ({ ok: false, error: '401 Unauthorized' })
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toBe('unauthorized')
    expect(result.message).not.toMatch(/Connected/)
  })

  it('empty list from the live list is not a fake success', async () => {
    const result = await proveDustConnection({
      workspaceId: 'ws-1',
      testApiKey: async () => ({ ok: true }),
      listAgents: async () => ({ ok: true, agents: [] })
    })
    expect(result).toEqual({
      ok: false,
      reason: 'empty-agents',
      message: DUST_EMPTY_AGENTS_ERROR
    })
  })

  it('never auto-sends — deps are only the key ping and the agent list', async () => {
    // Guard against a future "prove it with a real conversation" shortcut that would fire an ask.
    const src = readFileSync(join(__dirname, 'dust-validate.ts'), 'utf8')
    expect(src).not.toMatch(/createConversation|postUserMessage|streamAgent|sendMessage/)
    expect(src).toMatch(/Never auto-sends/)
    expect(DUST_UNAUTHORIZED_ERROR).toMatch(/401/)
  })
})
