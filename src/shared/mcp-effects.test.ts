import { describe, expect, it } from 'vitest'
import { classifyBuiltinMcpTool } from './mcp-effects'

const clickup = (toolName: string, annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }) =>
  classifyBuiltinMcpTool({
    source: 'builtin',
    connectionKind: 'clickup',
    toolName,
    ...(annotations ? { annotations } : {})
  })

describe('built-in MCP effect classes', () => {
  it('clickup lookup tools are read, create-task is reversible_write', () => {
    expect(clickup('clickup_get_workspace_hierarchy')).toBe('read')
    expect(clickup('clickup_filter_tasks')).toBe('read')
    expect(clickup('clickup_create_task')).toBe('reversible_write')
  })
  it('unknown tool is irreversible_write', () => {
    expect(clickup('clickup_delete_task')).toBe('irreversible_write')
    expect(
      classifyBuiltinMcpTool({ source: 'builtin', connectionKind: 'bidstack', toolName: 'push_meeting_recap' })
    ).toBe('irreversible_write')
    expect(classifyBuiltinMcpTool({ source: 'operator', connectionKind: 'x', toolName: 'whatever' })).toBe(
      'irreversible_write'
    )
  })
  it('readOnlyHint cannot lower a class', () => {
    expect(clickup('clickup_delete_task', { readOnlyHint: true })).toBe('irreversible_write')
    expect(clickup('clickup_get_task', { destructiveHint: true })).toBe('irreversible_write')
  })
  it('send-like name is send', () => {
    expect(clickup('clickup_send_chat_message')).toBe('send')
    expect(classifyBuiltinMcpTool({ source: 'builtin', connectionKind: 'plane', toolName: 'share_file' })).toBe('send')
  })
})
