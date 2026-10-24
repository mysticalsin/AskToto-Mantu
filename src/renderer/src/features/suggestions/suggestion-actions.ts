/**
 * Suggestion card actions that talk to main (G69). Adjust mirrors G67's editor exactly: every call names the card the
 * owner saw (its original revision and nonce). A draft makes revision n+1 without replacing n; commit makes it current;
 * cancel discards it and the original card stays. After any `ok` the caller refetches and takes the new ref from the list.
 */
import type { AckResult, AdjustResult, CardView } from '@shared/suggestions'
import { refOf } from './carousel-model'

export type SuggestionsApi = Window['toto']['suggestions']

export class AdjustSession {
  private drafted = false
  private readonly ref

  constructor(
    private readonly api: SuggestionsApi,
    card: CardView
  ) {
    this.ref = refOf(card)
  }

  async draft(title: string): Promise<AdjustResult> {
    const result = await this.api.adjust({ ...this.ref, action: 'draft', title })
    if (result.ok) this.drafted = true
    return result
  }

  async save(): Promise<AdjustResult> {
    const result = await this.api.adjust({ ...this.ref, action: 'commit' })
    if (result.ok) this.drafted = false
    return result
  }

  /** Discards a pending draft. With no draft there is nothing to discard, so nothing is sent. */
  async cancel(): Promise<AdjustResult | null> {
    if (!this.drafted) return null
    this.drafted = false
    return this.api.adjust({ ...this.ref, action: 'cancel' })
  }
}

/** Tells main the card was shown, once per revision per mount. */
export async function ackShown(
  api: SuggestionsApi,
  tracker: { shouldAck(card: Pick<CardView, 'id' | 'revision'>): boolean },
  card: CardView
): Promise<AckResult | null> {
  if (!tracker.shouldAck(card)) return null
  return api.shown(refOf(card))
}
