/**
 * CardSwapGuard: a post-generation duplicate check may roll back only the newest still-current card
 * swap. Ported from the reference kernel. The model deciding "duplicate" does not authorize arbitrary
 * state restoration: rollback needs the newest unexpired ticket and an unchanged session context.
 * Production display acknowledgement belongs at the overlay/IPC boundary (G71).
 */
import { z } from 'zod'
import {
  INTERVENTION_CARD_SWAP_MAX_CHARS,
  InterventionError,
  freezeDeep,
  interventionIdSchema,
  requireCondition,
  type InterventionContext,
  type InterventionScope,
  type InterventionSnapshotRef
} from '../intervention-contract'

const swapCardSchema = z
  .object({ id: interventionIdSchema, text: z.string().max(INTERVENTION_CARD_SWAP_MAX_CHARS) })
  .strict()

export interface SwappedCard {
  readonly id: string
  readonly text: string
  readonly scope: InterventionScope
  readonly generation: number
  readonly contextRevision: number
  readonly swapRevision: number
}

export interface CardSwapTicket {
  readonly swapRevision: number
  readonly cardId: string
}

interface CurrentCard<S> {
  card: SwappedCard
  snapshot: S
}

interface IssuedTicket<S> {
  snapshot: S
  previous: CurrentCard<S> | null
  revision: number
}

export class CardSwapGuard<S extends InterventionSnapshotRef = InterventionSnapshotRef> {
  private readonly context: InterventionContext<S>
  private currentCard: CurrentCard<S> | null = null
  private revision = 0
  private readonly issued = new WeakMap<CardSwapTicket, IssuedTicket<S>>()
  private closed = false
  private readonly unsubscribe: () => unknown

  constructor(context: InterventionContext<S>) {
    this.context = context
    this.unsubscribe = context.onChange(() => {
      this.currentCard = null
      this.revision += 1
    })
  }

  swap(snapshot: S, card: { id: string; text: string }): CardSwapTicket {
    requireCondition(!this.closed, 'CARD_GUARD_CLOSED')
    this.context.assertCurrent(snapshot)
    const parsed = swapCardSchema.safeParse(card)
    if (!parsed.success) throw new InterventionError('CARD_SCHEMA')
    const previous = this.currentCard
    this.revision += 1
    const cardValue: SwappedCard = freezeDeep({
      id: parsed.data.id,
      text: parsed.data.text,
      scope: { ...snapshot.scope },
      generation: snapshot.generation,
      contextRevision: snapshot.contextRevision,
      swapRevision: this.revision
    })
    this.currentCard = { card: cardValue, snapshot }
    const ticket: CardSwapTicket = Object.freeze({ swapRevision: this.revision, cardId: parsed.data.id })
    this.issued.set(ticket, { snapshot, previous, revision: this.revision })
    return ticket
  }

  /** Restores the prior card only for the newest valid ticket while the context is unchanged. */
  rollback(ticket: CardSwapTicket): boolean {
    const record = this.take(ticket)
    if (this.closed || !this.context.isCurrent(record.snapshot) || this.revision !== record.revision) return false
    this.currentCard = record.previous && this.context.isCurrent(record.previous.snapshot) ? record.previous : null
    this.revision += 1
    return true
  }

  /** Closes the ticket; true only if it was still the newest swap in a current context. */
  confirm(ticket: CardSwapTicket): boolean {
    const record = this.take(ticket)
    return !this.closed && this.context.isCurrent(record.snapshot) && this.revision === record.revision
  }

  get current(): SwappedCard | null {
    return this.currentCard?.card ?? null
  }

  dispose(): void {
    this.closed = true
    this.unsubscribe()
    this.currentCard = null
    this.revision += 1
  }

  private take(ticket: CardSwapTicket): IssuedTicket<S> {
    const record = ticket ? this.issued.get(ticket) : undefined
    requireCondition(record, 'CARD_TICKET_NOT_ISSUED')
    this.issued.delete(ticket)
    return record
  }
}
