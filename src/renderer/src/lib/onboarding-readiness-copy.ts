import { PROVIDERS, filterAllowedProviders, type ProviderId } from '@shared/providers'

/** Setup can finish for transcription alone; AI-dependent features must be described separately. */
export function onboardingReadinessCopy(
  asrReady: boolean,
  aiReady: boolean
): {
  title: string
  aiHint: string
  aiAction: string
} {
  return {
    title: !asrReady ? 'Finishing your setup…' : aiReady ? 'You’re all set.' : 'Transcription is ready.',
    aiHint: aiReady
      ? 'Your AI connection is configured. You can change it anytime in Settings.'
      : 'For automatic summaries and answers, connect AI in Settings. You can start with transcription only.',
    aiAction: aiReady ? 'Manage AI connection (optional)' : 'Set up AI for summaries and answers'
  }
}

/** Why a step-5 provider tile can't be tapped right now, or `null` if it can. Kept as a discriminated
 *  reason (not a plain boolean) so ProviderOption can show copy that matches what's actually true —
 *  'org' is a genuine managed-config/data-residency lock, 'busy' is only ever a transient in-flight
 *  probe (currently just the CLI tile's zero-token cliDetect/cliTest). Conflating the two previously made
 *  every tile read as org-restricted for the whole time the CLI tile alone was busy. */
export type ProviderTileDisabledReason = 'org' | 'busy' | null

/** Pure so it's unit-testable without a render harness (Onboarding.tsx has none). `busy` only ever
 *  applies to the CLI tile — the API-key and Mantu Dust tiles never pass it, so they can't be disabled
 *  by another tile's in-flight probe. */
export function providerTileDisabledReason(opts: {
  providerLocked: boolean
  pathAllowed: boolean
  busy?: boolean
}): ProviderTileDisabledReason {
  if (opts.providerLocked || !opts.pathAllowed) return 'org'
  if (opts.busy) return 'busy'
  return null
}

/** The API-key providers step 5's picker can route to, in preference order. One source for the tile
 *  grid, the "An API key" tile's enabled state, and the "Something else" escape hatch, so all three
 *  answer to the same org allowlist. */
export const API_KEY_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'nvidia', 'minimax']

/** Where step 5's "Something else (DeepSeek, Qwen, Mistral, and more). Pick it in Settings" link lands.
 *  It used to be the literal 'anthropic', which walked straight past the data-residency allowlist the
 *  tile grid directly above it filters on — under an allowlist that omits Anthropic the link finished
 *  onboarding on a provider main rejects on every ask. `null` = the org approves no API-key provider at
 *  all, in which case the link must not render (the tile that opens this picker is already inert). */
export function apiPickerFallbackProvider(allowed: string[] | null | undefined): ProviderId | null {
  return filterAllowedProviders(API_KEY_PROVIDERS, allowed)[0] ?? null
}

/** Copy for step 6's provider readiness row. Dust needs its own branch: it's a one-click OAuth/CLI
 *  flow with no key to paste, so the generic API-key wording sends the user hunting for a key this
 *  path never asks for. */
export function providerReadyCopy(
  provider: ProviderId,
  /** MQA-263: true when this install already holds a working key it never asked the user for — the
   *  installer-embedded Cloudflare key. Without it the generic branch below tells someone to "add your
   *  key" for a key that shipped with the app and that they were never given a copy of. */
  opts?: { alreadyConnected?: boolean }
): { label: string; hint: string } {
  const p = PROVIDERS[provider]
  const label = p?.label ?? 'AI provider'
  if (opts?.alreadyConnected) return { label: `${label} connected`, hint: 'already set up, nothing to paste' }
  if (p?.kind === 'cli') return { label: `${label} connected`, hint: 'connect it to get live answers' }
  if (p?.kind === 'dust')
    return { label: `${label} connected`, hint: 'finish the one-click sign-in to get live answers' }
  return { label: `${label} API key`, hint: 'add your key to get live answers' }
}
