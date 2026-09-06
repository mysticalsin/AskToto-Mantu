import { describe, expect, it } from 'vitest'
import { isWriteToolName, pickWriteTool, resolveWriteTargets } from './write-tools'
import type { McpConnection } from '@shared/ipc'

const conn = (over: Partial<McpConnection> & Pick<McpConnection, 'kind'>): McpConnection => ({
  id: over.kind,
  kind: over.kind,
  label: over.label || over.kind,
  endpointUrl: over.endpointUrl || 'https://example.test/mcp',
  connected: over.connected ?? false,
  tools: over.tools ?? [],
  extraHeaders: over.extraHeaders ?? {}
})

describe('write tool discovery', () => {
  it('accepts create/note/task names and rejects a read-only list', () => {
    expect(isWriteToolName('create_note')).toBe(true)
    expect(isWriteToolName('push_meeting_recap')).toBe(true)
    expect(isWriteToolName('workitem')).toBe(true)
    expect(isWriteToolName('list_users')).toBe(false)
    expect(isWriteToolName('search')).toBe(false)
  })

  it('prefers a recap/note tool for CRM', () => {
    expect(pickWriteTool(['list_deals', 'push_meeting_recap', 'ping'], 'crm-note')).toBe('push_meeting_recap')
    expect(pickWriteTool(['list_deals'], 'crm-note')).toBeUndefined()
  })

  it('never picks attach_task_file for next-steps; create_task wins even if attach is first', () => {
    expect(isWriteToolName('clickup_attach_task_file')).toBe(false)
    expect(
      pickWriteTool(['clickup_attach_task_file', 'clickup_create_task', 'clickup_get_list'], 'next-steps')
    ).toBe('clickup_create_task')
  })
})

describe('resolveWriteTargets — honest connect, never a fake send', () => {
  it('says Connect when Outlook and Polo are off', () => {
    const targets = resolveWriteTargets({ connections: [], outlookSignedIn: false, outlookCanWrite: false })
    const crm = targets.find((t) => t.intent === 'crm-note')
    const draft = targets.find((t) => t.intent === 'outlook-draft')
    expect(crm && !crm.ready && crm.action).toBe('Connect Polo Pre-Sales')
    expect(draft && !draft.ready && draft.action).toBe('Connect Outlook')
    expect(JSON.stringify(targets)).not.toMatch(/sent|auto-send|Something went wrong/i)
  })

  it('exposes a CRM write tool only when the server is connected and has one', () => {
    const targets = resolveWriteTargets({
      connections: [conn({ kind: 'bidstack', connected: true, tools: ['push_meeting_recap'] })],
      outlookSignedIn: true,
      outlookCanWrite: true
    })
    const crm = targets.find((t) => t.intent === 'crm-note')
    expect(crm?.ready).toBe(true)
    if (crm && crm.ready) {
      expect(crm.toolName).toBe('push_meeting_recap')
      expect(crm.action).toMatch(/never auto-send/)
    }
    const draft = targets.find((t) => t.intent === 'outlook-draft')
    expect(draft?.ready).toBe(true)
    if (draft && draft.ready) expect(draft.action).toMatch(/not sent/)
  })

  it('does not invent a Polo send when the key has no write tool', () => {
    const targets = resolveWriteTargets({
      connections: [conn({ kind: 'bidstack', connected: true, tools: ['list_users'] })],
      outlookSignedIn: false,
      outlookCanWrite: false
    })
    const crm = targets.find((t) => t.intent === 'crm-note')
    expect(crm && !crm.ready && crm.reason).toBe('no-write-tool')
  })
})
