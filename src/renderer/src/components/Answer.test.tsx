import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Answer } from './Answer'

describe('Answer capture recovery', () => {
  it('keeps the capture failure visible when the text fallback also errors', () => {
    const html = renderToStaticMarkup(
      <Answer
        text=""
        streaming={false}
        error="No API key for Claude."
        captureNotice="Screen recording permission is off."
      />
    )

    expect(html).toContain('Screen recording permission is off.')
    expect(html).toContain('No API key for Claude.')
  })
})
