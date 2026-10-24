import { describe, expect, it, vi } from 'vitest'
import type { ConnectorConfirmCard, ConnectorConfirmState } from '@shared/connector-confirm'
import { createConnectorConfirmBroker, type ConnectorConfirmRequest } from './connector-confirm-broker'

const ARGS = 'a'.repeat(64)
const request = (over: Partial<ConnectorConfirmRequest> = {}): ConnectorConfirmRequest => ({
  ownerWebContentsId: 7,
  opId: 'outlook.draft.create',
  revision: 3,
  argsHash: ARGS,
  effectClass: 'reversible_write',
  summary: 'Create a mail draft (never sent)',
  connectorLabel: 'Outlook',
  ...over
})

function harness(over: { revision?: () => number } = {}) {
  let clock = 1_000
  const sent: ConnectorConfirmState[] = []
  let expire: (() => void) | undefined
  const broker = createConnectorConfirmBroker({
    send: (_id, state) => sent.push(state),
    catalogRevision: over.revision ?? (() => 3),
    now: () => clock,
    ttlMs: 30_000,
    minDecideDelayMs: 300,
    schedule: (run) => {
      expire = run
      return () => {
        expire = undefined
      }
    }
  })
  const card = (): ConnectorConfirmCard => sent.find((s) => s.proposalId !== null) as ConnectorConfirmCard
  return {
    broker,
    sent,
    card,
    advance: (ms: number) => (clock += ms),
    fireDeadline: () => expire?.()
  }
}

describe('connector confirm broker', () => {
  it("resolves confirmed with the card's own proposalId", async () => {
    const h = harness()
    const outcome = h.broker.issue(request())
    h.advance(400)
    const c = h.card()
    expect(
      h.broker.decide({
        proposalId: c.proposalId,
        nonce: c.nonce,
        argsHash: c.argsHash,
        confirm: true,
        webContentsId: 7
      })
    ).toEqual({ ok: true })
    await expect(outcome).resolves.toEqual({ confirmed: true, approval: { proposalId: c.proposalId, argsHash: ARGS } })
  })

  it('rejects decide before 300 ms and keeps the card pending', async () => {
    const h = harness()
    const outcome = h.broker.issue(request())
    const c = h.card()
    const early = h.broker.decide({
      proposalId: c.proposalId,
      nonce: c.nonce,
      argsHash: c.argsHash,
      confirm: true,
      webContentsId: 7
    })
    expect(early).toEqual({ ok: false, reason: 'too_soon' })
    h.advance(400)
    h.broker.decide({ proposalId: c.proposalId, nonce: c.nonce, argsHash: c.argsHash, confirm: true, webContentsId: 7 })
    await expect(outcome).resolves.toMatchObject({ confirmed: true })
  })

  it('rejects a wrong nonce, argsHash or webContents', () => {
    const h = harness()
    void h.broker.issue(request())
    h.advance(400)
    const c = h.card()
    const base = { proposalId: c.proposalId, nonce: c.nonce, argsHash: c.argsHash, confirm: true, webContentsId: 7 }
    expect(h.broker.decide({ ...base, nonce: 'b'.repeat(64) })).toEqual({ ok: false, reason: 'nonce_mismatch' })
    expect(h.broker.decide({ ...base, argsHash: 'c'.repeat(64) })).toEqual({ ok: false, reason: 'args_mismatch' })
    expect(h.broker.decide({ ...base, webContentsId: 8 })).toEqual({ ok: false, reason: 'owner_mismatch' })
  })

  it('expires at ttl and resolves expired', async () => {
    const h = harness()
    const outcome = h.broker.issue(request())
    h.advance(30_000)
    h.fireDeadline()
    await expect(outcome).resolves.toEqual({ confirmed: false, reason: 'expired' })
    expect(h.sent.at(-1)).toEqual({ proposalId: null })
  })

  it('a second decide is already_decided and cannot approve twice', async () => {
    const h = harness()
    const outcome = h.broker.issue(request())
    h.advance(400)
    const c = h.card()
    const d = { proposalId: c.proposalId, nonce: c.nonce, argsHash: c.argsHash, confirm: true, webContentsId: 7 }
    expect(h.broker.decide(d)).toEqual({ ok: true })
    expect(h.broker.decide(d)).toEqual({ ok: false, reason: 'already_decided' })
    await outcome
  })

  it('a declined card resolves cancelled', async () => {
    const h = harness()
    const outcome = h.broker.issue(request())
    const c = h.card()
    h.broker.decide({
      proposalId: c.proposalId,
      nonce: c.nonce,
      argsHash: c.argsHash,
      confirm: false,
      webContentsId: 7
    })
    await expect(outcome).resolves.toEqual({ confirmed: false, reason: 'cancelled' })
  })

  it('revokeAll resolves revoked and nothing can run', async () => {
    const h = harness()
    const outcome = h.broker.issue(request())
    const c = h.card()
    h.broker.revokeAll('sign-out')
    await expect(outcome).resolves.toEqual({ confirmed: false, reason: 'revoked' })
    h.advance(400)
    expect(
      h.broker.decide({
        proposalId: c.proposalId,
        nonce: c.nonce,
        argsHash: c.argsHash,
        confirm: true,
        webContentsId: 7
      })
    ).toEqual({ ok: false, reason: 'already_decided' })
  })

  it('a stale catalog revision resolves stale', async () => {
    let revision = 3
    const h = harness({ revision: () => revision })
    const outcome = h.broker.issue(request())
    h.advance(400)
    revision = 4
    const c = h.card()
    expect(
      h.broker.decide({
        proposalId: c.proposalId,
        nonce: c.nonce,
        argsHash: c.argsHash,
        confirm: true,
        webContentsId: 7
      })
    ).toEqual({ ok: false, reason: 'stale' })
    await expect(outcome).resolves.toEqual({ confirmed: false, reason: 'stale' })
  })

  it('the card carries no arguments and audit carries no content', async () => {
    const audit = vi.fn()
    const broker = createConnectorConfirmBroker({
      send: () => undefined,
      catalogRevision: () => 3,
      audit,
      schedule: () => () => undefined
    })
    const outcome = broker.issue(request({ recipients: [{ address: 'x@example.test', source: 'calendar' }] }))
    broker.revokeAll('test')
    await outcome
    expect(JSON.stringify(audit.mock.calls)).not.toContain('example.test')
  })
})
