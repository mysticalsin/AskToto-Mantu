import { z } from 'zod'

/**
 * Custom MCP (G63): owner-registered MCP servers over https (or, behind an admin policy, stdio).
 * Types and IPC contracts only; every decision (policy, effect, approval) is made in main.
 */

export const CUSTOM_MCP_ID = /^cmcp-[a-f0-9]{24}$/
export const CUSTOM_MCP_MAX_PER_SCOPE = 8
export const CUSTOM_MCP_MAX_TOOLS = 64

export const CUSTOM_MCP_IPC = {
  list: 'custom-mcp:list',
  draft: 'custom-mcp:draft',
  confirm: 'custom-mcp:confirm',
  refresh: 'custom-mcp:refresh',
  disable: 'custom-mcp:disable',
  remove: 'custom-mcp:remove',
  proposeCall: 'custom-mcp:propose-call',
  confirmCall: 'custom-mcp:confirm-call'
} as const

export const CUSTOM_MCP_REFUSALS = [
  'auth_required',
  'invalid_input',
  'not_found',
  'policy_blocked',
  'endpoint_refused',
  'too_many_servers',
  'probe_failed',
  'schema_invalid',
  'review_required',
  'review_expired',
  'catalog_changed',
  'tool_not_allowed',
  'not_approved',
  'call_failed'
] as const
export type CustomMcpRefusal = (typeof CUSTOM_MCP_REFUSALS)[number]

export const CUSTOM_MCP_STATES = [
  'draft',
  'probing',
  'review',
  'enabled',
  'degraded',
  'stale_catalog',
  'policy_blocked',
  'disabled'
] as const
export type CustomMcpState = (typeof CUSTOM_MCP_STATES)[number]

export const CustomMcpIdSchema = z.string().regex(CUSTOM_MCP_ID)
const ToolNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)

export const CustomMcpAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('bearer') }).strict(),
  z.object({ type: z.literal('header'), headerName: z.string().regex(/^X-[A-Za-z0-9-]{1,40}$/) }).strict()
])
export type CustomMcpAuth = z.infer<typeof CustomMcpAuthSchema>

export const CustomMcpTransportSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('https'), url: z.string().min(1).max(2048) }).strict(),
  z
    .object({
      kind: z.literal('stdio'),
      executable: z.string().min(1).max(1024),
      args: z.array(z.string().max(512)).max(32).default([]),
      env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/), z.string().max(512)).default({})
    })
    .strict()
])
export type CustomMcpTransport = z.infer<typeof CustomMcpTransportSchema>

export const CustomMcpDraftPayloadSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    transport: CustomMcpTransportSchema,
    auth: CustomMcpAuthSchema,
    /** Written once through mcpSecrets; never returned. */
    secret: z.string().max(4096).optional()
  })
  .strict()
export type CustomMcpDraftPayload = z.infer<typeof CustomMcpDraftPayloadSchema>

export const CustomMcpIdPayloadSchema = z.object({ id: CustomMcpIdSchema }).strict()
export const CustomMcpConfirmPayloadSchema = z
  .object({
    id: CustomMcpIdSchema,
    reviewTokenId: z.string().regex(/^[a-f0-9]{32}$/),
    allowedTools: z.array(ToolNameSchema).max(CUSTOM_MCP_MAX_TOOLS)
  })
  .strict()
export const CustomMcpProposeCallPayloadSchema = z
  .object({ id: CustomMcpIdSchema, tool: ToolNameSchema, args: z.record(z.string(), z.unknown()) })
  .strict()
export const CustomMcpConfirmCallPayloadSchema = z.object({ proposalId: z.string().regex(/^[a-f0-9]{32}$/) }).strict()

export interface CustomMcpToolView {
  name: string
  /** Plain text only; the renderer must never render it as HTML. */
  description: string
  effect: 'read' | 'create'
  allowed: boolean
}

export interface CustomMcpView {
  id: string
  label: string
  transport: 'https' | 'stdio'
  /** Host only for https; never path, query or credentials. */
  target: string
  authType: CustomMcpAuth['type']
  hasSecret: boolean
  state: CustomMcpState
  health: 'unknown' | 'healthy' | 'failing'
  tools: CustomMcpToolView[]
  lastError?: CustomMcpRefusal
  rule?: string
  reviewTokenId?: string
}

export type CustomMcpResponse<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: CustomMcpRefusal; rule?: string }
