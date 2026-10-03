import { z } from 'zod'
import { McpConnectionKindSchema } from './connection'

export const McpTestConnectionPayloadSchema = z.object({
  connectionId: McpConnectionKindSchema,
  endpointUrl: z.string().min(1, 'Enter the MCP endpoint URL.'),
  apiKey: z.string().min(1, 'Enter the API key.'),
  extraHeaders: z.record(z.string(), z.string()).default({})
})
export type McpTestConnectionPayload = z.infer<typeof McpTestConnectionPayloadSchema>

export const McpSaveConnectionPayloadSchema = McpTestConnectionPayloadSchema.extend({
  label: z.string().min(1, 'Name this connection.').max(60)
})
export type McpSaveConnectionPayload = z.infer<typeof McpSaveConnectionPayloadSchema>

// connectionId is the KIND enum, never a free string: main feeds it straight into
// mcpSecrets.ts's `key-mcp-<id>.bin` path, so an unconstrained value ('../../secret-key') would let a
// compromised renderer rmSync an arbitrary .bin — including secret-key.bin, the AES file key that every
// stored provider credential is encrypted under. mcpSecrets.ts rejects such an id on its own too; this
// is the outer half of that pair. v1 keeps id === kind (see McpConnectionSchema).
export const McpDisconnectPayloadSchema = z.object({
  connectionId: McpConnectionKindSchema
})
export type McpDisconnectPayload = z.infer<typeof McpDisconnectPayloadSchema>

// Push args are always a small, flat object built by Review.tsx (title/date/summary strings, or a task
// title/description) — bound the shape so a tampered/buggy caller can't hand the MCP tool call an
// unbounded or deeply-nested payload.
const McpArgValueSchema = z.union([z.string().max(50_000), z.number(), z.boolean(), z.null()])
export const McpPushPayloadSchema = z.object({
  connectionId: McpConnectionKindSchema,
  toolName: z.string().min(1, 'Choose an MCP tool to push to.'),
  args: z
    .record(z.string(), McpArgValueSchema)
    .refine((a) => Object.keys(a).length <= 20, { message: 'Too many fields in the push payload.' }),
  /** Basename of the saved meeting markdown — main re-reads frontmatter for confidential (never trust UI alone). */
  meetingFile: z.string().min(1).max(260).optional()
})
export type McpPushPayload = z.infer<typeof McpPushPayloadSchema>

/** Result of testing or saving an MCP connection — mirrors the SDK's listTools() discovery. */
export interface McpConnectResult {
  ok: boolean
  error?: string
  tools?: string[]
  clickupListId?: string
  clickupListName?: string
}

/** Result of pushing to an MCP tool. */
export interface McpPushResult {
  ok: boolean
  error?: string
  result?: unknown
  destinationName?: string
  taskUrl?: string
}
