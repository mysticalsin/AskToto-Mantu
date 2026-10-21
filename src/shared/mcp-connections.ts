import { z } from 'zod'

// ─── MCP connections (generalized from the single BidStack connection) ──────────────────────────────
// 'clickup' is a first-class connection: OAuth 2.1 + PKCE (clickupOAuth.ts, PR 73 loopback DCR) and
// post-meeting create-task (docs/design/CLICKUP-PUSH.md). The access token is a bearer key on
// mcpClient.ts like any other connection.
export const McpConnectionKindSchema = z.enum(['bidstack', 'clickup', 'plane'])
export type McpConnectionKind = z.infer<typeof McpConnectionKindSchema>

export const McpConnectionSchema = z.object({
  // v1 constraint: exactly one connection per kind, so id === kind. Kept as its own field (not derived)
  // because the id is what secrets/IPC key off — a future multi-workspace case (two Plane workspaces)
  // changes id generation without touching every call site that reads `kind`.
  // TYPED as the kind enum, not a free string: the id is interpolated into mcpSecrets.ts's
  // `key-mcp-<id>.bin`, so letting an arbitrary string reach it is a path-traversal primitive. Widening
  // this later is a deliberate change that must keep that filename safe (mcpSecrets.ts enforces it at
  // runtime too, for any caller that bypasses these types).
  id: McpConnectionKindSchema,
  kind: McpConnectionKindSchema,
  // Display name used in UI copy and classifyError() messages — replaces the hardcoded "Polo Pre-Sales"
  // string literal in mcpClient.ts. Defaults to a per-kind label (e.g. "Plane") but is user-editable.
  label: z.string().min(1).max(60),
  endpointUrl: z.string().default(''),
  connected: z.boolean().default(false),
  tools: z.array(z.string()).default([]),
  // Transport-level extra headers beyond `Authorization: Bearer <key>` — Plane's hosted PAT endpoint
  // requires `X-Workspace-slug` alongside the bearer token. Generic (not `planeWorkspaceSlug`) because
  // it's a mechanical transport concern, not a Plane-specific business field, and BidStack already
  // proves the "zero extra headers" case — two real shapes justify the generalization.
  extraHeaders: z.record(z.string(), z.string()).default({}),
  // ClickUp last-successful list (main-owned; renderer cannot patch mcpConnections). Empty until
  // Connect discovers one or a create-task lands. See docs/design/CLICKUP-PUSH.md.
  clickupListId: z.string().max(40).optional(),
  clickupListName: z.string().max(120).optional()
})
export type McpConnection = z.infer<typeof McpConnectionSchema>

// ─── MCP connections (CRM push + "Book next steps") ────────────────────────
// Generalized from the single BidStack-only mcpCrm:* IPC channels. `connectionId` identifies WHICH
// mcpConnections entry a call targets (id === kind in v1 — see McpConnectionSchema); main looks the
// connection up in settings.mcpConnections rather than trusting an endpoint/key the renderer hands it,
// same defense-in-depth as the old single-connection handlers.

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
