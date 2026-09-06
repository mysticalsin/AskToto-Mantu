/**
 * Notion adapter (plan D8 catalog v1): 5 tools over the Notion REST API. Bearer auth (an internal
 * integration secret) plus the fixed `Notion-Version` header `catalog.ts`'s probe already uses.
 */
import { boundedFetch, jsonResult, parseJsonSafe, safeResolvedUrl, textResult, type AdapterCallContext, type AdapterCallOutcome, type AdapterModule } from './shared'

const BASE = 'https://api.notion.com/v1'
const NOTION_VERSION = '2026-03-11'

async function call(ctx: AdapterCallContext, method: string, path: string, body?: unknown): Promise<AdapterCallOutcome> {
  const check = await safeResolvedUrl(ctx.fetchImpl, `${BASE}${path}`, ctx.deadlineAt)
  if (!check.ok || !check.url) return textResult(check.error?.message || 'Blocked.', true)
  const res = await boundedFetch(
    ctx.fetchImpl,
    check.url.toString(),
    {
      method,
      headers: {
        authorization: `Bearer ${ctx.credential}`,
        'notion-version': NOTION_VERSION,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    },
    ctx.deadlineAt
  )
  if (res.timedOut) return textResult('Notion timed out.', true)
  if (res.networkError) return textResult('Could not reach Notion.', true)
  const parsed = parseJsonSafe(res.text)
  if (!res.ok) {
    const message = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).message : null
    return textResult(typeof message === 'string' ? message : `Notion returned status ${res.status}.`, true)
  }
  return jsonResult(parsed ?? {})
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

export const notionAdapter: AdapterModule = {
  tools: [
    { name: 'search', description: 'Search pages and databases by title.', write: false, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'get_page', description: 'Get one page by id.', write: false, inputSchema: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] } },
    {
      name: 'query_database',
      description: 'Query a database by id.',
      write: false,
      inputSchema: { type: 'object', properties: { databaseId: { type: 'string' } }, required: ['databaseId'] }
    },
    {
      name: 'create_page',
      description: 'Create a page under a parent page or database.',
      write: true,
      inputSchema: {
        type: 'object',
        properties: { parentId: { type: 'string' }, parentType: { type: 'string', description: '"page_id" or "database_id"' }, title: { type: 'string' } },
        required: ['parentId', 'parentType', 'title']
      }
    },
    {
      name: 'update_page',
      description: 'Update a page\'s properties by id.',
      write: true,
      inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, properties: { type: 'object' } }, required: ['pageId', 'properties'] }
    }
  ],
  async callTool(name, args, ctx) {
    switch (name) {
      case 'search':
        return call(ctx, 'POST', '/search', str(args, 'query') ? { query: str(args, 'query') } : {})
      case 'get_page': {
        const pageId = str(args, 'pageId')
        if (!pageId) return textResult('pageId is required.', true)
        return call(ctx, 'GET', `/pages/${encodeURIComponent(pageId)}`)
      }
      case 'query_database': {
        const databaseId = str(args, 'databaseId')
        if (!databaseId) return textResult('databaseId is required.', true)
        return call(ctx, 'POST', `/databases/${encodeURIComponent(databaseId)}/query`, {})
      }
      case 'create_page': {
        const parentId = str(args, 'parentId')
        const parentType = str(args, 'parentType')
        const title = str(args, 'title')
        if (!parentId || !parentType || !title) return textResult('parentId, parentType and title are required.', true)
        if (parentType !== 'page_id' && parentType !== 'database_id') return textResult('parentType must be page_id or database_id.', true)
        return call(ctx, 'POST', '/pages', {
          parent: { [parentType]: parentId },
          properties: { title: { title: [{ text: { content: title } }] } }
        })
      }
      case 'update_page': {
        const pageId = str(args, 'pageId')
        const properties = args.properties
        if (!pageId || !properties || typeof properties !== 'object') return textResult('pageId and properties are required.', true)
        return call(ctx, 'PATCH', `/pages/${encodeURIComponent(pageId)}`, { properties })
      }
      default:
        return textResult(`Unknown tool ${name}.`, true)
    }
  }
}
