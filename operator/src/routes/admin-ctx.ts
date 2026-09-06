/**
 * Types and helpers shared by every admin route module. `Env` and `HandleOpts` live here (not in
 * `index.ts`) so a route module can build `AdminCtx` without importing `index.ts` and creating a
 * cycle (`index.ts` imports `./routes` which imports the feature modules which need these types).
 * `index.ts` imports both back and re-exports them for callers that already do
 * `import { type Env } from './index'` (every test file).
 */
import type { CfGeo } from '../geo'
import type { AccessCtx } from '../access'
import type { D1DatabaseLike } from '../d1'
import type { OperatorStore } from '../store'
import { missingCloudflareOverview, pullCloudflareOverview, type CloudflareOverview } from '../cloudflare'
import { activeCloudflareAccount } from '../keys'
import { looksLikeSecret } from '../redact'

export interface Env {
  DB?: D1DatabaseLike
  /** Workers Static Assets binding (plan D5, B8): fonts, flags and connector logos. */
  ASSETS?: { fetch(request: Request): Promise<Response> }
  OPERATOR_INGEST_SECRET: string
  OPERATOR_PROMPT_KEY: string
  OPERATOR_SKILL_PRIVATE_KEY: string
  OPERATOR_SKILL_PUBLIC_KEY?: string
  OPERATOR_VAULT_KEY?: string
  OPERATOR_SESSION_SECRET?: string
  OPERATOR_VERSION?: string
  OPERATOR_BUILT_AT?: string
  OPERATOR_ENV?: string
  TEAM_DOMAIN?: string
  POLICY_AUD?: string
  CF_OAUTH_CLIENT_ID?: string
  CF_OAUTH_CLIENT_SECRET?: string
  CF_OAUTH_AUTHORIZE_URL?: string
  CF_OAUTH_TOKEN_URL?: string
  CF_OAUTH_SCOPES?: string
  CF_ACCOUNT_ID?: string
}

export interface HandleOpts {
  store?: OperatorStore
  now?: number
  access?: AccessCtx['access']
  geo?: CfGeo
  cfFetch?: typeof fetch
  providerFetch?: typeof fetch
}

export type AdminCtx = {
  request: Request
  url: URL
  env: Env
  store: OperatorStore
  email: string
  now: number
  opts: HandleOpts
}

export function param(match: { params: Record<string, string> }, name: string): string {
  return decodeURIComponent(match.params[name] ?? '')
}

export function auditMeta(ctx: AdminCtx): { requestId?: string; route: string } {
  return { requestId: ctx.request.headers.get('cf-ray') || undefined, route: ctx.url.pathname }
}

export async function auditLog(ctx: AdminCtx, action: string, askId: string | null, detail: string): Promise<void> {
  await ctx.store.audit(crypto.randomUUID(), ctx.now, ctx.email, action, askId, detail, auditMeta(ctx))
}

/** Every audit `detail` string is free-standing text shown verbatim in the console: a group name, a
 *  note, a member email or a device id interpolated into it must never carry a newline (log/UI
 *  injection), a control character, or a secret-shaped substring a user or a seat could plant there.
 *  Strips `\r`/`\n`/`\t` and other control characters to spaces, trims, caps length, and redacts the
 *  whole value outright when `looksLikeSecret` matches any part of it (checked pre-strip, so a token
 *  is not saved from detection by the characters around it being cleaned first). */
export function safeAuditText(raw: string, max = 160): string {
  if (looksLikeSecret(raw)) return '[redacted]'
  return raw
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, max)
}

export function keyFlags(env: Env): {
  ingestBound: boolean
  promptBound: boolean
  skillBound: boolean
  vaultBound: boolean
  oauthBound: boolean
} {
  return {
    ingestBound: Boolean(env.OPERATOR_INGEST_SECRET),
    promptBound: Boolean(env.OPERATOR_PROMPT_KEY),
    skillBound: Boolean(env.OPERATOR_SKILL_PRIVATE_KEY),
    vaultBound: Boolean(env.OPERATOR_VAULT_KEY),
    oauthBound: Boolean((env.CF_OAUTH_CLIENT_ID || '').trim() && (env.CF_OAUTH_CLIENT_SECRET || '').trim())
  }
}

export async function cloudflareForDashboard(
  store: OperatorStore,
  env: Env,
  opts: HandleOpts,
  now: number
): Promise<CloudflareOverview> {
  const creds = await activeCloudflareAccount(store, env.OPERATOR_VAULT_KEY)
  if (!creds) return missingCloudflareOverview()
  try {
    return await pullCloudflareOverview({
      accountId: creds.accountId,
      token: creds.token,
      now,
      fetchImpl: opts.cfFetch
    })
  } catch {
    return { ...missingCloudflareOverview(), connected: true, error: 'Cloudflare pull failed.' }
  }
}

/** Strips ciphertext, IVs, decrypted text and anything else that must never leave the Worker,
 *  regardless of which route builds the payload. */
export function stripSecrets<T>(data: T): T {
  return JSON.parse(
    JSON.stringify(data, (key, value) => {
      if (
        key === 'prompt_cipher' ||
        key === 'prompt_iv' ||
        key === 'question' ||
        key === 'ip' ||
        key === 'cipher' ||
        key === 'iv' ||
        key === 'secret' ||
        key === 'token' ||
        key === 'grant'
      ) {
        return undefined
      }
      return value
    })
  ) as T
}
