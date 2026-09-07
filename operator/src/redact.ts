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

export const UPSTREAM_SNIPPET_CAP = 200
export const PROVIDER_REFUSED = 'provider refused the Operator key'

const AUTH_HEADER_RE = /authorization\s*[:=]\s*["']?[^"'\s,}\\]+/gi
const X_API_KEY_RE = /x-api-key\s*[:=]\s*["']?[^"'\s,}\\]+/gi
const BEARER_RE = /bearer\s+[a-z0-9._\-+/=]{8,}/gi
const BASIC_RE = /basic\s+[a-z0-9+/=]{8,}/gi
const PROMPT_KEYS = new Set([
  'messages',
  'prompt',
  'input',
  'content',
  'system',
  'authorization',
  'api_key',
  'apikey',
  'apiKey',
  'token',
  'secret',
  'password'
])

function scrubKnownSecrets(text: string, secrets: readonly string[]): string {
  let s = text
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue
    s = s.split(secret).join('[redacted]')
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret) s = s.split(encoded).join('[redacted]')
  }
  return s
}

function scrubAuthShapes(text: string): string {
  return text
    .replace(AUTH_HEADER_RE, 'authorization:[redacted]')
    .replace(X_API_KEY_RE, 'x-api-key:[redacted]')
    .replace(BEARER_RE, '[redacted]')
    .replace(BASIC_RE, '[redacted]')
}

function scrubTokenPatterns(text: string): string {
  let s = text
  for (const re of TOKEN_RE) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
    s = s.replace(new RegExp(re.source, flags), '[redacted]')
  }
  return s
}

function stripPromptFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPromptFields)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = PROMPT_KEYS.has(key) ? '[omitted]' : stripPromptFields(nested)
  }
  return out
}

function collectErrorBits(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  const parts: string[] = []
  if (typeof obj.error === 'string') parts.push(obj.error)
  if (obj.error && typeof obj.error === 'object') {
    const err = obj.error as Record<string, unknown>
    if (typeof err.message === 'string') parts.push(err.message)
    if (err.code != null) parts.push(String(err.code))
    if (typeof err.type === 'string') parts.push(err.type)
  }
  if (Array.isArray(obj.errors)) {
    for (const item of obj.errors.slice(0, 3)) {
      if (typeof item === 'string') parts.push(item)
      else if (item && typeof item === 'object') {
        const err = item as Record<string, unknown>
        if (typeof err.message === 'string') parts.push(err.message)
        if (err.code != null) parts.push(String(err.code))
      }
    }
  }
  if (typeof obj.message === 'string') parts.push(obj.message)
  return parts.length ? parts.join('; ') : null
}

/** Truncate + strip tokens, Authorization, and known secrets. Never a full prompt. */
export function redactUpstreamSnippet(text: string, secrets: readonly string[] = []): string {
  let s = scrubKnownSecrets(text, secrets)
  s = s.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
  s = scrubAuthShapes(s)
  s = scrubTokenPatterns(s)
  s = s.slice(0, UPSTREAM_SNIPPET_CAP)
  if (looksLikeSecret(s)) return '[redacted]'
  return s
}

export function upstreamDebugSnippet(raw: string, secrets: readonly string[] = []): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const bits = collectErrorBits(parsed)
    if (bits) return redactUpstreamSnippet(bits, secrets)
    return redactUpstreamSnippet(JSON.stringify(stripPromptFields(parsed)), secrets)
  } catch {
    return redactUpstreamSnippet(trimmed, secrets)
  }
}

export type ProviderRefusedPayload = {
  error: string
  upstreamStatus: number
  upstreamSnippet?: string
}

export function providerRefusedPayload(
  upstreamStatus: number,
  rawBody: string,
  secrets: readonly string[] = []
): ProviderRefusedPayload {
  const snippet = upstreamDebugSnippet(rawBody, secrets)
  const error = snippet ? `${PROVIDER_REFUSED} (upstream ${upstreamStatus}: ${snippet})` : PROVIDER_REFUSED
  const payload: ProviderRefusedPayload = snippet
    ? { error, upstreamStatus, upstreamSnippet: snippet }
    : { error, upstreamStatus }
  if (secrets.some((s) => s.length >= 4 && JSON.stringify(payload).includes(s))) {
    return { error: PROVIDER_REFUSED, upstreamStatus }
  }
  return payload
}
