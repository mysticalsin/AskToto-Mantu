import { z } from 'zod'

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
export type ProviderId = z.infer<typeof ProviderIdSchema>
