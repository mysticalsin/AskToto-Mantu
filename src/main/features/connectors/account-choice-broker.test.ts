import { describe, expect, it, vi } from 'vitest'
import type { AccountRef, ConnectorAccountChoiceOption } from '@shared/connector-catalog'
import type { AccountChoiceState } from '@shared/connector-account-choice'
import { createAccountChoiceBroker } from './account-choice-broker'

const A = `acct_${'A'.repeat(43)}` as AccountRef
const B = `acct_${'B'.repeat(43)}` as AccountRef
const SICK = `acct_${'C'.repeat(43)}` as AccountRef
const ARGS = 'a'.repeat(64)
const OPTIONS: ConnectorAccountChoiceOption[] = [
  { accountRef: A, label: 'Work', maskedHint: 'w***@example.test', health: 'healthy', selectable: true },
  { accountRef: B, label: 'Personal', health: 'healthy', selectable: true },
  { accountRef: SICK, label: 'Old', health: 'needs_reauth', selectable: false }
]
const OWNER = 7

function setup(over: { revision?: number } = {}) {
  let clock = 1_000
  let revision = over.revision ?? 3
  const sent: Array<{ id: number; state: AccountChoiceState }> = []
  const resume = vi.fn(async (_pending: unknown, _accountRef: AccountRef) => ({ ok: true, id: 'draft-1' }))
  const audit = vi.fn()
  const broker = createAccountChoiceBroker({
    now: () => clock,
    send: (id, state) => sent.push({ id, state }),
    resume,
    catalogRevision: () => revision,
    audit
  })
  const issue = (owner = OWNER) =>
    broker.issue({
      ownerWebContentsId: owner,
      opId: 'outlook.draft.create',
      revision: 3,
      argsHash: ARGS,
      input: { subject: 'secret subject', body: 'secret body' },
      options: OPTIONS
    })
  return {
    broker,
    issue,
    resume,
    audit,
    sent,
    advance: (ms: number) => (clock += ms),
    setRevision: (n: number) => (revision = n)
  }
}

const cardOf = (state: AccountChoiceState) => {
  if (state.choiceId === null) throw new Error('expected a card')
  return state
}

describe('account choice broker', () => {
  it('issues a card to the owner window with renderer-safe fields only', () => {
    const s = setup()
    const card = s.issue()
    expect(card).not.toBeNull()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].id).toBe(OWNER)
    const state = cardOf(s.sent[0].state)
    expect(state.argsHash).toBe(ARGS)
    expect(state.options.map((o) => o.accountRef)).toEqual([A, B, SICK])
    expect(state.options[2].selectable).toBe(false)
    const wire = JSON.stringify(state)
    expect(wire).not.toContain('secret subject')
    expect(wire).not.toContain('secret body')
    expect(wire).not.toContain('outlook.draft.create')
    expect(s.broker.current(OWNER)).toEqual(state)
    expect(s.broker.current(999)).toEqual({ choiceId: null })
  })

  it('resumes exactly that operation once with the chosen account, bound to its proposal id and args hash', async () => {
    const s = setup()
    s.issue()
    const card = cardOf(s.sent[0].state)
    s.advance(400)
    const r = await s.broker.decide({
      webContentsId: OWNER,
      choiceId: card.choiceId,
      nonce: card.nonce,
      argsHash: card.argsHash,
      accountRef: B
    })
    expect(r).toEqual({ ok: true, result: { ok: true, id: 'draft-1' } })
    expect(s.resume).toHaveBeenCalledOnce()
    const [pending, chosen] = s.resume.mock.calls[0]
    expect(chosen).toBe(B)
    expect(pending).toMatchObject({
      choiceId: card.choiceId,
      opId: 'outlook.draft.create',
      revision: 3,
      argsHash: ARGS,
      input: { subject: 'secret subject', body: 'secret body' }
    })
    expect(s.sent.at(-1)?.state).toEqual({ choiceId: null })
    expect(JSON.stringify(s.audit.mock.calls)).not.toMatch(/acct_|secret/)
  })

  it('refuses a replayed decision: the card is consumed before the operation runs', async () => {
    const s = setup()
    s.issue()
    const card = cardOf(s.sent[0].state)
    s.advance(400)
    const decision = { webContentsId: OWNER, choiceId: card.choiceId, nonce: card.nonce, argsHash: card.argsHash }
    const first = s.broker.decide({ ...decision, accountRef: A })
    const second = await s.broker.decide({ ...decision, accountRef: A })
    expect(second).toEqual({ ok: false, reason: 'missing' })
    expect((await first).ok).toBe(true)
    expect(s.resume).toHaveBeenCalledOnce()
  })

  it('refuses a wrong nonce, args hash, window or unoffered account without consuming the card', async () => {
    const s = setup()
    s.issue()
    const card = cardOf(s.sent[0].state)
    s.advance(400)
    const good = { webContentsId: OWNER, choiceId: card.choiceId, nonce: card.nonce, argsHash: card.argsHash }
    expect(await s.broker.decide({ ...good, nonce: 'b'.repeat(64), accountRef: A })).toEqual({
      ok: false,
      reason: 'nonce_mismatch'
    })
    expect(await s.broker.decide({ ...good, argsHash: 'c'.repeat(64), accountRef: A })).toEqual({
      ok: false,
      reason: 'args_mismatch'
    })
    expect(await s.broker.decide({ ...good, webContentsId: 8, accountRef: A })).toEqual({
      ok: false,
      reason: 'owner_mismatch'
    })
    const stranger = `acct_${'Q'.repeat(43)}` as AccountRef
    expect(await s.broker.decide({ ...good, accountRef: stranger })).toEqual({ ok: false, reason: 'not_offered' })
    expect(await s.broker.decide({ ...good, accountRef: SICK })).toEqual({ ok: false, reason: 'not_offered' })
    expect(s.resume).not.toHaveBeenCalled()
    expect((await s.broker.decide({ ...good, accountRef: A })).ok).toBe(true)
  })

  it('refuses a decision inside the return-guard window without consuming the card', async () => {
    const s = setup()
    s.issue()
    const card = cardOf(s.sent[0].state)
    const input = {
      webContentsId: OWNER,
      choiceId: card.choiceId,
      nonce: card.nonce,
      argsHash: card.argsHash,
      accountRef: A
    }
    expect(await s.broker.decide(input)).toEqual({ ok: false, reason: 'too_soon' })
    s.advance(400)
    expect((await s.broker.decide(input)).ok).toBe(true)
  })

  it('expires: an old card never confirms, it clears', async () => {
    const s = setup()
    s.issue()
    const card = cardOf(s.sent[0].state)
    s.advance(card.expiresAt - 1_000 + 1)
    expect(
      await s.broker.decide({
        webContentsId: OWNER,
        choiceId: card.choiceId,
        nonce: card.nonce,
        argsHash: card.argsHash,
        accountRef: A
      })
    ).toEqual({ ok: false, reason: 'expired' })
    expect(s.resume).not.toHaveBeenCalled()
    expect(s.broker.current(OWNER)).toEqual({ choiceId: null })
  })

  it('refuses a choice planned against an older catalog revision as stale', async () => {
    const s = setup()
    s.issue()
    const card = cardOf(s.sent[0].state)
    s.advance(400)
    s.setRevision(4)
    expect(
      await s.broker.decide({
        webContentsId: OWNER,
        choiceId: card.choiceId,
        nonce: card.nonce,
        argsHash: card.argsHash,
        accountRef: A
      })
    ).toEqual({ ok: false, reason: 'stale' })
    expect(s.resume).not.toHaveBeenCalled()
  })

  it('a newer card replaces the older one, and the older one can no longer resume', async () => {
    const s = setup()
    s.issue()
    const first = cardOf(s.sent[0].state)
    s.issue()
    s.advance(400)
    const r = await s.broker.decide({
      webContentsId: OWNER,
      choiceId: first.choiceId,
      nonce: first.nonce,
      argsHash: first.argsHash,
      accountRef: A
    })
    expect(r).toEqual({ ok: false, reason: 'missing' })
    expect(s.resume).not.toHaveBeenCalled()
  })

  it('cancel and revokeAll authorize nothing and clear the card', async () => {
    const s = setup()
    s.issue()
    const card = cardOf(s.sent[0].state)
    expect(s.broker.cancel({ webContentsId: 8, choiceId: card.choiceId, nonce: card.nonce })).toBe(false)
    expect(s.broker.cancel({ webContentsId: OWNER, choiceId: card.choiceId, nonce: 'b'.repeat(64) })).toBe(false)
    expect(s.broker.cancel({ webContentsId: OWNER, choiceId: card.choiceId, nonce: card.nonce })).toBe(true)
    expect(s.broker.current(OWNER)).toEqual({ choiceId: null })
    s.issue()
    s.broker.revokeAll('sign-out')
    expect(s.broker.current(OWNER)).toEqual({ choiceId: null })
    expect(s.resume).not.toHaveBeenCalled()
  })

  it('reports a resume that throws as a plain failure, not as success', async () => {
    const s = setup()
    s.resume.mockRejectedValueOnce(new Error('provider detail'))
    s.issue()
    const card = cardOf(s.sent[0].state)
    s.advance(400)
    const r = await s.broker.decide({
      webContentsId: OWNER,
      choiceId: card.choiceId,
      nonce: card.nonce,
      argsHash: card.argsHash,
      accountRef: A
    })
    expect(r).toEqual({ ok: true, result: { ok: false, error: expect.not.stringContaining('provider detail') } })
  })
})
