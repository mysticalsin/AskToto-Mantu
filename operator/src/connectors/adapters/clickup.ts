/**
 * ClickUp adapter (plan D8 catalog v1): 5 tools over the v2 REST API. Auth is the personal API token sent
 * raw in the `Authorization` header (no `Bearer` prefix - `catalog.ts`'s `clickup` entry already sets
 * `headerName: 'Authorization'` for exactly this reason, and its probe verifies the same credential shape
 * against `/api/v2/user`).
 */
import { boundedFetch, jsonResult, parseJsonSafe, safeResolvedUrl, textResult, type AdapterCallContext, type AdapterCallOutcome, type AdapterModule } from './shared'

const BASE = 'https://api.clickup.com/api/v2'

async function call(ctx: AdapterCallContext, method: string, path: string, body?: unknown): Promise<AdapterCallOutcome> {
  const check = await safeResolvedUrl(ctx.fetchImpl, `${BASE}${path}`, ctx.deadlineAt)
  if (!check.ok || !check.url) return textResult(check.error?.message || 'Blocked.', true)
  const res = await boundedFetch(
    ctx.fetchImpl,
    check.url.toString(),
    { method, headers: { authorization: ctx.credential, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
    ctx.deadlineAt
  )
  if (res.timedOut) return textResult('ClickUp timed out.', true)
  if (res.networkError) return textResult('Could not reach ClickUp.', true)
  const parsed = parseJsonSafe(res.text)
  if (!res.ok) {
    const err = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).err : null
    return textResult(typeof err === 'string' ? err : `ClickUp returned status ${res.status}.`, true)
  }
  return jsonResult(parsed ?? {})
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

export const clickupAdapter: AdapterModule = {
  tools: [
    { name: 'list_workspaces', description: 'List the authorized workspaces (teams).', write: false, inputSchema: { type: 'object', properties: {} } },
    {
      name: 'list_tasks',
      description: 'List tasks in a list.',
      write: false,
      inputSchema: { type: 'object', properties: { listId: { type: 'string' } }, required: ['listId'] }
    },
    { name: 'get_task', description: 'Get one task by id.', write: false, inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
    {
      name: 'create_task',
      description: 'Create a task in a list.',
      write: true,
      inputSchema: { type: 'object', properties: { listId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } }, required: ['listId', 'name'] }
    },
    {
      name: 'update_task',
      description: 'Update a task by id.',
      write: true,
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, status: { type: 'string' } }, required: ['taskId'] }
    }
  ],
  async callTool(name, args, ctx) {
    switch (name) {
      case 'list_workspaces':
        return call(ctx, 'GET', '/team')
      case 'list_tasks': {
        const listId = str(args, 'listId')
        if (!listId) return textResult('listId is required.', true)
        return call(ctx, 'GET', `/list/${encodeURIComponent(listId)}/task`)
      }
      case 'get_task': {
        const taskId = str(args, 'taskId')
        if (!taskId) return textResult('taskId is required.', true)
        return call(ctx, 'GET', `/task/${encodeURIComponent(taskId)}`)
      }
      case 'create_task': {
        const listId = str(args, 'listId')
        const taskName = str(args, 'name')
        if (!listId || !taskName) return textResult('listId and name are required.', true)
        return call(ctx, 'POST', `/list/${encodeURIComponent(listId)}/task`, { name: taskName, description: str(args, 'description') || undefined })
      }
      case 'update_task': {
        const taskId = str(args, 'taskId')
        if (!taskId) return textResult('taskId is required.', true)
        const patch: Record<string, string> = {}
        if (str(args, 'name')) patch.name = str(args, 'name')
        if (str(args, 'description')) patch.description = str(args, 'description')
        if (str(args, 'status')) patch.status = str(args, 'status')
        return call(ctx, 'PUT', `/task/${encodeURIComponent(taskId)}`, patch)
      }
      default:
        return textResult(`Unknown tool ${name}.`, true)
    }
  }
}
