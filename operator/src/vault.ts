/** Vault allowlist, last4, and payload encoding. Never log a secret. */

export const VAULT_LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'nvidia',
  'deepseek',
  'minimax',
  'qwen',
  'kimi',
  'openrouter',
  'groq',
  'mistral',
  'grok',
  'cloudflare',
  'custom'
] as const

export const FORBIDDEN_VAULT_PROVIDERS = ['claude-cli', 'codex-cli', 'dust', 'local'] as const

export const CF_ACCOUNT_PROVIDER = 'cloudflare-account'
export const OPERATOR_WORKER = 'metis-operator'
export const OPERATOR_D1_ID = '8eb5a081-594c-407c-9470-6a5aa28b9f7c'
export const OPERATOR_D1_NAME = 'metis-operator'

export type VaultLlmProvider = (typeof VAULT_LLM_PROVIDERS)[number]

const LLM = new Set<string>(VAULT_LLM_PROVIDERS)
const FORBIDDEN = new Set<string>(FORBIDDEN_VAULT_PROVIDERS)

export function isForbiddenVaultProvider(id: string): boolean {
  return FORBIDDEN.has(id)
}

export function isVaultLlmProvider(id: string): boolean {
  return LLM.has(id)
}

export function isVaultProvider(id: string): boolean {
  return id === CF_ACCOUNT_PROVIDER || LLM.has(id)
}

/** Last four characters of a secret for UI and audit. Never the full secret. */
export function last4OfSecret(secret: string): string {
  const trimmed = secret.trim()
  const alnum = trimmed.replace(/[^a-zA-Z0-9]/g, '')
  const src = alnum.length >= 4 ? alnum : trimmed
  if (src.length < 2) return '----'
  return src.slice(-4)
}

export function encodeVaultPlaintext(secret: string, accountId?: string): string {
  if (accountId) return JSON.stringify({ secret, accountId })
  return secret
}

export function decodeVaultPlaintext(plain: string): { secret: string; accountId?: string } {
  const trimmed = plain.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { secret?: unknown; accountId?: unknown }
      if (typeof parsed.secret === 'string' && parsed.secret) {
        return {
          secret: parsed.secret,
          accountId: typeof parsed.accountId === 'string' ? parsed.accountId : undefined
        }
      }
    } catch {
      /* fall through — treat as raw secret */
    }
  }
  return { secret: trimmed }
}

export function fundedProvidersFromMeta(
  rows: { provider: string; status: string }[]
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.status !== 'active') continue
    if (!isVaultLlmProvider(row.provider)) continue
    if (seen.has(row.provider)) continue
    seen.add(row.provider)
    out.push(row.provider)
  }
  return out
}
