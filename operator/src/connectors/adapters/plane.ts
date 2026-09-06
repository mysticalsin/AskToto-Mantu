/**
 * Plane adapter (plan D8 catalog v1): 5 tools over Plane's REST API. The only adapter whose base URL is
 * admin-supplied (`config.baseUrl`, self-hosted Plane included, default `https://api.plane.so` -
 * `catalog.ts`'s `plane` entry), so `safeResolvedUrl`'s SSRF guard + resolve-then-validate matters most
 * here of the seven; every call below runs through it, same as every other adapter, but this is the one
 * where an admin-controlled hostname genuinely varies. Auth is an API key in the `X-API-Key` header
 * (`catalog.ts`'s `headerName`), workspace scoped by `config.workspace`.
 */
import { boundedFetch, jsonResult, parseJsonSafe, safeResolvedUrl, textResult, type AdapterCallContext, type AdapterCallOutcome, type AdapterModule } from './shared'

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

function base(ctx: AdapterCallContext): { ok: true; url: string } | { ok: false; message: string } {
  const baseUrl = (ctx.config.baseUrl || 'https://api.plane.so').replace(/\/+$/, '')
  const workspace = ctx.config.workspace
  if (!workspace) return { ok: false, message: 'This connection has no workspace slug configured.' }
  return { ok: true, url: `${baseUrl}/api/v1/workspaces/${encodeURIComponent(workspace)}` }
}

async function call(ctx: AdapterCallContext, method: string, path: string, body?: unknown): Promise<AdapterCallOutcome> {
  const b = base(ctx)
  if (!b.ok) return textResult(b.message, true)
  const check = await safeResolvedUrl(ctx.fetchImpl, `${b.url}${path}`, ctx.deadlineAt)
  if (!check.ok || !check.url) return textResult(check.error?.message || 'Blocked.', true)
  const res = await boundedFetch(
    ctx.fetchImpl,
    check.url.toString(),
    { method, headers: { 'x-api-key': ctx.credential, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
    ctx.deadlineAt
  )
  if (res.timedOut) return textResult('Plane timed out.', true)
  if (res.networkError) return textResult('Could not reach Plane.', true)
  const parsed = parseJsonSafe(res.text)
  if (!res.ok) return textResult(`Plane returned status ${res.status}.`, true)
  return jsonResult(parsed ?? {})
}

export const planeAdapter: AdapterModule = {
  tools: [
    { name: 'list_projects', description: 'List projects in the workspace.', write: false, inputSchema: { type: 'object', properties: {} } },
    {
      name: 'list_issues',
      description: 'List issues in a project.',
      write: false,
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] }
    },
    {
      name: 'get_issue',
      description: 'Get one issue by id.',
      write: false,
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, issueId: { type: 'string' } }, required: ['projectId', 'issueId'] }
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a project.',
      write: true,
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, name: { type: 'string' } }, required: ['projectId', 'name'] }
    },
    {
      name: 'update_issue',
      description: 'Update an issue by id.',
      write: true,
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' }, issueId: { type: 'string' }, name: { type: 'string' }, state: { type: 'string' } },
        required: ['projectId', 'issueId']
      }
    }
  ],
  async callTool(name, args, ctx) {
    switch (name) {
      case 'list_projects':
        return call(ctx, 'GET', '/projects/')
      case 'list_issues': {
        const projectId = str(args, 'projectId')
        if (!projectId) return textResult('projectId is required.', true)
        return call(ctx, 'GET', `/projects/${encodeURIComponent(projectId)}/issues/`)
      }
      case 'get_issue': {
        const projectId = str(args, 'projectId')
        const issueId = str(args, 'issueId')
        if (!projectId || !issueId) return textResult('projectId and issueId are required.', true)
        return call(ctx, 'GET', `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/`)
      }
      case 'create_issue': {
        const projectId = str(args, 'projectId')
        const issueName = str(args, 'name')
        if (!projectId || !issueName) return textResult('projectId and name are required.', true)
        return call(ctx, 'POST', `/projects/${encodeURIComponent(projectId)}/issues/`, { name: issueName })
      }
      case 'update_issue': {
        const projectId = str(args, 'projectId')
        const issueId = str(args, 'issueId')
        if (!projectId || !issueId) return textResult('projectId and issueId are required.', true)
        const patch: Record<string, string> = {}
        if (str(args, 'name')) patch.name = str(args, 'name')
        if (str(args, 'state')) patch.state = str(args, 'state')
        return call(ctx, 'PATCH', `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/`, patch)
      }
      default:
        return textResult(`Unknown tool ${name}.`, true)
    }
  }
}
