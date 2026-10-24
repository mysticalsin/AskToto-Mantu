import { withMcpClient } from '../../mcp/mcpClient'
import type { CustomMcpWire } from './custom-mcp-service'

const LIST_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 30_000

/** Production wire: the shared MCP session (redirects refused, DNS pinned, bounded) plus the per-address policy guard. */
export function createHttpsWire(): CustomMcpWire {
  return {
    async listTools(target) {
      return withMcpClient(
        target.url,
        target.headers,
        LIST_TIMEOUT_MS,
        async (client, opts) => (await client.listTools(undefined, opts)).tools,
        { addressGuard: target.guard }
      )
    },
    async callTool(target, name, args) {
      return withMcpClient(
        target.url,
        target.headers,
        CALL_TIMEOUT_MS,
        async (client, opts) => {
          // Only the two fields the service reads cross this seam.
          const result = (await client.callTool({ name, arguments: args }, undefined, opts)) as {
            isError?: boolean
            content?: unknown
          }
          return { isError: result.isError === true, content: result.content }
        },
        { addressGuard: target.guard }
      )
    }
  }
}
