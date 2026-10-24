import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_CHOICE_IPC } from '../shared/connector-account-choice'
import { createAccountChoicePreloadApi } from './connector-account-choice'

const REF_A = `acct_${'A'.repeat(43)}`
const REF_B = `acct_${'B'.repeat(43)}`
const CARD = {
  choiceId: 'a'.repeat(32),
  nonce: 'b'.repeat(64),
  argsHash: 'c'.repeat(64),
  expiresAt: 5,
  title: 'Which account for this draft?',
  detail: 'Choose.',
  options: [
    { accountRef: REF_A, label: 'Work', health: 'healthy', selectable: true },
    { accountRef: REF_B, label: 'Personal', health: 'needs_reauth', selectable: false }
  ]
}

function fakeIpc(reply: unknown = undefined) {
  const listeners = new Set<(event: unknown, payload: unknown) => void>()
  return {
    listeners,
    ipc: {
      on: vi.fn((_c: string, fn: (event: unknown, payload: unknown) => void) => listeners.add(fn)),
      removeListener: vi.fn((_c: string, fn: (event: unknown, payload: unknown) => void) => listeners.delete(fn)),
      invoke: vi.fn(async () => reply)
    },
    push: (payload: unknown) => listeners.forEach((fn) => fn({}, payload))
  }
}

describe('account choice preload bridge', () => {
  it('delivers a well-formed card, drops a malformed or over-sharing push, and unsubscribes', () => {
    const { ipc, push, listeners } = fakeIpc()
    const api = createAccountChoicePreloadApi(ipc as never).accountChoice
    const seen: unknown[] = []
    const off = api.onChanged((state) => seen.push(state))
    push(CARD)
    push({ ...CARD, input: { subject: 'leak' } })
    push({ ...CARD, options: [CARD.options[0]] })
    push({ choiceId: null })
    expect(seen).toEqual([CARD, { choiceId: null }])
    off()
    expect(listeners.size).toBe(0)
  })

  it('current() falls back to no card on a malformed reply', async () => {
    expect(await createAccountChoicePreloadApi(fakeIpc(CARD).ipc as never).accountChoice.current()).toEqual(CARD)
    expect(await createAccountChoicePreloadApi(fakeIpc({ junk: 1 }).ipc as never).accountChoice.current()).toEqual({
      choiceId: null
    })
  })

  it('validates a decision before invoking and the reply after', async () => {
    const { ipc } = fakeIpc({ ok: true, result: { ok: true, id: 'd1' } })
    const api = createAccountChoicePreloadApi(ipc as never).accountChoice
    const decision = { choiceId: CARD.choiceId, nonce: CARD.nonce, argsHash: CARD.argsHash, accountRef: REF_A as never }
    expect(await api.decide(decision)).toEqual({ ok: true, result: { ok: true, id: 'd1' } })
    expect(ipc.invoke).toHaveBeenCalledWith(ACCOUNT_CHOICE_IPC.decide, decision)
    expect(await api.decide({ ...decision, accountRef: 'plain-email@example.test' as never })).toEqual({
      ok: false,
      reason: 'invalid_input'
    })
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    const bad = createAccountChoicePreloadApi(fakeIpc({ ok: true, result: { ok: true, extra: 1 } }).ipc as never)
    expect(await bad.accountChoice.decide(decision)).toEqual({ ok: false, reason: 'invalid_input' })
  })

  it('cancel sends only the card id and nonce', async () => {
    const { ipc } = fakeIpc({ ok: true })
    const api = createAccountChoicePreloadApi(ipc as never).accountChoice
    expect(await api.cancel({ choiceId: CARD.choiceId, nonce: CARD.nonce })).toEqual({ ok: true })
    expect(ipc.invoke).toHaveBeenCalledWith(ACCOUNT_CHOICE_IPC.cancel, { choiceId: CARD.choiceId, nonce: CARD.nonce })
    expect(await api.cancel({ choiceId: 'x', nonce: 'y' })).toEqual({ ok: false })
  })
})
