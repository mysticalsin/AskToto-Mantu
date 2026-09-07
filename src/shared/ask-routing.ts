/**
 * OPERATOR.md Ask routing law (Tony 8:03 / 10:14pm).
 *
 * 1. Connected + working Claude CLI or Codex CLI is first for every user question.
 * 2. Operator-hosted API keys only after quota or rate limit from that CLI.
 * 3. Dust is retrieval only. Never a general-chat row.
 * 4. Both CLIs: last-clicked is primary, the other is next, then Operator keys.
 * 5. CLI kind stays `cli`. Tokens stay on the seat. Not vault rows.
 * 6. Seats never store raw LLM keys. Heartbeat fundedProviders are IDs only.
 */

export const CLI_PROVIDER_IDS = ['claude-cli', 'codex-cli'] as const
export type CliProviderId = (typeof CLI_PROVIDER_IDS)[number]

/** Provider IDs Operator may host. IDs only — never a raw key, CLI token, Dust, or local. */
export const OPERATOR_HOSTED_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'nvidia',
  'deepseek',
  'qwen',
  'minimax',
  'kimi',
  'openrouter',
  'groq',
  'mistral',
  'grok',
  'gemini',
  'cloudflare'
] as const

/** Portal-funded CF path (FRAME G8). Bare `@cf/…` only — never `workers-ai/`. */
export const PORTAL_CF_DEEPSEEK_FLASH = '@cf/deepseek-ai/deepseek-v4-flash-0731'
export const PORTAL_CF_DEEPSEEK_PRO = '@cf/deepseek-ai/deepseek-v4-pro-0813'

/**
 * Portal-funded CF model (Ultron/Tony G8 lock):
 * 1. Everyday Ask default = Flash (`@cf/deepseek-ai/deepseek-v4-flash-0731`).
 * 2. Optional deep path only (never default) = Pro (`@cf/deepseek-ai/deepseek-v4-pro-0813`).
 * portal-direct `deepseek` / api.deepseek.com is cost-compare only — not this default.
 */
export function portalFundedCloudflareModel(tier?: string): string {
  if (tier === 'deep') return PORTAL_CF_DEEPSEEK_PRO
  return PORTAL_CF_DEEPSEEK_FLASH
}

/**
 * Pin Portal-funded CF onto the locked catalogue.
 * Everyday / think / base → Flash. Deep tier may keep Pro. Everything else → Flash.
 */
export function resolvePortalCloudflareModel(requested: string, tier = 'base'): string {
  const model = requested.trim()
  if (tier === 'deep' && model === PORTAL_CF_DEEPSEEK_PRO) return PORTAL_CF_DEEPSEEK_PRO
  if (model === PORTAL_CF_DEEPSEEK_FLASH) return PORTAL_CF_DEEPSEEK_FLASH
  return portalFundedCloudflareModel(tier)
}
export type OperatorHostedProviderId = (typeof OPERATOR_HOSTED_PROVIDER_IDS)[number]

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

/** IDs heartbeat may advertise as Operator-hosted. Never CLI tokens, Dust, local, or a Cloudflare account. */
export function isOperatorHostedProviderId(id: string): id is OperatorHostedProviderId {
  return (OPERATOR_HOSTED_PROVIDER_IDS as readonly string[]).includes(id)
}

export function filterFundedProviders(ids: Iterable<string>): string[] {
  return [...new Set([...ids].filter((id) => typeof id === 'string' && isOperatorHostedProviderId(id)))]
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

export function nextLastClickedCli(
  last: string | null | undefined,
  retired: string,
  connected: Record<string, boolean | undefined>
): CliProviderId | null {
  return (
    pickWorkingCliPrimary({
      cliConnected: { ...connected, [retired]: false },
      lastClickedCli: last === retired ? null : last
    }) ?? null
  )
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
  const funded = filterFundedProviders(input.fundedProviders ?? [])
  const allowedFunded = input.allowed ? funded.filter((p) => input.allowed!.includes(p)) : funded
  // Everyday Operator Ask prefers portal-cf. portal-direct DeepSeek is cost-compare only.
  const everyday =
    allowedFunded.includes('cloudflare')
      ? ['cloudflare', ...allowedFunded.filter((p) => p !== 'cloudflare' && p !== 'deepseek')]
      : allowedFunded
  if (everyday[0]) return { provider: everyday[0], tier: 'operator' }
  return { provider: '', tier: 'fail' }
}

export function dustIsGeneralChat(): false {
  return false
}
