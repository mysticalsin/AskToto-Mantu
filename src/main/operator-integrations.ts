/**
 * Operator integrations client (PLAN.md P2.2b #3): `GET /v1/integrations`, in-memory cache, refetch on
 * heartbeat's `integrationsVersion` change or every 6 h, and the credential lookups CRM push and the
 * desktop MCP client use.
 *
 * In-memory only, never on disk (the wire contract's own requirement — see the parser's doc comment):
 * this module holds no persistence of its own, and a relaunch starts with an empty cache until the next
 * successful fetch. That is the intended behaviour, not a gap — a stale on-disk credential a revoke or
 * rotate never reached would be strictly worse than a brief "not yet fetched" window after launch.
 *
 * Also owns the in-memory registration of Operator-delivered `custom-mcp` (and, generically, any other
 * kind's) connections into the desktop MCP client (mcpClient.ts's generic bearer + Streamable HTTP
 * transport) so Métis can call their tools the same way it calls a user's own pasted-key connection.
 */
import { hashOperatorId, operatorHmacHeaders } from './operator-hmac-sign'
import { getMachineId } from './license'
import { inspectBundleResponse } from '@shared/bundle-response'
import {
  parseOperatorIntegrationsResponse,
  type OperatorIntegration,
  type OperatorIntegrationKind
} from '@shared/operator-entitlements'
import { connectMcp, pushToMcp, type McpPushResult } from './mcp/mcpClient'
import { mainLog } from './logger'

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface OperatorIntegrationsCache {
  version: number
  /** Epoch ms this cache entry was fetched. 0 = never fetched. */
  fetchedAt: number
  integrations: OperatorIntegration[]
}

export function emptyOperatorIntegrationsCache(): OperatorIntegrationsCache {
  return { version: 0, fetchedAt: 0, integrations: [] }
}

/** Pure: refetch when nothing has been fetched yet, the heartbeat-reported version moved, or the 6 h
 *  cache has gone stale. */
export function shouldRefetchOperatorIntegrations(
  cache: OperatorIntegrationsCache,
  latestVersion: number,
  now: number
): boolean {
  if (cache.fetchedAt <= 0) return true
  if (latestVersion !== cache.version) return true
  return now - cache.fetchedAt >= REFRESH_INTERVAL_MS
}

export interface OperatorMcpRegistration {
  id: string
  kind: OperatorIntegrationKind
  label: string
  baseUrl: string
  credential: string
  /** undefined = not discovered yet (or needs rediscovery after a credential/endpoint change); an
   *  actual [] means the server was reached and genuinely declared zero tools. */
  tools?: string[]
}

/**
 * Reconcile the desktop MCP registry against a fresh integrations list (PLAN.md coordinator addition:
 * register / replace-on-version-change / remove). Pure — no network, no mutation of `current`.
 *
 * - Register: an id present in `integrations` but not in `current` becomes a new entry.
 * - Replace: an id present in both, with a changed baseUrl/credential/kind, keeps its id but drops its
 *   cached `tools` so the caller knows to rediscover them; unchanged connections keep their tools as-is.
 * - Remove: an id in `current` but absent from `integrations` (Operator stopped delivering it) is
 *   dropped — `next` is built fresh from `integrations` alone, nothing is carried over unless it's
 *   still present in the new list.
 *
 * An integration with no baseUrl or no credential yet (Worker hasn't finished configuring it) is
 * skipped entirely — there is nothing to connect to.
 */
export function reconcileOperatorMcpRegistry(
  current: ReadonlyMap<string, OperatorMcpRegistration>,
  integrations: readonly OperatorIntegration[]
): Map<string, OperatorMcpRegistration> {
  const next = new Map<string, OperatorMcpRegistration>()
  for (const it of integrations) {
    if (!it.baseUrl || !it.credential) continue
    const prev = current.get(it.id)
    const unchanged =
      !!prev && prev.baseUrl === it.baseUrl && prev.credential === it.credential && prev.kind === it.kind
    next.set(it.id, {
      id: it.id,
      kind: it.kind,
      label: it.label,
      baseUrl: it.baseUrl,
      credential: it.credential,
      tools: unchanged ? prev!.tools : undefined
    })
  }
  return next
}

let fetchImpl: typeof fetch = fetch
export function setOperatorIntegrationsFetchForTests(fn: typeof fetch | null): void {
  fetchImpl = fn ?? fetch
}

let integrationsCache: OperatorIntegrationsCache = emptyOperatorIntegrationsCache()
let mcpRegistry: Map<string, OperatorMcpRegistration> = new Map()
let inFlight: Promise<OperatorIntegration[] | null> | null = null

export function resetOperatorIntegrationsStateForTests(): void {
  integrationsCache = emptyOperatorIntegrationsCache()
  mcpRegistry = new Map()
  inFlight = null
}

/** Best-effort tool discovery for any registered connection missing `tools` — never blocks the caller
 *  that triggered the reconcile, never throws. A connection superseded mid-discovery (a second fetch
 *  landed with a different credential/endpoint before this one returned) is left alone. */
async function refreshOperatorMcpTools(): Promise<void> {
  const pending = [...mcpRegistry.entries()].filter(([, reg]) => reg.tools === undefined)
  await Promise.all(
    pending.map(async ([id, reg]) => {
      try {
        const result = await connectMcp(reg.baseUrl, reg.credential, {}, reg.label)
        const stillCurrent = mcpRegistry.get(id)
        if (!stillCurrent || stillCurrent.baseUrl !== reg.baseUrl || stillCurrent.credential !== reg.credential) return
        mcpRegistry.set(id, { ...stillCurrent, tools: result.ok ? result.tools ?? [] : [] })
      } catch (e) {
        mainLog.warn(`[operator-integrations] tool discovery failed for ${reg.label}:`, e)
      }
    })
  )
}

function applyIntegrations(version: number, integrations: OperatorIntegration[], now: number): void {
  integrationsCache = { version, fetchedAt: now, integrations }
  mcpRegistry = reconcileOperatorMcpRegistry(mcpRegistry, integrations)
  void refreshOperatorMcpTools()
}

export interface OperatorIntegrationsSettings {
  operatorUrl?: string
  operatorIngestSecret?: string
}

/**
 * `GET /v1/integrations`, HMAC-signed like the manifest GET (empty body). Concurrent callers share one
 * in-flight request. Returns null on any failure (network, non-2xx, malformed body, not-entitled) —
 * callers that only care "do we have anything" should read operatorIntegrationFor /
 * registeredOperatorMcpServers instead of this return value, since a transient fetch failure must not
 * wipe a still-good cache from an earlier successful fetch.
 */
export async function fetchOperatorIntegrations(
  settings: OperatorIntegrationsSettings,
  now: number = Date.now()
): Promise<OperatorIntegration[] | null> {
  const url = (settings.operatorUrl || '').trim().replace(/\/$/, '')
  const secret = (settings.operatorIngestSecret || '').trim()
  if (!url || !secret) return null
  if (inFlight) return inFlight
  const attempt = (async (): Promise<OperatorIntegration[] | null> => {
    try {
      const deviceId = hashOperatorId(getMachineId())
      const headers = operatorHmacHeaders(secret, deviceId, '')
      const res = await fetchImpl(`${url}/v1/integrations`, { method: 'GET', headers })
      if (res.status === 403) {
        // Seat not entitled: an empty grant, not an error to retry hot. Clears any previously-cached
        // (now stale) integrations for a seat whose entitlement was just revoked.
        applyIntegrations(integrationsCache.version, [], now)
        return []
      }
      const text = await res.text()
      const inspected = inspectBundleResponse({
        status: res.status,
        contentType: res.headers.get('content-type'),
        location: res.headers.get('location'),
        bodyPrefix: text.slice(0, 1024),
        expected: 'json'
      })
      if (!inspected.ok || !res.ok) {
        mainLog.warn(`[operator-integrations] fetch failed: ${res.status}`)
        return null
      }
      let json: unknown = null
      try {
        json = JSON.parse(text)
      } catch {
        return null
      }
      const parsed = parseOperatorIntegrationsResponse(json)
      if (!parsed) return null
      applyIntegrations(parsed.version, parsed.integrations, now)
      return parsed.integrations
    } catch (e) {
      mainLog.warn('[operator-integrations] fetch threw:', e)
      return null
    }
  })()
  inFlight = attempt
  try {
    return await attempt
  } finally {
    inFlight = null
  }
}

/** Called after every successful heartbeat with its reported `integrationsVersion`. No-op (no network
 *  call at all) when the cache is already fresh for that version. */
export function maybeRefreshOperatorIntegrations(
  settings: OperatorIntegrationsSettings,
  latestVersion: number,
  now: number = Date.now()
): void {
  if (!shouldRefetchOperatorIntegrations(integrationsCache, latestVersion, now)) return
  void fetchOperatorIntegrations(settings, now)
}

export function operatorIntegrationsSnapshot(): OperatorIntegrationsCache {
  return integrationsCache
}

export function operatorIntegrationFor(kind: OperatorIntegrationKind): OperatorIntegration | null {
  return integrationsCache.integrations.find((i) => i.kind === kind) ?? null
}

/** For Settings' "Managed by Operator" rows — every currently-registered MCP connection, tool names
 *  once discovered. */
export function registeredOperatorMcpServers(): OperatorMcpRegistration[] {
  return [...mcpRegistry.values()]
}

export function operatorMcpServer(id: string): OperatorMcpRegistration | null {
  return mcpRegistry.get(id) ?? null
}

/** Call a tool on an Operator-registered MCP connection (the read/write path the coordinator's addition
 *  asked for). Refuses an unknown connection id and an unlisted tool name the same way the local
 *  mcpPush IPC handler does for a user's own connections — an Operator-managed connection is not exempt
 *  from the "only a tool the seat actually saw" invariant. */
export async function callOperatorMcpTool(
  id: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<McpPushResult> {
  const reg = mcpRegistry.get(id)
  if (!reg) return { ok: false, error: 'This Operator connection is not available.' }
  if (reg.tools && !reg.tools.includes(toolName)) {
    return { ok: false, error: `Unknown ${reg.label} tool.` }
  }
  return pushToMcp(reg.baseUrl, reg.credential, {}, toolName, args, reg.label)
}

// ── CRM push credential substitution (PLAN.md P2.2b #3) ──────────────────────────────────────────────

/** Kinds the LOCAL mcpConnections model (bidstack/clickup/plane) and Operator's integration vocabulary
 *  both use, where an Operator-supplied bearer credential is a safe drop-in for the exact same generic
 *  bearer + Streamable HTTP transport mcpClient.ts already uses for a user's own pasted key.
 *
 *  'clickup' is deliberately excluded even though it's a valid Operator integration kind: the local
 *  ClickUp flow's list-discovery step (discoverListForClickup) calls ClickUp's own REST API expecting a
 *  real ClickUp OAuth workspace token, which an Operator-issued generic credential cannot stand in for
 *  without a materially different implementation. 'bidstack' has no Operator equivalent at all. */
const CRM_OPERATOR_SUBSTITUTABLE_KINDS: ReadonlySet<string> = new Set<OperatorIntegrationKind>(['plane'])

export interface OperatorCrmCredential {
  endpointUrl: string
  apiKey: string
  label: string
  /** Tools discovered so far for this connection; [] until discovery completes. */
  tools: string[]
}

/** An Operator-supplied credential for one of the local CRM connection kinds, or null when this kind
 *  isn't substitutable, the Worker hasn't delivered a matching integration, or it lacks a baseUrl/credential. */
export function operatorCrmCredentialFor(connectionKind: string): OperatorCrmCredential | null {
  if (!CRM_OPERATOR_SUBSTITUTABLE_KINDS.has(connectionKind)) return null
  const integration = operatorIntegrationFor(connectionKind as OperatorIntegrationKind)
  if (!integration || !integration.baseUrl || !integration.credential) return null
  const reg = mcpRegistry.get(integration.id)
  return { endpointUrl: integration.baseUrl, apiKey: integration.credential, label: integration.label, tools: reg?.tools ?? [] }
}

/** Pure decision: which credential actually got used for a CRM push, for the ingest event's
 *  `credentialSource` field. Local always wins when it's actually usable — Operator is a fallback for
 *  "no local key configured", never a silent override of one the user already set up. */
export function resolveCrmCredentialSource(localReady: boolean, hasOperatorCredential: boolean): 'operator' | 'local' {
  return localReady || !hasOperatorCredential ? 'local' : 'operator'
}
