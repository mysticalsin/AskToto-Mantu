/**
 * ai-section-labels.ts — two pure label helpers moved out of AiSection.tsx unchanged so the section stays under its
 * size ceiling: the routed-model name in the thinking-mode explainer, and the phrase for a demoted provider.
 */
import { formatResetPhrase } from '@shared/reset-time'
import type { ProviderId } from '@shared/providers'

/** Friendly name for a routed model in the thinking-mode explainer. */
export function prettyModel(m: string, provider: ProviderId, tier: 'base' | 'think' | 'deep'): string {
  if (provider === 'dust') {
    // Dust has no distinct deep agent; deep shares the thinking caption.
    return tier === 'base' ? 'your base agent' : 'your thinking agent'
  }
  if (m) {
    if (/haiku/i.test(m)) return 'Haiku'
    if (/sonnet/i.test(m)) return 'Sonnet'
    if (/opus/i.test(m)) return 'Opus'
    if (/gpt-4o|gpt-4\.1|gpt-5/i.test(m)) return 'GPT'
  }
  return tier === 'think' ? 'the deeper model' : 'the fast model'
}

/** Human phrase for a currently-demoted provider, from its cooldown reason + reset instant. */
export function providerLimitLabel(u: { reason: string; until: number }): string {
  const mins = Math.max(0, Math.round((u.until - Date.now()) / 60000))
  const when = mins >= 60 ? formatResetPhrase(u.until) : mins >= 1 ? `retry in ${mins}m` : 'retry shortly'
  switch (u.reason) {
    case 'rate-limit':
      return `rate-limited, ${when}`
    case 'quota-exhausted':
      return 'out of credit. Add credit or switch providers'
    case 'usage-cap':
      return `usage limit reached, ${when}`
    default:
      return 'key rejected. Re-enter it below'
  }
}
