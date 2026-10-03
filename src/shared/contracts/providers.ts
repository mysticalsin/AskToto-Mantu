import { z } from 'zod'
import type { ProviderId } from '../providers'

export const ProviderIdSchema = z.enum([
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
  'dust',
  'claude-cli',
  'codex-cli',
  'gemini',
  'cloudflare',
  'local',
  'custom'
])

// Compile-time parity guard: ProviderIdSchema (this enum) must match the ProviderId union in
// providers.ts exactly. If either side drifts, this assignment fails to typecheck.
type _ProviderIdEnum = z.infer<typeof ProviderIdSchema>
const _providerIdParity: ([_ProviderIdEnum] extends [ProviderId]
  ? [ProviderId] extends [_ProviderIdEnum]
    ? true
    : never
  : never) = true
void _providerIdParity
