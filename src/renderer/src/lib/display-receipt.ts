/**
 * Tells main that a suggestion is on screen, after the frame that paints it. A hidden overlay never runs
 * the frame, so it never sends a receipt: "displayed" is only ever counted for a card that was drawn.
 * `isCurrent` drops the receipt when the suggestion was replaced before its frame.
 */
export function reportDisplayReceiptWhenPainted(askId: string, isCurrent: () => boolean): void {
  requestAnimationFrame(() => {
    if (!isCurrent()) return
    void window.toto.reportDisplayReceipt(askId)
  })
}
