/**
 * Operator-hosted LLM keys live on the Worker (env secrets). Heartbeat advertises IDs only.
 * Never CLI tokens, Dust, local, or a Cloudflare account token.
 */

export const OPERATOR_HOSTED_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  kimi: 'KIMI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  grok: 'XAI_API_KEY',
  gemini: 'GEMINI_API_KEY'
}

const FORBIDDEN = new Set([
  'dust',
  'local',
  'claude-cli',
  'codex-cli',
  'cloudflare-account',
  'cloudflare',
  'custom'
])

export function fundedProvidersFromEnv(env: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [id, name] of Object.entries(OPERATOR_HOSTED_ENV)) {
    if (FORBIDDEN.has(id)) continue
    const value = env[name]
    if (typeof value === 'string' && value.trim().length > 0) out.push(id)
  }
  return out
}

export function operatorHostedKey(env: Record<string, unknown>, provider: string): string {
  if (FORBIDDEN.has(provider)) return ''
  const name = OPERATOR_HOSTED_ENV[provider]
  if (!name) return ''
  const value = env[name]
  return typeof value === 'string' ? value.trim() : ''
}
