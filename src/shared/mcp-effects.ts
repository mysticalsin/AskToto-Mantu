import type { ConnectorEffectClass } from './connector-effects'

/** Where an MCP tool call comes from. `custom` is the G63 seam: nothing classifies it until G63 registers a classifier. */
export type McpToolSource = 'builtin' | 'operator' | 'custom'

export interface McpEffectInput {
  source: McpToolSource
  /** The connection kind (`clickup`, `bidstack`, `plane`) or an Operator/custom connection id. */
  connectionKind: string
  toolName: string
  /** Server-declared hints. Untrusted: they can only make a class stricter. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

/** `null` means "this source cannot classify the call"; the caller refuses it. */
export type McpEffectClassifier = (input: McpEffectInput) => ConnectorEffectClass | null

const CLICKUP_READ_TOOLS = /^(?:clickup_)?(?:get_|list_|search|find_|filter_|resolve_)/i
const CLICKUP_CREATE_TASK = /^(?:clickup_)?create[_-]?task$/i
const SEND_LIKE = /send|mail|invite|share/i

/**
 * The built-in connections' tools. ClickUp lookups are reads and its create-task tool is a reversible write (the
 * task can be deleted). Everything else, including BidStack/Plane pushes (CRM notes are not reliably undoable) and
 * Operator tools, starts at `irreversible_write`. A send-like name is `send`, the strictest class.
 */
export function classifyBuiltinMcpTool(input: McpEffectInput): ConnectorEffectClass {
  const { connectionKind, toolName } = input
  if (SEND_LIKE.test(toolName)) return 'send'
  if (connectionKind === 'clickup') {
    if (CLICKUP_CREATE_TASK.test(toolName)) return 'reversible_write'
    if (CLICKUP_READ_TOOLS.test(toolName) && !input.annotations?.destructiveHint) return 'read'
  }
  return 'irreversible_write'
}
