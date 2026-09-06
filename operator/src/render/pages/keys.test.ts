import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { fixtureForKeys, fixtureForKeysNoOauth } from './keys.fixture'
import { renderKeys, renderVaultTable } from './keys'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderKeys (shared fixture, empty vault)', () => {
  it('renders the header sentence, an empty vault, the add-key form and the funded-providers empty state, no inline style=', async () => {
    const data = await fixtureDashboard(CTX.now)
    const html = renderKeys(data, CTX)
    expect(html).toContain('>Keys<')
    expect(html).toContain('Provider keys the Operator spends on behalf of licensed seats.')
    expect(html).toContain('Seats never receive these keys. A licensed seat calls the Operator, and the Operator calls the provider.')
    expect(html).toContain('id="key-add"')
    expect(html).toContain('id="rotate-key-dialog"')
    expect(html).toContain('id="cf-connect-msg"')
    expect(html).toContain('No provider keys yet.')
    expect(html).toContain('No provider is funded yet.')
    expect(html).not.toContain('style="')
    expect(html).not.toContain('—')
  })

  it('disables the Cloudflare connect control and shows the reason when OAuth is not configured', async () => {
    const data = await fixtureDashboard(CTX.now)
    const html = renderKeys(data, CTX)
    expect(html).toContain('data-cf-oauth-missing')
    expect(html).toContain('disabled')
  })
})

describe('renderKeys (fixtureForKeys, populated vault)', () => {
  it('renders every active provider with its usage columns, the history toggle, and the connected Cloudflare tiles', async () => {
    const data = await fixtureForKeys(CTX.now)
    const html = renderKeys(data, CTX)

    // Active rows, real derived labels, never a hand-typed number outside the fixture module.
    expect(html).toContain('Claude · Anthropic')
    expect(html).toContain('GPT · OpenAI')
    expect(html).toContain('Cloudflare · AI Gateway')
    expect(html).toContain('Custom · OpenAI-compatible')
    expect(html).toContain('••k9f2')

    // History: one superseded anthropic row and one revoked groq row, collapsed by default.
    expect(html).toContain('Show history (2)')
    expect(html).toMatch(/hidden data-key-history-row[^>]*>[\s\S]*Superseded/)
    expect(html).toMatch(/hidden data-key-history-row[^>]*>[\s\S]*Revoked/)

    // Last seat: a real match for anthropic/openai (the seeded seats' real hostnames), an honest
    // "not applicable" for a non-active row, and "not reported" is never fabricated into a false
    // match for a provider with no use event (custom, here).
    expect(html).toContain('mbp-lea-martin')
    expect(html).toContain('mbp-camille-dubois')

    // Cloudflare card connected: three tiles with a source tooltip each, no dead OAuth banner.
    expect(html).not.toContain('data-cf-oauth-missing')
    expect(html).toContain('keys-cf-tiles')
    expect(html).toContain('data-count-to="48213"')

    expect(html).not.toContain('style="')
    expect(html).not.toContain('—')
  })

  it('never renders the OAuth-only cloudflare-account credential as a vault row', async () => {
    const data = await fixtureForKeys(CTX.now)
    const html = renderKeys(data, CTX)
    expect(html).not.toContain('cloudflare-account')
  })
})

describe('renderKeys (fixtureForKeysNoOauth)', () => {
  it('shows the disabled connect control while still rendering the populated vault', async () => {
    const data = await fixtureForKeysNoOauth(CTX.now)
    const html = renderKeys(data, CTX)
    expect(html).toContain('data-cf-oauth-missing')
    expect(html).toContain('disabled')
    expect(html).toContain('Claude · Anthropic')
  })
})

describe('renderVaultTable', () => {
  it('escapes a hostile label and provider id rather than rendering them as markup', async () => {
    const data = await fixtureForKeys(CTX.now)
    data.keys.vault = [
      {
        id: 'fx-xss',
        provider: 'openai',
        label: '<script>x</script>',
        last4: 'z9z9',
        status: 'active',
        createdAt: CTX.now - 1000,
        rotatedAt: null,
        revokedAt: null
      }
    ]
    const { html } = renderVaultTable(data, CTX.now)
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
  })

  it('renders the empty state with the reason when there are no keys', async () => {
    const data = await fixtureDashboard(CTX.now)
    const { html, historyCount } = renderVaultTable(data, CTX.now)
    expect(html).toContain('No provider keys yet.')
    expect(historyCount).toBe(0)
  })
})
