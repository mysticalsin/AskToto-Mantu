/**
 * write-tools.ts — honest write intents for Outlook and CRM.
 *
 * Discovers write tools on a connected MCP server (BidStack / Polo, Plane, ClickUp) and describes
 * Outlook Graph draft/event actions. Never claims a send. If a connector is off, the action is
 * present and says connect.
 *
 * Matching is conservative: we only treat a tool as a write when its name looks like create / add /
 * push / note / draft / event / task / workitem. A connected server with no matching tool is
 * "connected, nothing to write" — not a fake send.
 */

import type { McpConnection, McpConnectionKind } from '@shared/ipc'

export const WRITE_INTENTS = ['crm-note', 'outlook-draft', 'outlook-event', 'next-steps'] as const
export type WriteIntent = (typeof WRITE_INTENTS)[number]

export type WriteTarget =
  | {
      ready: true
      intent: WriteIntent
      via: 'mcp' | 'graph'
      connectionId?: McpConnectionKind
      toolName?: string
      label: string
      /** What Confirm will do. Never "send". */
      action: string
    }
  | {
      ready: false
      intent: WriteIntent
      connector: 'outlook' | 'bidstack' | 'plane' | 'clickup'
      label: string
      /** Honest CTA. */
      action: string
      reason: 'connect' | 'no-write-tool' | 'no-consent'
    }

const WRITE_NAME = /(?:create|add|push|insert|upsert|write|note|draft|event|task|workitem|issue|comment)/i

export function isWriteToolName(name: string): boolean {
  return WRITE_NAME.test(name)
}

export function pickWriteTool(tools: string[], intent: WriteIntent): string | undefined {
  const ranked = tools.filter(isWriteToolName)
  if (!ranked.length) return undefined
  const prefer =
    intent === 'crm-note'
      ? /note|recap|meeting|comment|push/i
      : intent === 'next-steps'
        ? /task|workitem|issue|event/i
        : /draft|event|mail|message/i
  return ranked.find((t) => prefer.test(t)) ?? ranked[0]
}

export function resolveWriteTargets(input: {
  connections: McpConnection[]
  outlookSignedIn: boolean
  outlookCanWrite: boolean
}): WriteTarget[] {
  const bidstack = input.connections.find((c) => c.kind === 'bidstack')
  const plane = input.connections.find((c) => c.kind === 'plane')
  const clickup = input.connections.find((c) => c.kind === 'clickup')

  const crm: WriteTarget = (() => {
    if (!bidstack?.connected) {
      return {
        ready: false,
        intent: 'crm-note',
        connector: 'bidstack',
        label: 'Polo Pre-Sales',
        action: 'Connect Polo Pre-Sales',
        reason: 'connect'
      }
    }
    const tool = pickWriteTool(bidstack.tools ?? [], 'crm-note')
    if (!tool) {
      return {
        ready: false,
        intent: 'crm-note',
        connector: 'bidstack',
        label: 'Polo Pre-Sales',
        action: 'Connected, no write tool on this key',
        reason: 'no-write-tool'
      }
    }
    return {
      ready: true,
      intent: 'crm-note',
      via: 'mcp',
      connectionId: 'bidstack',
      toolName: tool,
      label: 'Polo Pre-Sales',
      action: 'Create CRM note (review first, never auto-send)'
    }
  })()

  const outlookDraft: WriteTarget = !input.outlookSignedIn
    ? {
        ready: false,
        intent: 'outlook-draft',
        connector: 'outlook',
        label: 'Outlook',
        action: 'Connect Outlook',
        reason: 'connect'
      }
    : !input.outlookCanWrite
      ? {
          ready: false,
          intent: 'outlook-draft',
          connector: 'outlook',
          label: 'Outlook',
          action: 'Connect Outlook (draft permission needed)',
          reason: 'no-consent'
        }
      : {
          ready: true,
          intent: 'outlook-draft',
          via: 'graph',
          label: 'Outlook',
          action: 'Create Outlook draft (not sent)'
        }

  const outlookEvent: WriteTarget = !input.outlookSignedIn
    ? {
        ready: false,
        intent: 'outlook-event',
        connector: 'outlook',
        label: 'Outlook',
        action: 'Connect Outlook',
        reason: 'connect'
      }
    : !input.outlookCanWrite
      ? {
          ready: false,
          intent: 'outlook-event',
          connector: 'outlook',
          label: 'Outlook',
          action: 'Connect Outlook (calendar write needed)',
          reason: 'no-consent'
        }
      : {
          ready: true,
          intent: 'outlook-event',
          via: 'graph',
          label: 'Outlook',
          action: 'Create calendar event with no attendees (no invites)'
        }

  const nextFrom = (conn: McpConnection | undefined, kind: 'plane' | 'clickup', label: string): WriteTarget => {
    if (!conn?.connected) {
      return {
        ready: false,
        intent: 'next-steps',
        connector: kind,
        label,
        action: `Connect ${label}`,
        reason: 'connect'
      }
    }
    const tool = pickWriteTool(conn.tools ?? [], 'next-steps')
    if (!tool) {
      return {
        ready: false,
        intent: 'next-steps',
        connector: kind,
        label,
        action: `Connected, no write tool on this key`,
        reason: 'no-write-tool'
      }
    }
    return {
      ready: true,
      intent: 'next-steps',
      via: 'mcp',
      connectionId: kind,
      toolName: tool,
      label,
      action: `Create ${label} item (review first, never auto-send)`
    }
  }

  return [crm, outlookDraft, outlookEvent, nextFrom(plane, 'plane', 'Plane'), nextFrom(clickup, 'clickup', 'ClickUp')]
}
