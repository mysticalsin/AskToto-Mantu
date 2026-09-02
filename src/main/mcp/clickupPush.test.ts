import { describe, expect, it } from 'vitest'
import {
  CLICKUP_WORKSPACE_ID,
  clickupCreateTaskArgs,
  clickupTaskDescriptionFromArgs,
  clickupTaskNameFromArgs,
  discoverClickupList,
  isClickupAttachOrFileTool,
  loudClickupError,
  parseLastUpdatedList,
  parseTaskUrl,
  pickClickupCreateTask,
  prepareClickupPush,
  resolveClickupList,
  savedClickupList,
  upsertClickupDestination
} from './clickupPush'
import type { McpConnection } from '@shared/ipc'

const tools = ['clickup_attach_task_file', 'clickup_get_list', 'clickup_filter_tasks', 'clickup_create_task']

describe('pickClickupCreateTask — never attach a file', () => {
  it('picks create_task even when attach_task_file is listed first', () => {
    expect(pickClickupCreateTask(tools)).toBe('clickup_create_task')
    expect(pickClickupCreateTask(['attach_task_file', 'create_task'])).toBe('create_task')
  })

  it('rejects attach/file names', () => {
    expect(isClickupAttachOrFileTool('clickup_attach_task_file')).toBe(true)
    expect(isClickupAttachOrFileTool('clickup_create_task')).toBe(false)
    expect(pickClickupCreateTask(['clickup_attach_task_file', 'clickup_get_task'])).toBeUndefined()
  })
})

describe('clickupCreateTaskArgs — ClickUp wire names, pinned workspace', () => {
  it('sends name + list_id + workspace_id, never title/project_id', () => {
    const args = clickupCreateTaskArgs({ name: 'Acme recap', listId: '901419032720', description: '## Notes' })
    expect(args).toEqual({
      name: 'Acme recap',
      list_id: '901419032720',
      markdown_description: '## Notes',
      workspace_id: CLICKUP_WORKSPACE_ID
    })
    expect(args).not.toHaveProperty('title')
    expect(args).not.toHaveProperty('project_id')
    expect(args).not.toHaveProperty('description')
  })
})

describe('resolveClickupList — last successful, else last-updated, else loud', () => {
  it('prefers the saved list', () => {
    const r = resolveClickupList({
      saved: { id: '901419132937', name: 'Action Backlog' },
      lastUpdated: { id: '901419032720', name: 'Project 1' }
    })
    expect(r).toEqual({ ok: true, list: { id: '901419132937', name: 'Action Backlog' } })
  })

  it('falls through to last-updated when nothing is saved', () => {
    const r = resolveClickupList({ lastUpdated: { id: '901419032720', name: 'Project 1' } })
    expect(r).toEqual({ ok: true, list: { id: '901419032720', name: 'Project 1' } })
  })

  it('fails loud when the workspace has no list', () => {
    const r = resolveClickupList({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/no list in this workspace/i)
  })
})

describe('parseLastUpdatedList', () => {
  it('reads the list of the first filter_tasks hit', () => {
    const result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            tasks: [{ id: '86bbcq169', list: { id: '901419032720', name: 'Project 1' } }]
          })
        }
      ]
    }
    expect(parseLastUpdatedList(result)).toEqual({ id: '901419032720', name: 'Project 1' })
  })

  it('returns null on empty tasks', () => {
    expect(parseLastUpdatedList({ content: [{ type: 'text', text: '{"tasks":[]}' }] })).toBeNull()
  })
})

describe('prepareClickupPush — remaps Review args and ignores attach', () => {
  it('rewrites attach_task_file + title/project_id into create_task + name/list_id', () => {
    const r = prepareClickupPush({
      tools,
      list: { id: '901419032720', name: 'Project 1' },
      rendererTool: 'clickup_attach_task_file',
      rendererArgs: { title: 'Kickoff', description: 'Ship it', project_id: 'nope', confidential: false }
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.toolName).toBe('clickup_create_task')
      expect(r.args.name).toBe('Kickoff')
      expect(r.args.list_id).toBe('901419032720')
      expect(r.args.markdown_description).toBe('Ship it')
      expect(r.args.workspace_id).toBe(CLICKUP_WORKSPACE_ID)
      expect(r.args).not.toHaveProperty('title')
      expect(r.args).not.toHaveProperty('project_id')
      expect(r.args).not.toHaveProperty('confidential')
    }
  })

  it('fails when ClickUp offered no create-task tool', () => {
    const r = prepareClickupPush({
      tools: ['clickup_attach_task_file'],
      list: { id: '1', name: 'A' },
      rendererTool: 'clickup_attach_task_file',
      rendererArgs: { title: 'X' }
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/create-task tool/i)
  })
})

describe('discoverClickupList', () => {
  it('uses the saved list without calling filter when get_list is absent', async () => {
    const calls: string[] = []
    const r = await discoverClickupList({
      tools: ['clickup_create_task'],
      saved: { id: '901419132937', name: 'Action Backlog' },
      callTool: async (name) => {
        calls.push(name)
        return { ok: true, result: {} }
      }
    })
    expect(r).toEqual({ ok: true, list: { id: '901419132937', name: 'Action Backlog' } })
    expect(calls).toEqual([])
  })

  it('falls back to last-updated filter_tasks when nothing is saved', async () => {
    const r = await discoverClickupList({
      tools,
      callTool: async (name, args) => {
        expect(name).toBe('clickup_filter_tasks')
        expect(args.workspace_id).toBe(CLICKUP_WORKSPACE_ID)
        expect(args.order_by).toBe('updated')
        return {
          ok: true,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ tasks: [{ list: { id: '901419032720', name: 'Project 1' } }] })
              }
            ]
          }
        }
      }
    })
    expect(r).toEqual({ ok: true, list: { id: '901419032720', name: 'Project 1' } })
  })

  it('surfaces a ClickUp filter error instead of inventing a list', async () => {
    const r = await discoverClickupList({
      tools,
      callTool: async () => ({ ok: false, error: 'MCP error -32602: Invalid params' })
    })
    expect(r).toEqual({ ok: false, error: 'MCP error -32602: Invalid params' })
  })
})

describe('loudClickupError', () => {
  it('keeps a ClickUp validation sentence over unknown-reason classify', () => {
    expect(loudClickupError('MCP error -32602: Invalid params', 'ClickUp connection failed for an unknown reason. Check the endpoint and API key.')).toBe(
      'MCP error -32602: Invalid params'
    )
  })

  it('keeps classified timeout / 401 copy', () => {
    expect(loudClickupError('boom', 'Timed out connecting to ClickUp at https://mcp.clickup.com/mcp. Check the endpoint is reachable.')).toMatch(
      /Timed out/
    )
  })
})

describe('helpers', () => {
  it('reads Review title/description keys', () => {
    expect(clickupTaskNameFromArgs({ title: 'A', name: 'B' })).toBe('B')
    expect(clickupTaskNameFromArgs({ title: 'A' })).toBe('A')
    expect(clickupTaskDescriptionFromArgs({ summary: 's', description: 'd' })).toBe('d')
  })

  it('upserts destination only on the clickup row', () => {
    const plane: McpConnection = {
      id: 'plane',
      kind: 'plane',
      label: 'Plane',
      endpointUrl: 'https://mcp.plane.so/http/mcp',
      connected: true,
      tools: [],
      extraHeaders: {}
    }
    const clickup: McpConnection = {
      id: 'clickup',
      kind: 'clickup',
      label: 'ClickUp',
      endpointUrl: 'https://mcp.clickup.com/mcp',
      connected: true,
      tools: tools,
      extraHeaders: {}
    }
    const next = upsertClickupDestination([plane, clickup], { id: '1', name: 'Inbox' })
    expect(savedClickupList(next[1])).toEqual({ id: '1', name: 'Inbox' })
    expect(next[0].clickupListId).toBeUndefined()
  })

  it('parses a ClickUp task URL out of MCP text', () => {
    expect(parseTaskUrl({ content: [{ type: 'text', text: 'ok https://app.clickup.com/t/86bbcq169' }] })).toBe(
      'https://app.clickup.com/t/86bbcq169'
    )
  })
})
