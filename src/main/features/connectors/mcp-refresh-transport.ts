import type { McpConnection } from '@shared/mcp-connections'
import { refreshClickupToken, releaseClickupTokenLock, tryAcquireClickupTokenLock } from '../../mcp/clickupOAuth'
import { getMcpApiKey, getMcpRefreshToken, setMcpApiKey, setMcpRefreshToken } from '../../mcp/mcpSecrets'
import { refreshPlaneToken, releasePlaneTokenLock, tryAcquirePlaneTokenLock } from '../../mcp/planeOAuth'
import { pushTransport, type McpTransport } from './mcp-call-runtime'

/**
 * The transport for a saved MCP connection (moved from the `mcp:push` handler, G64). One call, and for ClickUp/Plane
 * exactly one refresh-and-retry: their credential is an OAuth access token, so a 401 can mean it simply expired. The
 * retry runs inside this closure, so it reuses the approval the confirm card already gave. It is gated on the SAME
 * single-flight lock the interactive OAuth flow uses so a background refresh and a user-initiated Reconnect can
 * never both persist tokens at once.
 */
export function createMcpPushTransport(
  conn: Pick<McpConnection, 'id' | 'kind' | 'endpointUrl' | 'extraHeaders' | 'label'>
): McpTransport {
  return async (toolName, args, idempotencyKey) => {
    const send = (key: string): ReturnType<ReturnType<typeof pushTransport>> =>
      pushTransport(conn.endpointUrl, key, conn.extraHeaders, conn.label)(toolName, args, idempotencyKey)
    let r = await send(getMcpApiKey(conn.id))
    if (
      !r.ok &&
      (conn.kind === 'clickup' || conn.kind === 'plane') &&
      /401|403|unauthor|forbidden/i.test(r.error || '')
    ) {
      const acquire = conn.kind === 'clickup' ? tryAcquireClickupTokenLock : tryAcquirePlaneTokenLock
      const release = conn.kind === 'clickup' ? releaseClickupTokenLock : releasePlaneTokenLock
      const refresh = conn.kind === 'clickup' ? refreshClickupToken : refreshPlaneToken
      const product = conn.kind === 'clickup' ? 'ClickUp' : 'Plane'
      if (acquire()) {
        try {
          const refreshToken = getMcpRefreshToken(conn.id)
          const refreshed = refreshToken ? await refresh(refreshToken) : { ok: false as const }
          if (refreshed.ok && refreshed.accessToken) {
            setMcpApiKey(conn.id, refreshed.accessToken)
            setMcpRefreshToken(conn.id, refreshed.refreshToken ?? refreshToken ?? '')
            r = await send(refreshed.accessToken)
          } else {
            r = { ok: false, error: `Your ${product} session expired. Reconnect ${product} in Settings.` }
          }
        } finally {
          release()
        }
      } else {
        r = { ok: false, error: `A ${product} sign-in or refresh is already in progress. Try again in a moment.` }
      }
    }
    return r
  }
}
