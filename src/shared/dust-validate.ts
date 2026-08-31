/**
 * Instant Dust connection proof — a live list of agents, not a saved-key green check.
 *
 * Settings used to paint "Connected. Loading agents…" (or "Dust is connected.") as soon as a key +
 * workspace were persisted. That lied: getAgentConfigurations({}) without view:'list' can succeed
 * while the pickable list is empty/restricted, and a 401 or dead CLI session only showed up at ask
 * time. Instant validate must live-ping Dust and fail loud before claiming Connected.
 *
 * Never auto-sends a chat. The ping is getAgentConfigurations({ view: 'list' }) only.
 */

export const DUST_WORKSPACE_MISSING_ERROR = 'Add your Dust workspace ID first.'
export const DUST_WORKSPACE_MISSING_SETUP_ERROR =
  'Add your Dust workspace ID in the Dust setup below first.'
export const DUST_EMPTY_AGENTS_ERROR =
  'Dust returned no agents. Check workspace access — an empty or restricted list is not a working connection.'
export const DUST_UNAUTHORIZED_ERROR =
  'Dust rejected this session (401). Sign in again or check the API key.'
export const DUST_SESSION_DEAD_ERROR =
  'Your Dust session ended. Sign in again — or use the automatic sign-in above.'
export const DUST_VALIDATE_FAILED_ERROR =
  'Could not prove the Dust connection. Check the key + workspace, then retry.'

export type DustValidateAgent = { sId: string; name: string }
export type DustValidatePing = { ok: boolean; error?: string }
export type DustValidateList = { ok: boolean; agents?: DustValidateAgent[]; error?: string }

export type DustInstantValidateReason =
  | 'workspace-missing'
  | 'unauthorized'
  | 'empty-agents'
  | 'session-dead'
  | 'error'

export type DustInstantValidateFailure = {
  ok: false
  reason: DustInstantValidateReason
  message: string
}

export type DustInstantValidateSuccess = {
  ok: true
  agentCount: number
  selectedName?: string
  message: string
}

export type DustInstantValidateResult = DustInstantValidateSuccess | DustInstantValidateFailure

export type DustInstantValidateInput = {
  workspaceId?: string
  /** testApiKey ping (getAgentConfigurations). Optional only while a call is still in flight. */
  test?: DustValidatePing | null
  /** listDustAgents with view:'list'. Empty/restricted is not success. */
  list?: DustValidateList | null
}

/** Auth-shaped Dust errors (401, expired token, invalid credential). Same family as isDustAuthError. */
export function isDustValidateAuthError(error: string | undefined): boolean {
  if (!error) return false
  const blob = error.toLowerCase()
  return (
    /\b401\b/.test(blob) ||
    /oauth|unauthor|expired|invalid.*(token|credential)|authenticat\w*\s+credential|credential.*authenticat/.test(
      blob
    )
  )
}

export function isDustValidateSessionDead(error: string | undefined): boolean {
  if (!error) return false
  const blob = error.toLowerCase()
  return /session ended|session (is )?(dead|gone)|no dust cli session|dust logout|unrecoverable/.test(
    blob
  )
}

export function formatDustConnectedMessage(input: {
  agentCount: number
  selectedName?: string
  selectedId?: string
  workspaceId?: string
}): string {
  const n = input.agentCount
  const parts = ['Connected.']
  const ws = input.workspaceId?.trim()
  if (ws) parts.push(`Workspace ${ws}.`)
  parts.push(`${n} agent${n === 1 ? '' : 's'}.`)
  const base = input.selectedName?.trim() || input.selectedId?.trim()
  if (base) parts.push(`Base: ${base}.`)
  return parts.join(' ')
}

function fail(reason: DustInstantValidateReason, message: string): DustInstantValidateFailure {
  return { ok: false, reason, message }
}

function classifyPingError(error: string | undefined): DustInstantValidateFailure {
  if (isDustValidateAuthError(error)) {
    return fail('unauthorized', error?.trim() || DUST_UNAUTHORIZED_ERROR)
  }
  if (isDustValidateSessionDead(error)) {
    return fail('session-dead', error?.trim() || DUST_SESSION_DEAD_ERROR)
  }
  if (error && /no agents|empty or restricted/i.test(error)) {
    return fail('empty-agents', error)
  }
  return fail('error', error?.trim() || DUST_VALIDATE_FAILED_ERROR)
}

/**
 * Success only when a live agent list actually loaded. A green "Connected" from a saved key, a
 * credential ping that ignored `view:'list'`, or an empty list is not enough.
 */
export function decideDustInstantValidate(
  input: DustInstantValidateInput,
  selectedAgentId?: string
): DustInstantValidateResult {
  const workspaceId = input.workspaceId?.trim() ?? ''
  if (!workspaceId) {
    return fail('workspace-missing', DUST_WORKSPACE_MISSING_SETUP_ERROR)
  }

  if (input.test && !input.test.ok) {
    return classifyPingError(input.test.error)
  }

  if (!input.list) {
    return fail('error', DUST_VALIDATE_FAILED_ERROR)
  }
  if (!input.list.ok) {
    return classifyPingError(input.list.error)
  }

  const agents = input.list.agents ?? []
  if (agents.length === 0) {
    return fail('empty-agents', DUST_EMPTY_AGENTS_ERROR)
  }

  const selectedName = selectedAgentId
    ? agents.find((a) => a.sId === selectedAgentId)?.name
    : undefined
  return {
    ok: true,
    agentCount: agents.length,
    selectedName,
    message: formatDustConnectedMessage({
      agentCount: agents.length,
      selectedName,
      selectedId: selectedName ? undefined : selectedAgentId,
      workspaceId
    })
  }
}

/**
 * Live-ping Dust: credential test + view:'list' agent fetch. Callers must not treat ok:true as a
 * license to send a chat — this is a connection test only.
 */
export async function proveDustConnection(deps: {
  workspaceId: string
  selectedAgentId?: string
  testApiKey: () => Promise<DustValidatePing>
  listAgents: () => Promise<DustValidateList>
}): Promise<DustInstantValidateResult> {
  const workspaceId = deps.workspaceId.trim()
  if (!workspaceId) {
    return fail('workspace-missing', DUST_WORKSPACE_MISSING_SETUP_ERROR)
  }
  const [test, list] = await Promise.all([deps.testApiKey(), deps.listAgents()])
  return decideDustInstantValidate({ workspaceId, test, list }, deps.selectedAgentId)
}
