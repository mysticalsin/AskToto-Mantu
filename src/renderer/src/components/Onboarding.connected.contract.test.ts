import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(__dirname, 'Onboarding.tsx'), 'utf8')

/**
 * MQA-263 — step 5 demanded setup that was already done, and named the wrong provider doing it.
 *
 * When the installer ships an embedded Cloudflare key, main seeds it on first launch and
 * `providerReady` is true before the user touches anything. Step 5 still opened with "To get live
 * answers, pick one way to connect the AI" and listed Claude Code / an API key / Mantu Dust, with an
 * escape hatch reading "Something else (DeepSeek, Qwen, Mistral, and more)".
 *
 * Cloudflare — the provider actually answering — appeared nowhere. A user whose install already worked
 * was being told to go and sign up for DeepSeek.
 *
 * Pinned as source text because step 5 is a branch inside one large component with no injectable seam,
 * the same approach provider-health-ux.contract.test.ts uses for index.ts.
 */
describe('MQA-263 — onboarding must not ask for setup that already happened', () => {
  it('branches step 5 on whether a provider is already ready', () => {
    expect(SRC).toMatch(/const alreadyConnected = settings\.providerReady && !providerLocked/)
  })

  it('leads with "ready", not "pick one way to connect", when it is', () => {
    expect(SRC).toMatch(/alreadyConnected \? 'Métis is ready to answer' : 'How should Métis answer you\?'/)
    // The demand copy must survive for the case where it is TRUE — an unconfigured install still needs it.
    expect(SRC).toMatch(/To get live answers, pick one way to\s*\n?\s*connect the AI/)
  })

  it('names the provider that is actually configured, rather than a generic one', () => {
    // The whole defect was naming providers the user does not have while ignoring the one they do.
    expect(SRC).toMatch(/PROVIDERS\[settings\.provider\]\?\.label/)
    expect(SRC).toMatch(/there is no key to paste and nothing to sign up for/)
  })

  it('does not tell a connected user to "decide later"', () => {
    // "Decide later" implies nothing works yet. When it already does, that is simply false.
    expect(SRC).toMatch(/Keep \{PROVIDERS\[settings\.provider\]\?\.label \?\? 'the built-in provider'\} and continue/)
  })

  it('keeps the other providers reachable — switching is still legitimate', () => {
    // The fix is about not DEMANDING setup, not about hiding the alternatives.
    expect(SRC).toMatch(/Something else \(DeepSeek, Qwen, Mistral, and more\)/)
    expect(SRC).toMatch(/title="Mantu Dust"/)
  })

  it('passes readiness into the step 6 row so it stops asking for a shipped key', () => {
    expect(SRC).toMatch(
      /providerReadyCopy\(settings\.provider, \{ alreadyConnected: settings\.providerReady \}\)/
    )
  })

  it('respects a managed provider lock — a locked install is not "choose your own"', () => {
    // providerLocked means main drops the pick, so offering alternatives would be a lie either way.
    expect(SRC).toMatch(/settings\.providerReady && !providerLocked/)
  })
})
