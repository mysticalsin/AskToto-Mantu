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

describe('Answer provider attribution', () => {
  // MQA-053: a successful failover must not be silent. state.ts keeps the previous answer on screen while
  // the next request streams, so from the second ask of a session the "thinking" branch never renders —
  // the answering provider has to be named on the answer itself.
  it('names the provider on a finished answer (MQA-053)', () => {
    const html = renderToStaticMarkup(
      <Answer text="Here is the answer." streaming={false} error={null} provider="nvidia" />
    )

    expect(html).toContain('Answered by NVIDIA')
  })

  it('stays NEUTRAL while streaming — the provider is named only after the fact (MQA-269, revises MQA-053)', () => {
    // This test used to assert the opposite ("Asking your Dust agent…"). MQA-269 retired the streaming
    // byline deliberately: the row re-renders on every failover attempt, so naming the provider narrated
    // each hop — the user watched the brand change mid-wait for a failover that had worked. The pulse dot
    // still shows work is happening; `Answered by X` (asserted below) remains the one attribution
    // surface, after the answer, when it is stable and true.
    const html = renderToStaticMarkup(
      <Answer text="The previous answer, still on screen." streaming={true} error={null} provider="dust" />
    )

    expect(html).toContain('Thinking…')
    expect(html).not.toContain('Asking')
  })

  it('stays anonymous until streamMeta names a provider (MQA-053)', () => {
    const html = renderToStaticMarkup(<Answer text="Here is the answer." streaming={false} error={null} />)

    expect(html).not.toContain('Answered by')
  })
})

describe('Answer error hints', () => {
  // MQA-089: main crafts the Dust reconnect message on purpose — the credential is an OAuth token minted by
  // the Dust CLI, so appending "update your API key" sends the user to re-enter something they never typed.
  it('does not append the API-key hint to a Dust session expiry (MQA-089)', () => {
    const html = renderToStaticMarkup(
      <Answer
        text=""
        streaming={false}
        error="Your Dust session expired and could not refresh automatically. Open Settings and reconnect Dust once."
      />
    )

    expect(html).toContain('Open Settings and reconnect Dust once.')
    expect(html).not.toContain('Your API key may be invalid or expired.')
  })

  it('still hints at the key when the credential itself expired (MQA-089)', () => {
    const html = renderToStaticMarkup(
      <Answer
        text=""
        streaming={false}
        error="DeepSeek rejected your API key (it may have been revoked, expired, or run out of credit). Open Settings → AI to re-enter it."
      />
    )

    expect(html).toContain('Your API key may be invalid or expired.')
  })
})
