import { cloudflareConnectHref } from '@shared/operator'

export type CloudflareConnectResult = { ok: true; href: string } | { ok: false; error: string }

/** Build the Operator OAuth URL. Main opens it with shell.openExternal (https only). */
export function cloudflareConnectTarget(
  settings: { operatorUrl?: string } | null | undefined = {},
  env: Record<string, string | undefined> = process.env
): CloudflareConnectResult {
  const href = cloudflareConnectHref(settings, env)
  if (!href) return { ok: false, error: 'Operator URL must be https to open Cloudflare login.' }
  return { ok: true, href }
}
