import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FieldHint } from './ui'

/**
 * MQA-202 — FieldHint is the ⓘ glyph that carries a setting's explanation. It declared `role="button"`
 * on a plain <span> with no click/key handler, so:
 *   • screen readers announced a control that Enter/Space could not operate (a span has no native
 *     activation behaviour, so the declared role was a promise the element could not keep), and
 *   • because a <span> is not *interactive content*, a mouse click on the glyph inside ToggleRow's
 *     `<label htmlFor={toggleId}>` was forwarded by the label to the switch — clicking the hint on
 *     "Hide from screen capture" or "Private View" flipped the privacy flag it was explaining.
 *
 * The trigger must be a real <button> (the same shape Bar.tsx's IconTool already uses): native
 * Enter/Space activation makes the role honest, and a button IS interactive content, so the label
 * stops forwarding the click.
 */
describe('FieldHint tooltip trigger (MQA-202)', () => {
  const html = (): string =>
    renderToStaticMarkup(
      <FieldHint text="On shows the rolling transcript alongside suggested replies.">
        <span data-glyph="info" />
      </FieldHint>
    )

  it('renders a real button instead of a span wearing role="button" (MQA-202)', () => {
    expect(html()).toMatch(/<button[^>]*type="button"/)
    expect(html()).not.toContain('role="button"')
  })

  it('keeps the description as the trigger accessible name so AT still reads it (MQA-202)', () => {
    expect(html()).toMatch(
      /<button[^>]*aria-label="On shows the rolling transcript alongside suggested replies\."/
    )
  })

  it('still renders the hover/focus tooltip text (MQA-202)', () => {
    expect(html()).toContain('On shows the rolling transcript alongside suggested replies.')
    expect(html()).toContain('pointer-events-none')
  })
})
