import type { CardOutcome } from './duplicate-review'

/** Receipts in flight, so a card outcome never reaches main before the receipt that marks the card displayed. */
const RECEIPT_CAP = 64
const receipts = new Map<string, Promise<void>>()

/**
 * Tells main that a suggestion is on screen, after the frame that paints it. A hidden overlay never runs
 * the frame, so it never sends a receipt: "displayed" is only ever counted for a card that was drawn.
 * `isCurrent` drops the receipt when the suggestion was replaced before its frame.
 */
export function reportDisplayReceiptWhenPainted(askId: string, isCurrent: () => boolean): void {
  const sent = new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      if (isCurrent()) void window.toto.reportDisplayReceipt(askId)
      resolve()
    })
  })
  receipts.set(askId, sent)
  if (receipts.size > RECEIPT_CAP) {
    const oldest = receipts.keys().next().value
    if (oldest !== undefined) receipts.delete(oldest)
  }
}

/**
 * Reports how a card's duplicate review ended: the ask id and a closed outcome name, nothing else. It waits
 * for that card's receipt first (main counts an outcome only for a displayed card); a card that never painted
 * never resolves, so it reports nothing.
 */
export function reportCardOutcomeAfterReceipt(askId: string, outcome: CardOutcome): void {
  const sent = receipts.get(askId)
  if (!sent) return
  void sent
    .then(() => {
      receipts.delete(askId)
      return window.toto.reportCardOutcome(askId, outcome)
    })
    .catch(() => undefined)
}
