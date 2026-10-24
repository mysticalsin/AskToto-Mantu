import { describe, expect, it } from 'vitest'
import type { AccountRef } from '@shared/connector-catalog'
import { isAccountSelectable, resolveAccount, type AccountCandidate } from './account-resolver'

const ref = (c: string): AccountRef => `acct_${c.repeat(43)}` as AccountRef
const A = ref('A')
const B = ref('B')
const C = ref('C')
const cand = (accountRef: AccountRef, health: AccountCandidate['health']): AccountCandidate => ({ accountRef, health })

describe('account resolver', () => {
  it('an explicit owner choice wins over the source item account', () => {
    const r = resolveAccount({
      candidates: [cand(A, 'healthy'), cand(B, 'healthy')],
      effect: 'create',
      signals: { ownerChoice: B, sourceAccount: A }
    })
    expect(r).toEqual({ ok: true, accountRef: B, rule: 'explicit_owner_choice' })
  })

  it('the account bound to the source item is used when the owner made no choice', () => {
    const r = resolveAccount({
      candidates: [cand(A, 'healthy'), cand(B, 'healthy')],
      effect: 'create',
      signals: { sourceAccount: A }
    })
    expect(r).toEqual({ ok: true, accountRef: A, rule: 'source_item_account' })
  })

  it('a named account that is gone is refused, never replaced by another account', () => {
    const gone = resolveAccount({
      candidates: [cand(A, 'healthy'), cand(B, 'disconnected')],
      effect: 'create',
      signals: { ownerChoice: B }
    })
    expect(gone).toEqual({ ok: false, reason: 'no_account' })
    const unknown = resolveAccount({
      candidates: [cand(A, 'healthy')],
      effect: 'create',
      signals: { sourceAccount: C }
    })
    expect(unknown).toEqual({ ok: false, reason: 'no_account' })
  })

  it('the only live account resolves without a signal, even before its first health check', () => {
    expect(resolveAccount({ candidates: [cand(A, 'connecting')], effect: 'create' })).toEqual({
      ok: true,
      accountRef: A,
      rule: 'only_account'
    })
    expect(resolveAccount({ candidates: [cand(A, 'healthy'), cand(B, 'disconnected')], effect: 'read' })).toMatchObject(
      {
        ok: true,
        accountRef: A,
        rule: 'only_account'
      }
    )
  })

  it('excludes accounts that are not ready (G61) when picking one healthy account among several', () => {
    const r = resolveAccount({
      candidates: [cand(A, 'needs_reauth'), cand(B, 'healthy'), cand(C, 'connecting')],
      effect: 'create'
    })
    expect(r).toEqual({ ok: true, accountRef: B, rule: 'single_healthy_account' })
  })

  it('a degraded account counts for reads but not for writes', () => {
    const candidates = [cand(A, 'degraded'), cand(B, 'needs_reauth')]
    expect(resolveAccount({ candidates, effect: 'read' })).toEqual({
      ok: true,
      accountRef: A,
      rule: 'single_healthy_account'
    })
    expect(resolveAccount({ candidates, effect: 'create' })).toEqual({ ok: false, reason: 'not_ready' })
  })

  it('is ambiguous with several healthy accounts and no signal, and offers every live account', () => {
    const r = resolveAccount({
      candidates: [cand(A, 'healthy'), cand(B, 'healthy'), cand(C, 'disconnected'), cand(ref('D'), 'needs_reauth')],
      effect: 'create'
    })
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' })
    if (!r.ok && r.reason === 'ambiguous') expect(r.options.map((o) => o.accountRef)).toEqual([A, B, ref('D')])
  })

  it('lets the owner choose among accounts that are still connecting, and refuses when nothing can be used', () => {
    expect(
      resolveAccount({ candidates: [cand(A, 'connecting'), cand(B, 'connecting')], effect: 'create' })
    ).toMatchObject({ ok: false, reason: 'ambiguous' })
    expect(
      resolveAccount({ candidates: [cand(A, 'needs_reauth'), cand(B, 'needs_reauth')], effect: 'create' })
    ).toEqual({ ok: false, reason: 'not_ready' })
    expect(isAccountSelectable('connecting', 'create')).toBe(true)
    expect(isAccountSelectable('needs_reauth', 'create')).toBe(false)
    expect(isAccountSelectable('degraded', 'create')).toBe(false)
    expect(isAccountSelectable('degraded', 'read')).toBe(true)
  })

  it('reports no_account with nothing connected', () => {
    expect(resolveAccount({ candidates: [], effect: 'read' })).toEqual({ ok: false, reason: 'no_account' })
    expect(resolveAccount({ candidates: [cand(A, 'disconnected')], effect: 'read' })).toEqual({
      ok: false,
      reason: 'no_account'
    })
  })
})
