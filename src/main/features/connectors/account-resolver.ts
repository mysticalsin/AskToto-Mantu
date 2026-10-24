import type { ConnectorAccountHealth } from '@shared/connector-accounts'
import type { AccountRef, AccountResolutionRule, ConnectorEffect } from '@shared/connector-catalog'
import { isConnectorAccountReady } from './account-health'

export interface AccountCandidate {
  accountRef: AccountRef
  health: ConnectorAccountHealth
}

/** Trusted signals only. Both come from main (the owner's card decision, the account that fetched the source item). */
export interface AccountSignals {
  /** The owner picked this account on the choice card (or an equivalent explicit selection). */
  ownerChoice?: AccountRef
  /** The account bound to the item the operation concerns, e.g. the one that delivered the meeting's calendar event. */
  sourceAccount?: AccountRef
}

export type AccountResolution =
  | { ok: true; accountRef: AccountRef; rule: AccountResolutionRule }
  | { ok: false; reason: 'no_account' | 'not_ready' }
  | { ok: false; reason: 'ambiguous'; options: AccountCandidate[] }

/**
 * Pick the account for one operation. Order: explicit owner choice, then the account bound to the source item, then
 * the only account, then a single healthy account among several. A named account (choice or source) is never replaced
 * by another one: if it is gone it is `no_account`. Whether it can run right now is still the executor's readiness
 * gate (after it observes the account's grant), so a named account that needs attention fails closed there.
 * Disconnected accounts are not candidates at all. Among several accounts, only those ready for this effect (G61)
 * count for the automatic pick; with more than one and no signal the answer is `ambiguous`, never a guess.
 */
export function resolveAccount(input: {
  candidates: readonly AccountCandidate[]
  effect: ConnectorEffect
  signals?: AccountSignals
}): AccountResolution {
  const live = input.candidates.filter((candidate) => candidate.health !== 'disconnected')
  const named = (ref: AccountRef, rule: AccountResolutionRule): AccountResolution =>
    live.some((candidate) => candidate.accountRef === ref)
      ? { ok: true, accountRef: ref, rule }
      : { ok: false, reason: 'no_account' }
  const signals = input.signals ?? {}
  if (signals.ownerChoice) return named(signals.ownerChoice, 'explicit_owner_choice')
  if (signals.sourceAccount) return named(signals.sourceAccount, 'source_item_account')

  if (live.length === 0) return { ok: false, reason: 'no_account' }
  if (live.length === 1) return { ok: true, accountRef: live[0].accountRef, rule: 'only_account' }
  const ready = live.filter((candidate) => isConnectorAccountReady(candidate.health, input.effect))
  if (ready.length === 1) return { ok: true, accountRef: ready[0].accountRef, rule: 'single_healthy_account' }
  // Nothing proven healthy: accounts still connecting can be verified on use, so the owner may pick among them.
  if (ready.length === 0 && !live.some((candidate) => candidate.health === 'connecting')) {
    return { ok: false, reason: 'not_ready' }
  }
  return { ok: false, reason: 'ambiguous', options: [...live] }
}

/** Whether the choice card lets the owner pick this account: ready now, or still connecting (verified on use). */
export function isAccountSelectable(health: ConnectorAccountHealth, effect: ConnectorEffect): boolean {
  return health === 'connecting' || isConnectorAccountReady(health, effect)
}
