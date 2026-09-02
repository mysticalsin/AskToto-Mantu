/**
 * OPERATOR.md Ask routing law (Tony 8:03).
 *
 * 1. Connected + working Claude CLI or Codex CLI is first for every user question.
 * 2. Operator-hosted API keys only after quota or rate limit from that CLI.
 * 3. Dust is retrieval only. Never a general-chat row.
 * 4. Both CLIs: last-clicked is primary, the other is next, then Operator keys.
 * 5. CLI kind stays `cli`. Tokens stay on the seat. Not vault rows.
 */

export const CLI_PROVIDER_IDS = ['claude-cli', 'codex-cli'] as const
export type CliProviderId = (typeof CLI_PROVIDER_IDS)[number]

export const DUST_RETRIEVAL_ONLY = true

export type AskRouteTier = 'cli' | 'operator' | 'fail'

export type AskRoute = {
  provider: string
  tier: AskRouteTier
}

export function isCliProviderId(id: string): id is CliProviderId {
  return id === 'claude-cli' || id === 'codex-cli'
}

export function isDustChatForbidden(provider: string, pinnedDust: boolean): boolean {
  return provider === 'dust' && !pinnedDust
}

/** Working CLIs in last-clicked order. Disconnected or allowlist-blocked CLIs are omitted. */
export function workingCliOrder(input: {
  cliConnected: Record<string, boolean | undefined>
  lastClickedCli?: string | null
  allowed?: string[] | null
}): CliProviderId[] {
  const working = CLI_PROVIDER_IDS.filter((id) => {
    if (!input.cliConnected[id]) return false
    if (input.allowed && !input.allowed.includes(id)) return false
    return true
  })
  if (working.length <= 1) return working
  const last = input.lastClickedCli
  if (last && isCliProviderId(last) && working.includes(last)) {
    return [last, ...working.filter((id) => id !== last)]
  }
  return working
}

export function pickWorkingCliPrimary(input: {
  cliConnected: Record<string, boolean | undefined>
  lastClickedCli?: string | null
  allowed?: string[] | null
}): CliProviderId | undefined {
  return workingCliOrder(input)[0]
}

/**
 * Next route for a user question.
 * `exhausted` is only quota / rate-limit (429, spent Pro or Max, Codex usage cap).
 * Transport blips and credential-reject are not exhaustion.
 */
export function nextAskRoute(input: {
  cliConnected: Record<string, boolean | undefined>
  lastClickedCli?: string | null
  allowed?: string[] | null
  exhausted?: Iterable<string>
  fundedProviders?: string[]
}): AskRoute {
  const exhausted = new Set(input.exhausted ?? [])
  for (const cli of workingCliOrder(input)) {
    if (!exhausted.has(cli)) return { provider: cli, tier: 'cli' }
  }
  const funded = (input.fundedProviders ?? []).filter(
    (p) => p && !isCliProviderId(p) && p !== 'dust' && p !== 'local' && p !== 'cloudflare-account'
  )
  const allowedFunded = input.allowed ? funded.filter((p) => input.allowed!.includes(p)) : funded
  if (allowedFunded[0]) return { provider: allowedFunded[0], tier: 'operator' }
  return { provider: '', tier: 'fail' }
}

export function dustIsGeneralChat(): false {
  return false
}
