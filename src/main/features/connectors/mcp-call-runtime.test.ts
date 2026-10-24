import { describe, expect, it, vi } from 'vitest'
import { actionDigest, actionIdempotencyKey } from '../../action-guard'
import type { ConfirmOutcome, ConnectorConfirmRequest } from './connector-confirm-broker'
import {
  createMcpCallRuntime,
  registerMcpEffectClassifier,
  type McpTarget,
  type McpTransport
} from './mcp-call-runtime'

const PROPOSAL = 'd'.repeat(32)
const CLICKUP: McpTarget = { source: 'builtin', connectionKind: 'clickup', connectionId: 'clickup', label: 'ClickUp' }
const BIDSTACK: McpTarget = {
  source: 'builtin',
  connectionKind: 'bidstack',
  connectionId: 'bidstack',
  label: 'BidStack'
}
const OPERATOR: McpTarget = { source: 'operator', connectionKind: 'op-1', connectionId: 'op-1', label: 'Operator CRM' }
const CUSTOM: McpTarget = { source: 'custom', connectionKind: 'c-1', connectionId: 'c-1', label: 'Custom' }

const hashOf = (target: McpTarget, toolName: string, args: Record<string, unknown>) =>
  actionDigest({ kind: 'mcp-write', source: target.source, connectionId: target.connectionId, toolName, args })

function setup(answer: 'confirm' | 'decline' = 'confirm') {
  const cards: ConnectorConfirmRequest[] = []
  const audit = vi.fn()
  const runtime = createMcpCallRuntime({
    confirm: {
      issue: async (request): Promise<ConfirmOutcome> => {
        cards.push(request)
        return answer === 'confirm'
          ? { confirmed: true, approval: { proposalId: PROPOSAL, argsHash: request.argsHash } }
          : { confirmed: false, reason: 'cancelled' }
      }
    },
    catalogRevision: () => 3,
    audit
  })
  const transport = vi.fn<McpTransport>(async () => ({ ok: true, result: { id: 't1' } }))
  return { runtime, cards, audit, transport }
}

describe('mcp call runtime (G64)', () => {
  it('a write issues the card and calls the transport once with the idempotency key', async () => {
    const { runtime, cards, transport } = setup()
    const args = { title: 'Recap' }
    const r = await runtime.write({
      target: BIDSTACK,
      toolName: 'push_meeting_recap',
      args,
      ownerWebContentsId: 4,
      transport
    })
    expect(r).toMatchObject({ ok: true, effectClass: 'irreversible_write' })
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      effectClass: 'irreversible_write',
      argsHash: hashOf(BIDSTACK, 'push_meeting_recap', args)
    })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledWith(
      'push_meeting_recap',
      args,
      actionIdempotencyKey(PROPOSAL, hashOf(BIDSTACK, 'push_meeting_recap', args))
    )
  })

  it('a declined card runs nothing', async () => {
    const { runtime, transport } = setup('decline')
    const r = await runtime.write({
      target: BIDSTACK,
      toolName: 'push_note',
      args: {},
      ownerWebContentsId: 4,
      transport
    })
    expect(r).toMatchObject({ ok: false, refusal: 'confirm_declined' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('without a window nothing runs', async () => {
    const { runtime, transport } = setup()
    const r = await runtime.write({ target: BIDSTACK, toolName: 'push_note', args: {}, transport })
    expect(r).toMatchObject({ ok: false, refusal: 'no_window' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('the read path refuses a write-classified tool and runs a read tool without a card', async () => {
    const { runtime, cards, transport } = setup()
    const refused = await runtime.read({ target: CLICKUP, toolName: 'clickup_create_task', args: {}, transport })
    expect(refused).toMatchObject({ ok: false, refusal: 'read_path_refused_write' })
    expect(transport).not.toHaveBeenCalled()
    const ran = await runtime.read({ target: CLICKUP, toolName: 'clickup_get_list', args: { list_id: '1' }, transport })
    expect(ran.ok).toBe(true)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(cards).toHaveLength(0)
  })

  it('a custom source is refused mcp_source_unavailable until G63 registers a classifier', async () => {
    const { runtime, transport } = setup()
    const r = await runtime.write({ target: CUSTOM, toolName: 'anything', args: {}, ownerWebContentsId: 4, transport })
    expect(r).toMatchObject({ ok: false, refusal: 'mcp_source_unavailable' })
    expect(transport).not.toHaveBeenCalled()
    registerMcpEffectClassifier('custom', () => 'irreversible_write')
    try {
      const after = await runtime.write({
        target: CUSTOM,
        toolName: 'anything',
        args: {},
        ownerWebContentsId: 4,
        transport
      })
      expect(after.ok).toBe(true)
    } finally {
      registerMcpEffectClassifier('custom', null)
    }
  })

  it('an operator source goes through the card', async () => {
    const { runtime, cards, transport } = setup()
    await runtime.write({ target: OPERATOR, toolName: 'log_deal', args: {}, ownerWebContentsId: 4, transport })
    expect(cards).toHaveLength(1)
    expect(cards[0].connectorLabel).toBe('Operator CRM')
  })

  it('a write that names an unverified recipient is refused before any card', async () => {
    const { runtime, cards, transport } = setup()
    const r = await runtime.write({
      target: BIDSTACK,
      toolName: 'push_note',
      args: { to: ['eve@example.test'] },
      ownerWebContentsId: 4,
      transport
    })
    expect(r).toMatchObject({ ok: false, refusal: 'recipient_unverified' })
    expect(cards).toHaveLength(0)
    expect(transport).not.toHaveBeenCalled()
  })

  it('a send-like tool with no verified recipients never runs', async () => {
    const { runtime, transport } = setup()
    const r = await runtime.write({
      target: BIDSTACK,
      toolName: 'send_email',
      args: {},
      ownerWebContentsId: 4,
      transport
    })
    expect(r).toMatchObject({ ok: false, refusal: 'recipient_unverified', effectClass: 'send' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('a retry without a matching approval is refused, and an irreversible retry is never auto-run', async () => {
    const { runtime, cards, transport } = setup()
    const args = { name: 'Task', list_id: '1' }
    const none = await runtime.write({
      target: CLICKUP,
      toolName: 'clickup_create_task',
      args,
      transport,
      retryApproval: { proposalId: PROPOSAL, argsHash: 'f'.repeat(64) }
    })
    expect(none).toMatchObject({ ok: false, refusal: 'confirm_again' })
    const irreversible = await runtime.write({
      target: BIDSTACK,
      toolName: 'push_note',
      args,
      transport,
      retryApproval: { proposalId: PROPOSAL, argsHash: hashOf(BIDSTACK, 'push_note', args) }
    })
    expect(irreversible).toMatchObject({ ok: false, refusal: 'confirm_again' })
    expect(transport).not.toHaveBeenCalled()
    expect(cards).toHaveLength(0)
    const reversible = await runtime.write({
      target: CLICKUP,
      toolName: 'clickup_create_task',
      args,
      transport,
      retryApproval: { proposalId: PROPOSAL, argsHash: hashOf(CLICKUP, 'clickup_create_task', args) }
    })
    expect(reversible.ok).toBe(true)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('audit metadata carries no arguments, recipients or response content', async () => {
    const { runtime, audit, transport } = setup()
    await runtime.write({
      target: BIDSTACK,
      toolName: 'push_note',
      args: { title: 'Secret roadmap', body: 'private text' },
      ownerWebContentsId: 4,
      transport
    })
    await runtime.write({
      target: BIDSTACK,
      toolName: 'push_note',
      args: { to: 'eve@example.test' },
      ownerWebContentsId: 4,
      transport
    })
    const logged = JSON.stringify(audit.mock.calls)
    expect(logged).not.toMatch(/Secret|private text|example\.test/)
  })
})
