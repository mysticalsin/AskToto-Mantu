/**
 * Linear adapter (plan D8 catalog v1): 5 tools over Linear's GraphQL API. Auth is the personal API key
 * sent raw in the `Authorization` header (no `Bearer` prefix - `catalog.ts`'s `linear` entry sets
 * `headerName: 'Authorization'` for this, and its probe sends a `viewer { id name }` query the same way).
 */
import { boundedFetch, jsonResult, parseJsonSafe, safeResolvedUrl, textResult, type AdapterCallContext, type AdapterCallOutcome, type AdapterModule } from './shared'

const ENDPOINT = 'https://api.linear.app/graphql'

interface GraphQlResponse {
  data?: Record<string, unknown>
  errors?: { message: string }[]
}

async function graphql(ctx: AdapterCallContext, query: string, variables?: Record<string, unknown>): Promise<AdapterCallOutcome> {
  const check = await safeResolvedUrl(ctx.fetchImpl, ENDPOINT, ctx.deadlineAt)
  if (!check.ok || !check.url) return textResult(check.error?.message || 'Blocked.', true)
  const res = await boundedFetch(
    ctx.fetchImpl,
    check.url.toString(),
    { method: 'POST', headers: { authorization: ctx.credential, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query, variables }) },
    ctx.deadlineAt
  )
  if (res.timedOut) return textResult('Linear timed out.', true)
  if (res.networkError) return textResult('Could not reach Linear.', true)
  const parsed = parseJsonSafe(res.text) as GraphQlResponse | null
  if (!res.ok) return textResult(`Linear returned status ${res.status}.`, true)
  if (parsed?.errors?.length) return textResult(parsed.errors[0].message, true)
  return jsonResult(parsed?.data ?? {})
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

export const linearAdapter: AdapterModule = {
  tools: [
    { name: 'list_teams', description: 'List teams.', write: false, inputSchema: { type: 'object', properties: {} } },
    {
      name: 'list_issues',
      description: 'List issues, optionally for one team.',
      write: false,
      inputSchema: { type: 'object', properties: { teamId: { type: 'string' } } }
    },
    { name: 'get_issue', description: 'Get one issue by id.', write: false, inputSchema: { type: 'object', properties: { issueId: { type: 'string' } }, required: ['issueId'] } },
    {
      name: 'create_issue',
      description: 'Create an issue on a team.',
      write: true,
      inputSchema: { type: 'object', properties: { teamId: { type: 'string' }, title: { type: 'string' } }, required: ['teamId', 'title'] }
    },
    {
      name: 'update_issue',
      description: 'Update an issue by id.',
      write: true,
      inputSchema: { type: 'object', properties: { issueId: { type: 'string' }, title: { type: 'string' }, stateId: { type: 'string' } }, required: ['issueId'] }
    }
  ],
  async callTool(name, args, ctx) {
    switch (name) {
      case 'list_teams':
        return graphql(ctx, 'query Teams { teams { nodes { id name key } } }')
      case 'list_issues': {
        const teamId = str(args, 'teamId')
        return graphql(
          ctx,
          teamId
            ? 'query Issues($teamId: ID!) { team(id: $teamId) { issues { nodes { id identifier title state { name } } } } }'
            : 'query Issues { issues(first: 50) { nodes { id identifier title state { name } } } }',
          teamId ? { teamId } : undefined
        )
      }
      case 'get_issue': {
        const issueId = str(args, 'issueId')
        if (!issueId) return textResult('issueId is required.', true)
        return graphql(ctx, 'query Issue($id: String!) { issue(id: $id) { id identifier title description state { name } } }', { id: issueId })
      }
      case 'create_issue': {
        const teamId = str(args, 'teamId')
        const title = str(args, 'title')
        if (!teamId || !title) return textResult('teamId and title are required.', true)
        return graphql(
          ctx,
          'mutation Create($teamId: String!, $title: String!) { issueCreate(input: { teamId: $teamId, title: $title }) { success issue { id identifier } } }',
          { teamId, title }
        )
      }
      case 'update_issue': {
        const issueId = str(args, 'issueId')
        if (!issueId) return textResult('issueId is required.', true)
        const input: Record<string, string> = {}
        if (str(args, 'title')) input.title = str(args, 'title')
        if (str(args, 'stateId')) input.stateId = str(args, 'stateId')
        return graphql(ctx, 'mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: issueId, input })
      }
      default:
        return textResult(`Unknown tool ${name}.`, true)
    }
  }
}
