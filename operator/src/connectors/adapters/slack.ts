/**
 * Slack adapter (plan D8 catalog v1): 5 tools over the Slack Web API, bearer auth (a bot token, same
 * credential `catalog.ts`'s probe already verifies against `auth.test`). Slack's Web API answers HTTP 200
 * even on a rejected call (`{ ok: false, error }`), so success is read from the body's own `ok` field, not
 * the HTTP status - the same `successCheck` shape `catalog.ts`'s probe already applies to this vendor.
 */
import { boundedFetch, jsonResult, parseJsonSafe, safeResolvedUrl, textResult, type AdapterCallContext, type AdapterCallOutcome, type AdapterModule } from './shared'

const BASE = 'https://slack.com/api'

interface SlackBody {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

async function call(ctx: AdapterCallContext, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<AdapterCallOutcome> {
  const check = await safeResolvedUrl(ctx.fetchImpl, `${BASE}${path}`, ctx.deadlineAt)
  if (!check.ok || !check.url) return textResult(check.error?.message || 'Blocked.', true)
  const res = await boundedFetch(
    ctx.fetchImpl,
    check.url.toString(),
    { method, headers: { authorization: `Bearer ${ctx.credential}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
    ctx.deadlineAt
  )
  if (res.timedOut) return textResult('Slack timed out.', true)
  if (res.networkError) return textResult('Could not reach Slack.', true)
  const parsed = parseJsonSafe(res.text) as SlackBody | null
  if (!res.ok) return textResult(`Slack returned status ${res.status}.`, true)
  if (!parsed?.ok) return textResult(parsed?.error || 'Slack rejected the request.', true)
  return jsonResult(parsed)
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

export const slackAdapter: AdapterModule = {
  tools: [
    { name: 'list_channels', description: 'List channels the bot can see.', write: false, inputSchema: { type: 'object', properties: {} } },
    { name: 'list_users', description: 'List workspace members.', write: false, inputSchema: { type: 'object', properties: {} } },
    {
      name: 'get_channel_history',
      description: 'Get recent messages in a channel.',
      write: false,
      inputSchema: { type: 'object', properties: { channel: { type: 'string' } }, required: ['channel'] }
    },
    {
      name: 'post_message',
      description: 'Post a message to a channel.',
      write: true,
      inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] }
    },
    {
      name: 'add_reaction',
      description: 'Add an emoji reaction to a message.',
      write: true,
      inputSchema: { type: 'object', properties: { channel: { type: 'string' }, timestamp: { type: 'string' }, name: { type: 'string' } }, required: ['channel', 'timestamp', 'name'] }
    }
  ],
  async callTool(name, args, ctx) {
    switch (name) {
      case 'list_channels':
        return call(ctx, 'GET', '/conversations.list')
      case 'list_users':
        return call(ctx, 'GET', '/users.list')
      case 'get_channel_history': {
        const channel = str(args, 'channel')
        if (!channel) return textResult('channel is required.', true)
        return call(ctx, 'GET', `/conversations.history?channel=${encodeURIComponent(channel)}`)
      }
      case 'post_message': {
        const channel = str(args, 'channel')
        const text = str(args, 'text')
        if (!channel || !text) return textResult('channel and text are required.', true)
        return call(ctx, 'POST', '/chat.postMessage', { channel, text })
      }
      case 'add_reaction': {
        const channel = str(args, 'channel')
        const timestamp = str(args, 'timestamp')
        const emoji = str(args, 'name')
        if (!channel || !timestamp || !emoji) return textResult('channel, timestamp and name are required.', true)
        return call(ctx, 'POST', '/reactions.add', { channel, timestamp, name: emoji })
      }
      default:
        return textResult(`Unknown tool ${name}.`, true)
    }
  }
}
