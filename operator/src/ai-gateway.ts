/** Create the account `default` AI Gateway if it is missing. Ask/use send `cf-aig-gateway-id: default`. */

export const DEFAULT_AI_GATEWAY_ID = 'default'
const ENSURE_TIMEOUT_MS = 8_000

export async function ensureDefaultAiGateway(
  token: string,
  accountId: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const id = accountId.trim()
  const secret = token.trim()
  if (!id || !secret) return
  try {
    await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(id)}/ai-gateway/gateways`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: DEFAULT_AI_GATEWAY_ID, name: DEFAULT_AI_GATEWAY_ID }),
      signal: AbortSignal.timeout(ENSURE_TIMEOUT_MS)
    })
  } catch {
    /* missing gateway is retried on the next paste or Ask; never fail the vault write */
  }
}

export function isCloudflareVaultPaste(provider: string, accountId: string | undefined): boolean {
  return provider === 'cloudflare' && Boolean(accountId?.trim())
}
