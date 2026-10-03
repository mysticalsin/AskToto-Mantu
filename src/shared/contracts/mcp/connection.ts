import { z } from 'zod'

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
