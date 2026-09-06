/** Token-shaped strings must never reach Events HTML. Fail tests if one renders. */

const SECRET_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'authorization',
  'bearer',
  'secret',
  'hmac',
  'signature',
  'sig',
  'password',
  'prompt_cipher',
  'prompt_iv',
  'cipher',
  'iv',
  'private_key',
  'signed',
  'operator_ingest_secret',
  'operator_prompt_key',
  'operator_skill_private_key'
])

const TOKEN_RE = [
  /bearer\s+[a-z0-9._\-+/=]{8,}/i,
  /\bsk-[a-z0-9_-]{10,}/i,
  /\bsk-ant-[a-z0-9_-]{8,}/i,
  /\bsk-proj-[a-z0-9_-]{8,}/i,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b[a-f0-9]{64}\b/i,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/
]

export function looksLikeSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const s = value.trim()
  if (!s) return false
  if (SECRET_KEYS.has(s.toLowerCase())) return true
  return TOKEN_RE.some((re) => re.test(s))
}

export function secretKeyName(key: string): boolean {
  const k = key.trim().toLowerCase().replace(/[\s-]/g, '_')
  return SECRET_KEYS.has(k) || k.endsWith('_token') || k.endsWith('_secret') || k.endsWith('_key')
}

export type SafeChip = { key: string; value: string }

export function safeChips(props: Record<string, unknown> | null | undefined): SafeChip[] {
  if (!props) return []
  const out: SafeChip[] = []
  for (const [key, raw] of Object.entries(props)) {
    if (raw == null || raw === '') continue
    if (secretKeyName(key)) continue
    const value = String(raw).trim()
    if (!value || looksLikeSecret(value) || looksLikeSecret(key)) continue
    out.push({ key: key.slice(0, 24), value: value.slice(0, 48) })
  }
  return out
}

export function tokenPatternForTests(): RegExp {
  return /bearer\s+[a-z0-9._\-+/=]{8,}|\bsk-[a-z0-9_-]{10,}|\bsk-ant-|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|[a-f0-9]{64}|[A-Za-z0-9+/]{40,}={0,2}/i
}
