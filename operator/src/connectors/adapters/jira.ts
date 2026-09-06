/**
 * Jira adapter (plan D8 catalog v1): 5 tools over the Jira Cloud REST API v3, HTTP Basic auth (account
 * email + API token, same shape `catalog.ts`'s probe already verifies against `/rest/api/3/myself`).
 * `config.subdomain` is the `yourcompany` in `yourcompany.atlassian.net` - a fixed Atlassian domain
 * suffix, not an admin-controlled arbitrary host, but every call still runs through `safeResolvedUrl`
 * the same as every other adapter (uniform guard, no cherry-picking which adapter "needs" it).
 */
import { boundedFetch, jsonResult, parseJsonSafe, safeResolvedUrl, textResult, type AdapterCallContext, type AdapterCallOutcome, type AdapterModule } from './shared'

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

function base(ctx: AdapterCallContext): { ok: true; url: string } | { ok: false; message: string } {
  const subdomain = ctx.config.subdomain
  if (!subdomain) return { ok: false, message: 'This connection has no Jira site configured.' }
  return { ok: true, url: `https://${subdomain}.atlassian.net/rest/api/3` }
}

async function call(ctx: AdapterCallContext, method: string, path: string, body?: unknown): Promise<AdapterCallOutcome> {
  const b = base(ctx)
  if (!b.ok) return textResult(b.message, true)
  const check = await safeResolvedUrl(ctx.fetchImpl, `${b.url}${path}`, ctx.deadlineAt)
  if (!check.ok || !check.url) return textResult(check.error?.message || 'Blocked.', true)
  const email = ctx.config.email || ''
  const authorization = `Basic ${btoa(`${email}:${ctx.credential}`)}`
  const res = await boundedFetch(
    ctx.fetchImpl,
    check.url.toString(),
    { method, headers: { authorization, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
    ctx.deadlineAt
  )
  if (res.timedOut) return textResult('Jira timed out.', true)
  if (res.networkError) return textResult('Could not reach Jira.', true)
  const parsed = parseJsonSafe(res.text)
  if (!res.ok) {
    const messages = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).errorMessages : null
    return textResult(Array.isArray(messages) && messages.length ? String(messages[0]) : `Jira returned status ${res.status}.`, true)
  }
  return jsonResult(parsed ?? {})
}

/** Jira Cloud v3 requires comment/description bodies in Atlassian Document Format, not plain strings. */
function adfParagraph(text: string): Record<string, unknown> {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

export const jiraAdapter: AdapterModule = {
  tools: [
    {
      name: 'search_issues',
      description: 'Search issues with JQL.',
      write: false,
      inputSchema: { type: 'object', properties: { jql: { type: 'string' } }, required: ['jql'] }
    },
    { name: 'get_issue', description: 'Get one issue by key.', write: false, inputSchema: { type: 'object', properties: { issueKey: { type: 'string' } }, required: ['issueKey'] } },
    { name: 'list_projects', description: 'List projects.', write: false, inputSchema: { type: 'object', properties: {} } },
    {
      name: 'create_issue',
      description: 'Create an issue.',
      write: true,
      inputSchema: {
        type: 'object',
        properties: { projectKey: { type: 'string' }, summary: { type: 'string' }, issueType: { type: 'string' } },
        required: ['projectKey', 'summary', 'issueType']
      }
    },
    {
      name: 'add_comment',
      description: 'Add a comment to an issue.',
      write: true,
      inputSchema: { type: 'object', properties: { issueKey: { type: 'string' }, body: { type: 'string' } }, required: ['issueKey', 'body'] }
    }
  ],
  async callTool(name, args, ctx) {
    switch (name) {
      case 'search_issues': {
        const jql = str(args, 'jql')
        if (!jql) return textResult('jql is required.', true)
        return call(ctx, 'GET', `/search?jql=${encodeURIComponent(jql)}`)
      }
      case 'get_issue': {
        const issueKey = str(args, 'issueKey')
        if (!issueKey) return textResult('issueKey is required.', true)
        return call(ctx, 'GET', `/issue/${encodeURIComponent(issueKey)}`)
      }
      case 'list_projects':
        return call(ctx, 'GET', '/project')
      case 'create_issue': {
        const projectKey = str(args, 'projectKey')
        const summary = str(args, 'summary')
        const issueType = str(args, 'issueType')
        if (!projectKey || !summary || !issueType) return textResult('projectKey, summary and issueType are required.', true)
        return call(ctx, 'POST', '/issue', { fields: { project: { key: projectKey }, summary, issuetype: { name: issueType } } })
      }
      case 'add_comment': {
        const issueKey = str(args, 'issueKey')
        const body = str(args, 'body')
        if (!issueKey || !body) return textResult('issueKey and body are required.', true)
        return call(ctx, 'POST', `/issue/${encodeURIComponent(issueKey)}/comment`, { body: adfParagraph(body) })
      }
      default:
        return textResult(`Unknown tool ${name}.`, true)
    }
  }
}
