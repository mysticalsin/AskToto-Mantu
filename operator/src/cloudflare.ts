import { OPERATOR_D1_ID, OPERATOR_D1_NAME, OPERATOR_WORKER } from './vault'

export const CF_TOKEN_MISSING = 'Cloudflare token missing. Connect it on Keys.'
export const CF_TOKEN_REJECTED = 'Cloudflare API rejected the token. Rotate it on Keys.'

export type CloudflareOverview = {
  worker: typeof OPERATOR_WORKER
  connected: boolean
  error: string | null
  requests: number | null
  errors: number | null
  cpuMs: number | null
  range: string
  workers: string[]
  d1Name: string | null
  d1Id: string | null
}

export function missingCloudflareOverview(range = '24h'): CloudflareOverview {
  return {
    worker: OPERATOR_WORKER,
    connected: false,
    error: CF_TOKEN_MISSING,
    requests: null,
    errors: null,
    cpuMs: null,
    range,
    workers: [],
    d1Name: null,
    d1Id: null
  }
}

type CfFetch = (input: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number
  json(): Promise<unknown>
}>

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  }
}

function asList(result: unknown): { name?: string; uuid?: string; id?: string }[] {
  if (!result || typeof result !== 'object') return []
  const r = result as { result?: unknown }
  return Array.isArray(r.result) ? (r.result as { name?: string; uuid?: string; id?: string }[]) : []
}

function graphqlTotals(json: unknown): { requests: number; errors: number; cpuMs: number } | null {
  const data = json && typeof json === 'object' ? (json as { data?: { viewer?: { accounts?: { workersInvocationsAdaptive?: { sum?: { requests?: number; errors?: number; cpuTimeMs?: number } }[] }[] } } }).data : null
  const rows = data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive
  if (!Array.isArray(rows) || !rows.length) return { requests: 0, errors: 0, cpuMs: 0 }
  let requests = 0
  let errors = 0
  let cpuMs = 0
  for (const row of rows) {
    requests += Number(row.sum?.requests ?? 0)
    errors += Number(row.sum?.errors ?? 0)
    cpuMs += Number(row.sum?.cpuTimeMs ?? 0)
  }
  return { requests, errors, cpuMs }
}

export async function pullCloudflareOverview(opts: {
  accountId: string
  token: string
  range?: string
  fetchImpl?: CfFetch
  now?: number
}): Promise<CloudflareOverview> {
  const range = opts.range ?? '24h'
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as CfFetch)
  const now = opts.now ?? Date.now()
  const hours = range === '30d' ? 30 * 24 : range === '7d' ? 7 * 24 : 24
  const datetimeStart = new Date(now - hours * 60 * 60 * 1000).toISOString()
  const headers = authHeaders(opts.token)
  const accountId = opts.accountId.trim()

  const scriptsRes = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`, {
    method: 'GET',
    headers
  })
  if (scriptsRes.status === 401 || scriptsRes.status === 403) {
    return { ...missingCloudflareOverview(range), connected: true, error: CF_TOKEN_REJECTED }
  }
  if (scriptsRes.status < 200 || scriptsRes.status >= 300) {
    return {
      ...missingCloudflareOverview(range),
      connected: true,
      error: `Cloudflare Workers list failed (${scriptsRes.status}).`
    }
  }
  const scriptsJson = await scriptsRes.json()
  const workers = asList(scriptsJson)
    .map((s) => (typeof s.id === 'string' ? s.id : typeof s.name === 'string' ? s.name : ''))
    .filter(Boolean)

  const d1Res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
    method: 'GET',
    headers
  })
  let d1Name: string | null = null
  let d1Id: string | null = null
  if (d1Res.status >= 200 && d1Res.status < 300) {
    const d1s = asList(await d1Res.json())
    const hit =
      d1s.find((d) => d.uuid === OPERATOR_D1_ID || d.id === OPERATOR_D1_ID) ??
      d1s.find((d) => d.name === OPERATOR_D1_NAME)
    d1Name = hit?.name ?? OPERATOR_D1_NAME
    d1Id = (hit?.uuid || hit?.id) ?? OPERATOR_D1_ID
  }

  const gql = await fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: `query($accountTag: string!, $scriptName: string!, $datetimeStart: string!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            workersInvocationsAdaptive(
              limit: 1
              filter: { scriptName: $scriptName, datetime_geq: $datetimeStart }
            ) { sum { requests errors cpuTimeMs } }
          }
        }
      }`,
      variables: {
        accountTag: accountId,
        scriptName: OPERATOR_WORKER,
        datetimeStart
      }
    })
  })
  let requests: number | null = null
  let errors: number | null = null
  let cpuMs: number | null = null
  if (gql.status >= 200 && gql.status < 300) {
    const totals = graphqlTotals(await gql.json())
    if (totals) {
      requests = totals.requests
      errors = totals.errors
      cpuMs = Math.round(totals.cpuMs)
    }
  }

  return {
    worker: OPERATOR_WORKER,
    connected: true,
    error: null,
    requests,
    errors,
    cpuMs,
    range,
    workers,
    d1Name,
    d1Id
  }
}
