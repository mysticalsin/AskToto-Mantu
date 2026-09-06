/**
 * HubSpot adapter (plan D8 catalog v1): 5 tools over the CRM v3 API, bearer auth (a private app access
 * token, same credential `catalog.ts`'s probe already verifies against `/account-info/v3/details`).
 * Reads first, writes last and marked - `gateway.ts` refuses `create_contact`/`update_contact` unless the
 * connection row has `allow_writes = 1`.
 */
import { boundedFetch, jsonResult, parseJsonSafe, safeResolvedUrl, textResult, type AdapterCallContext, type AdapterCallOutcome, type AdapterModule } from './shared'

const BASE = 'https://api.hubapi.com'

async function call(ctx: AdapterCallContext, method: string, path: string, body?: unknown): Promise<AdapterCallOutcome> {
  const check = await safeResolvedUrl(ctx.fetchImpl, `${BASE}${path}`, ctx.deadlineAt)
  if (!check.ok || !check.url) return textResult(check.error?.message || 'Blocked.', true)
  const res = await boundedFetch(
    ctx.fetchImpl,
    check.url.toString(),
    {
      method,
      headers: { authorization: `Bearer ${ctx.credential}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    },
    ctx.deadlineAt
  )
  if (res.timedOut) return textResult('HubSpot timed out.', true)
  if (res.networkError) return textResult('Could not reach HubSpot.', true)
  const parsed = parseJsonSafe(res.text)
  if (!res.ok) {
    const message = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).message : null
    return textResult(typeof message === 'string' ? message : `HubSpot returned status ${res.status}.`, true)
  }
  return jsonResult(parsed ?? {})
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

export const hubspotAdapter: AdapterModule = {
  tools: [
    {
      name: 'list_contacts',
      description: 'List contacts, newest first.',
      write: false,
      inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max 100, default 10' }, after: { type: 'string', description: 'Pagination cursor' } } }
    },
    {
      name: 'get_contact',
      description: 'Get one contact by id.',
      write: false,
      inputSchema: { type: 'object', properties: { contactId: { type: 'string' } }, required: ['contactId'] }
    },
    {
      name: 'search_contacts',
      description: 'Search contacts by email.',
      write: false,
      inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] }
    },
    {
      name: 'create_contact',
      description: 'Create a contact.',
      write: true,
      inputSchema: { type: 'object', properties: { email: { type: 'string' }, firstname: { type: 'string' }, lastname: { type: 'string' } }, required: ['email'] }
    },
    {
      name: 'update_contact',
      description: 'Update a contact by id.',
      write: true,
      inputSchema: {
        type: 'object',
        properties: { contactId: { type: 'string' }, properties: { type: 'object', description: 'HubSpot property name/value pairs' } },
        required: ['contactId', 'properties']
      }
    }
  ],
  async callTool(name, args, ctx) {
    switch (name) {
      case 'list_contacts': {
        const limit = typeof args.limit === 'number' ? Math.min(100, Math.max(1, Math.floor(args.limit))) : 10
        const after = str(args, 'after')
        const qs = new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) })
        return call(ctx, 'GET', `/crm/v3/objects/contacts?${qs.toString()}`)
      }
      case 'get_contact': {
        const contactId = str(args, 'contactId')
        if (!contactId) return textResult('contactId is required.', true)
        return call(ctx, 'GET', `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`)
      }
      case 'search_contacts': {
        const email = str(args, 'email')
        if (!email) return textResult('email is required.', true)
        return call(ctx, 'POST', '/crm/v3/objects/contacts/search', {
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }]
        })
      }
      case 'create_contact': {
        const email = str(args, 'email')
        if (!email) return textResult('email is required.', true)
        const properties: Record<string, string> = { email }
        if (str(args, 'firstname')) properties.firstname = str(args, 'firstname')
        if (str(args, 'lastname')) properties.lastname = str(args, 'lastname')
        return call(ctx, 'POST', '/crm/v3/objects/contacts', { properties })
      }
      case 'update_contact': {
        const contactId = str(args, 'contactId')
        const properties = args.properties
        if (!contactId || !properties || typeof properties !== 'object') return textResult('contactId and properties are required.', true)
        return call(ctx, 'PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { properties })
      }
      default:
        return textResult(`Unknown tool ${name}.`, true)
    }
  }
}
