/**
 * clickupPush.ts — post-meeting ClickUp create-task (docs/design/CLICKUP-PUSH.md).
 *
 * Main owns the tool name, the list, and the wire args. Review may send a recap title/description;
 * this module never calls attach_task_file and never trusts a renderer-supplied list or workspace.
 */

import type { McpConnection } from '@shared/ipc'
import type { McpPushResult } from './mcpClient'

export const CLICKUP_WORKSPACE_ID = '90141511178'

export type ClickupList = { id: string; name: string }

const NO_LIST = 'ClickUp has no list in this workspace. Create a list in ClickUp, then Reconnect.'
const NO_CREATE_TOOL = 'ClickUp did not offer a create-task tool. Reconnect ClickUp in Settings.'

export function isClickupAttachOrFileTool(name: string): boolean {
  return /attach|file|upload/i.test(name)
}

export function pickClickupCreateTask(tools: string[]): string | undefined {
  const exact = tools.find((t) => /^(clickup_)?create_task$/i.test(t))
  if (exact) return exact
  return tools.find((t) => /create[_-]?task/i.test(t) && !isClickupAttachOrFileTool(t) && !/comment|update|delete/i.test(t))
}

export function clickupCreateTaskArgs(input: {
  name: string
  listId: string
  description?: string
}): Record<string, string> {
  const args: Record<string, string> = {
    name: input.name.trim().slice(0, 300) || 'Untitled meeting',
    list_id: input.listId.trim(),
    workspace_id: CLICKUP_WORKSPACE_ID
  }
  const body = (input.description || '').trim()
  if (body) args.markdown_description = body.slice(0, 50_000)
  return args
}

/** Renderer payload is title/description (Review) or already-mapped name. Never project_id. */
export function clickupTaskNameFromArgs(args: Record<string, unknown>): string {
  for (const key of ['name', 'title']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return 'Untitled meeting'
}

export function clickupTaskDescriptionFromArgs(args: Record<string, unknown>): string {
  for (const key of ['markdown_description', 'description', 'summary']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

export function resolveClickupList(input: {
  saved?: ClickupList | null
  lastUpdated?: ClickupList | null
}): { ok: true; list: ClickupList } | { ok: false; error: string } {
  const saved = input.saved && input.saved.id.trim() ? { id: input.saved.id.trim(), name: input.saved.name.trim() } : null
  if (saved?.id) return { ok: true, list: { id: saved.id, name: saved.name || saved.id } }
  const last = input.lastUpdated && input.lastUpdated.id.trim() ? input.lastUpdated : null
  if (last?.id) return { ok: true, list: { id: last.id.trim(), name: last.name.trim() || last.id } }
  return { ok: false, error: NO_LIST }
}

export function savedClickupList(conn: Pick<McpConnection, 'clickupListId' | 'clickupListName'> | undefined): ClickupList | null {
  const id = (conn?.clickupListId || '').trim()
  if (!id) return null
  return { id, name: (conn?.clickupListName || '').trim() || id }
}

export function upsertClickupDestination(connections: McpConnection[], list: ClickupList): McpConnection[] {
  return connections.map((c) =>
    c.id === 'clickup' ? { ...c, clickupListId: list.id, clickupListName: list.name } : c
  )
}

function mcpText(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
}

function extractJson(text: string): unknown {
  const t = text.trim()
  if (!t) return null
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  if (t.startsWith('{') || t.startsWith('[')) return tryParse(t)
  const m = t.match(/\{[\s\S]*\}/)
  return m ? tryParse(m[0]) : null
}

function asList(id: unknown, name: unknown): ClickupList | null {
  const listId = typeof id === 'string' && id.trim() ? id.trim() : typeof id === 'number' ? String(id) : ''
  if (!listId) return null
  const listName = typeof name === 'string' && name.trim() ? name.trim() : listId
  return { id: listId, name: listName }
}

export function parseLastUpdatedList(mcpResult: unknown): ClickupList | null {
  const json = extractJson(mcpText(mcpResult)) ?? (typeof mcpResult === 'object' ? mcpResult : null)
  if (!json || typeof json !== 'object') return null
  const tasks = (json as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks) || tasks.length === 0) return null
  const first = tasks[0] as { list?: { id?: unknown; name?: unknown } }
  return asList(first?.list?.id, first?.list?.name)
}

export function parseTaskUrl(mcpResult: unknown): string | undefined {
  const text = mcpText(mcpResult)
  const fromText = text.match(/https:\/\/app\.clickup\.com\/t\/[A-Za-z0-9]+/)
  if (fromText) return fromText[0]
  const json = extractJson(text)
  if (json && typeof json === 'object') {
    const url = (json as { url?: unknown; task?: { url?: unknown } }).url
      ?? (json as { task?: { url?: unknown } }).task?.url
    if (typeof url === 'string' && url.startsWith('https://')) return url
  }
  return undefined
}

function pickDiscoveryTool(tools: string[], kind: 'filter' | 'get_list'): string | undefined {
  if (kind === 'filter') {
    return tools.find((t) => /filter_tasks$/i.test(t)) || tools.find((t) => /filter_tasks/i.test(t))
  }
  return tools.find((t) => /(^|_)get_list$/i.test(t))
}

export async function discoverClickupList(input: {
  tools: string[]
  saved?: ClickupList | null
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<McpPushResult>
}): Promise<{ ok: true; list: ClickupList } | { ok: false; error: string }> {
  const saved = input.saved && input.saved.id.trim() ? input.saved : null
  if (saved?.id) {
    const getList = pickDiscoveryTool(input.tools, 'get_list')
    if (getList) {
      const check = await input.callTool(getList, { list_id: saved.id, workspace_id: CLICKUP_WORKSPACE_ID })
      if (check.ok) return { ok: true, list: saved }
      // Deleted list — fall through to last-updated rather than pushing into a ghost id.
    } else {
      return { ok: true, list: saved }
    }
  }

  const filter = pickDiscoveryTool(input.tools, 'filter')
  if (!filter) {
    return saved?.id ? { ok: true, list: saved } : { ok: false, error: NO_LIST }
  }
  const found = await input.callTool(filter, {
    workspace_id: CLICKUP_WORKSPACE_ID,
    order_by: 'updated',
    reverse: true,
    page: 0,
    include_closed: true
  })
  if (!found.ok) {
    return { ok: false, error: found.error || NO_LIST }
  }
  const last = parseLastUpdatedList(found.result)
  return resolveClickupList({ saved: null, lastUpdated: last })
}

export function prepareClickupPush(input: {
  tools: string[]
  list: ClickupList
  rendererTool: string
  rendererArgs: Record<string, unknown>
}): { ok: true; toolName: string; args: Record<string, string> } | { ok: false; error: string } {
  if (isClickupAttachOrFileTool(input.rendererTool)) {
    // Fall through to create-task — never honor attach/file from Review's first-tool picker.
  }
  const toolName = pickClickupCreateTask(input.tools)
  if (!toolName) return { ok: false, error: NO_CREATE_TOOL }
  if (!input.list.id.trim()) return { ok: false, error: NO_LIST }
  return {
    ok: true,
    toolName,
    args: clickupCreateTaskArgs({
      name: clickupTaskNameFromArgs(input.rendererArgs),
      listId: input.list.id,
      description: clickupTaskDescriptionFromArgs(input.rendererArgs)
    })
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Prefer ClickUp's own validation sentence over mcpClient's "unknown reason".
 * Keep classified timeout / 401 / unreachable copy — those are more useful than a stack.
 */
export function loudClickupError(raw: unknown, classified: string): string {
  if (/timed out|401\/403|Could not reach|redirected|session expired|Reconnect ClickUp/i.test(classified)) {
    return classified
  }
  const text = errMsg(raw).replace(/\s+/g, ' ').trim().slice(0, 500)
  if (/invalid|required|parameter|list_id|schema|MCP error/i.test(text)) return text
  if (/unknown reason/i.test(classified) && text && !/node_modules/.test(text)) return text
  return classified
}
