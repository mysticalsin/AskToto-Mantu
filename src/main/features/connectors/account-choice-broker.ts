import { randomBytes, timingSafeEqual } from 'node:crypto'
import { COMMAND_RETURN_GUARD_MS } from '@shared/command-return-guard'
import type { AccountRef, ConnectorAccountChoiceOption } from '@shared/connector-catalog'
import type {
  AccountChoiceCard,
  AccountChoiceDecision,
  AccountChoiceDecisionResponse,
  AccountChoiceRunResult,
  AccountChoiceState
} from '@shared/connector-account-choice'
import { COMMAND_PROPOSAL_TTL_ASSISTIVE_MS } from '@shared/metis-command-contract'

/** Everything main must remember to resume exactly one operation. It never leaves main. */
export interface PendingAccountChoice {
  choiceId: string
  opId: string
  revision: number
  argsHash: string
  /** The window the card went to; the confirm card that follows the choice goes to the same window (G64). */
  ownerWebContentsId: number
  /** The schema-parsed arguments. Held here only; the renderer is shown none of it. */
  input: unknown
}

export interface AccountChoiceBrokerDeps {
  /** Pushes the owner window's card state. Production sends to `webContents.fromId(id)`. */
  send(webContentsId: number, state: AccountChoiceState): void
  /** Runs the pending operation against the chosen account. The broker calls it at most once per card. */
  resume(pending: PendingAccountChoice, accountRef: AccountRef): Promise<AccountChoiceRunResult>
  /** The catalog revision right now; a card issued against another revision is stale. */
  catalogRevision(): number
  audit?(event: string, metadata: Record<string, string | number | boolean>): void
  now?(): number
  /** Defaults to the assistive lifetime (30 s): choosing between accounts takes longer than reading a confirm. */
  ttlMs?: number
  /** Earliest a decision may land after the card appeared (the 300 ms return guard). */
  minDecideDelayMs?: number
}

export interface AccountChoiceBroker {
  issue(input: {
    ownerWebContentsId: number
    opId: string
    revision: number
    argsHash: string
    input: unknown
    options: readonly ConnectorAccountChoiceOption[]
  }): AccountChoiceCard
  current(webContentsId: number): AccountChoiceState
  decide(input: AccountChoiceDecision & { webContentsId: number }): Promise<AccountChoiceDecisionResponse>
  cancel(input: { webContentsId: number; choiceId: string; nonce: string }): boolean
  /** Sign-out, owner change or window loss: every pending card is dropped, nothing runs. */
  revokeAll(reason: string): void
}

interface Pending extends PendingAccountChoice {
  nonce: string
  ownerWebContentsId: number
  expiresAt: number
  shownAt: number
  selectable: ReadonlySet<string>
  card: AccountChoiceCard
}

const COPY: Readonly<Record<string, { title: string; detail: string }>> = {
  'outlook.draft.create': {
    title: 'Which account for this draft?',
    detail: 'You have more than one Outlook account. Choose where to save the draft. It will not be sent.'
  },
  'outlook.event.create': {
    title: 'Which account for this event?',
    detail: 'You have more than one Outlook account. Choose where to add the event. No invitations are sent.'
  }
}
const GENERIC_COPY = {
  title: 'Which account?',
  detail: 'You have more than one account. Choose which one to use. Nothing has changed yet.'
}
const RUN_FAILED = 'The account could not complete this. Nothing was confirmed.'

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * The ambiguity choice card's main side (G62). It follows the confirmation card's rules (CommandControl): an opaque
 * proposal id and nonce, the hash of the exact request, a fixed lifetime that only ever cancels, the 300 ms return
 * guard, owner-window binding and consume-before-run so a replay cannot execute twice. One card per owner window.
 */
export function createAccountChoiceBroker(deps: AccountChoiceBrokerDeps): AccountChoiceBroker {
  const now = deps.now ?? (() => Date.now())
  const ttl = deps.ttlMs ?? COMMAND_PROPOSAL_TTL_ASSISTIVE_MS
  const guardMs = deps.minDecideDelayMs ?? COMMAND_RETURN_GUARD_MS
  const byId = new Map<string, Pending>()
  const byOwner = new Map<number, string>()
  const audit = (event: string, metadata: Record<string, string | number | boolean>): void => {
    try {
      deps.audit?.(event, metadata)
    } catch {
      /* audit is best effort */
    }
  }
  const push = (webContentsId: number, state: AccountChoiceState): void => {
    try {
      deps.send(webContentsId, state)
    } catch {
      /* the window may be gone; the card stays refusable by main */
    }
  }
  const drop = (pending: Pending, reason: string): void => {
    byId.delete(pending.choiceId)
    if (byOwner.get(pending.ownerWebContentsId) === pending.choiceId) {
      byOwner.delete(pending.ownerWebContentsId)
      push(pending.ownerWebContentsId, { choiceId: null })
    }
    audit('connector.account_choice.closed', { opId: pending.opId, reason })
  }

  return {
    issue(input) {
      const previousId = byOwner.get(input.ownerWebContentsId)
      const previous = previousId ? byId.get(previousId) : undefined
      if (previous) drop(previous, 'replaced')
      const choiceId = randomBytes(16).toString('hex')
      const nonce = randomBytes(32).toString('hex')
      const shownAt = now()
      const copy = COPY[input.opId] ?? GENERIC_COPY
      const card: AccountChoiceCard = {
        choiceId,
        nonce,
        argsHash: input.argsHash,
        expiresAt: shownAt + ttl,
        title: copy.title,
        detail: copy.detail,
        options: input.options.map((option) => ({
          accountRef: option.accountRef,
          label: option.label,
          ...(option.maskedHint ? { maskedHint: option.maskedHint } : {}),
          health: option.health,
          selectable: option.selectable
        }))
      }
      const pending: Pending = {
        choiceId,
        nonce,
        opId: input.opId,
        revision: input.revision,
        argsHash: input.argsHash,
        input: input.input,
        ownerWebContentsId: input.ownerWebContentsId,
        expiresAt: card.expiresAt,
        shownAt,
        selectable: new Set(input.options.filter((o) => o.selectable).map((o) => o.accountRef)),
        card
      }
      byId.set(choiceId, pending)
      byOwner.set(input.ownerWebContentsId, choiceId)
      push(input.ownerWebContentsId, card)
      audit('connector.account_choice.issued', { opId: input.opId, optionCount: card.options.length })
      return card
    },

    current(webContentsId) {
      const id = byOwner.get(webContentsId)
      const pending = id ? byId.get(id) : undefined
      if (!pending) return { choiceId: null }
      if (now() >= pending.expiresAt) {
        drop(pending, 'expired')
        return { choiceId: null }
      }
      return pending.card
    },

    async decide(input) {
      const pending = byId.get(input.choiceId)
      if (!pending) return { ok: false, reason: 'missing' }
      if (pending.ownerWebContentsId !== input.webContentsId) return { ok: false, reason: 'owner_mismatch' }
      if (!secureEqual(pending.nonce, input.nonce)) return { ok: false, reason: 'nonce_mismatch' }
      if (!secureEqual(pending.argsHash, input.argsHash)) return { ok: false, reason: 'args_mismatch' }
      if (now() >= pending.expiresAt) {
        drop(pending, 'expired')
        return { ok: false, reason: 'expired' }
      }
      if (!pending.selectable.has(input.accountRef)) return { ok: false, reason: 'not_offered' }
      if (now() - pending.shownAt < guardMs) return { ok: false, reason: 'too_soon' }
      if (deps.catalogRevision() !== pending.revision) {
        drop(pending, 'stale')
        return { ok: false, reason: 'stale' }
      }
      // Consume before yielding to the operation, so a double click or a replay cannot run it twice.
      drop(pending, 'chosen')
      audit('connector.account_choice.chosen', { opId: pending.opId })
      try {
        return { ok: true, result: await deps.resume(pending, input.accountRef) }
      } catch {
        // The thrown text may carry provider detail; it is deliberately not forwarded.
        return { ok: true, result: { ok: false, error: RUN_FAILED } }
      }
    },

    cancel(input) {
      const pending = byId.get(input.choiceId)
      if (!pending || pending.ownerWebContentsId !== input.webContentsId) return false
      if (!secureEqual(pending.nonce, input.nonce)) return false
      drop(pending, 'cancelled')
      return true
    },

    revokeAll(reason) {
      for (const pending of [...byId.values()]) drop(pending, reason)
    }
  }
}
