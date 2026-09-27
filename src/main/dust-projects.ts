/**
 * Dust spaces + data sources ("projects" in Tony's wording). Spotlight Ref searches this corpus.
 * The cloud VM usually cannot call Totos-Mac's Dust; the live test hits the same endpoints when
 * DUST_API_KEY + DUST_WORKSPACE_ID are set, otherwise it records the Settings click path Devon runs.
 */

export type DustProject = {
  sId: string
  name: string
  kind: string
  source: 'space' | 'data_source'
  spaceId?: string
}

export type DustProjectsResult =
  | { ok: true; projects: DustProject[] }
  | { ok: false; error: string }

const DATA_AND_AI = /\bdata\b|\bai\b|artificial intelligence/i

/** Names that look like the "Data and AI projects" test query. Does not invent names. */
export function matchDataAndAiProjects(projects: readonly DustProject[]): DustProject[] {
  return projects.filter((p) => DATA_AND_AI.test(p.name))
}

export const DEVON_SPOTLIGHT_REF_MAC_PATH = [
  'Totos-Mac: open Métis.',
  'Settings (gear) → AI.',
  'Dust card: Set up Dust automatically — this installs the managed Dust CLI into userData/managed-cli/dust, then signs in. Confirm the workspace hosts Spotlight Ref (GOr913Zr5V). Do not treat a REST view:list omission as a reason to reconnect.',
  'CLI Integration: Connect Claude Code. Expect Connected, or "Signed in. Weekly usage limit reached" — never "not connected" for a weekly cap. Never auto-send a prompt.',
  'CLI Integration: Connect Codex. Expect Connected (codex login status = Logged in using ChatGPT). If it fails while the terminal says logged in, that is a Métis probe bug.',
  'Close Settings. Click Spotlight Ref on the bar.',
  'Ask: Data and AI projects.',
  'Métis must spawn managed dust chat --sId GOr913Zr5V -m … (never --with-tools). Record the project names the CLI agent returns. Do not invent a list.',
  'READY TO MERGE stays no until this Mac-show through the installed Dust CLI.'
].join('\n')

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

type SpaceEntry = { sId: string; name: string; kind: string }

function parseSpace(raw: unknown): SpaceEntry | null {
  const s = asRecord(raw)
  if (!s) return null
  const sId = typeof s.sId === 'string' ? s.sId : typeof s.id === 'string' ? s.id : ''
  if (!sId) return null
  const name = typeof s.name === 'string' ? s.name : sId
  const kind = typeof s.kind === 'string' ? s.kind : 'space'
  return { sId, name, kind }
}

function parseDataSources(dsJson: unknown, spaceId: string): DustProject[] {
  const sources = asArray(asRecord(dsJson)?.data_sources ?? asRecord(dsJson)?.dataSources)
  const out: DustProject[] = []
  for (const raw of sources) {
    const d = asRecord(raw)
    if (!d) continue
    const dsId =
      typeof d.sId === 'string'
        ? d.sId
        : typeof d.id === 'string'
          ? d.id
          : typeof d.name === 'string'
            ? d.name
            : ''
    if (!dsId) continue
    const dsName = typeof d.name === 'string' ? d.name : dsId
    out.push({
      sId: dsId,
      name: dsName,
      kind: typeof d.connectorProvider === 'string' ? d.connectorProvider : 'data_source',
      source: 'data_source',
      spaceId
    })
  }
  return out
}

type SpaceDataSourcesResult =
  | { rejected: false; dataSources: DustProject[] }
  | { rejected: true; error: string }

/**
 * Fetch one space's data sources. A 401/403 here means the API key itself was rejected (the same key
 * backs every space's call), so it is reported as `rejected` rather than swallowed — silently continuing
 * would return an `ok: true` result with every space showing zero data sources, which reads as "this
 * workspace has no data sources" rather than the true "the connector token was rejected" (AGUC-021).
 * Any other failure (a transient error, or a single space genuinely erroring for its own reason) still
 * must not drop the rest of the space list, so it resolves with an empty data-source list instead.
 */
async function fetchSpaceDataSources(
  fetchImpl: FetchLike,
  base: string,
  workspaceId: string,
  headers: Record<string, string>,
  space: SpaceEntry
): Promise<SpaceDataSourcesResult> {
  try {
    const dsRes = await fetchImpl(
      `${base}/api/v1/w/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(space.sId)}/data_sources`,
      { headers }
    )
    if (dsRes.status === 401 || dsRes.status === 403) {
      const body = await dsRes.text().catch(() => '')
      return {
        rejected: true,
        error: `Dust rejected the API key while listing "${space.name}"'s data sources (${dsRes.status}${
          body ? `: ${body.slice(0, 180)}` : ''
        }). Reconnect Dust.`
      }
    }
    if (!dsRes.ok) return { rejected: false, dataSources: [] }
    const dsJson = await dsRes.json()
    return { rejected: false, dataSources: parseDataSources(dsJson, space.sId) }
  } catch {
    return { rejected: false, dataSources: [] }
  }
}

export async function fetchDustProjects(opts: {
  apiKey: string
  workspaceId: string
  baseUrl?: string
  fetchImpl?: FetchLike
}): Promise<DustProjectsResult> {
  const key = opts.apiKey.trim()
  const workspaceId = opts.workspaceId.trim()
  if (!key) return { ok: false, error: 'Dust API key is missing.' }
  if (!workspaceId) return { ok: false, error: 'Dust workspace id is missing.' }

  const base = (opts.baseUrl || 'https://dust.tt').replace(/\/$/, '')
  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as FetchLike)
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' }

  let spacesJson: unknown
  try {
    const res = await fetchImpl(`${base}/api/v1/w/${encodeURIComponent(workspaceId)}/spaces`, { headers })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `Dust spaces ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}` }
    }
    spacesJson = await res.json()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const spaceEntries = asArray(asRecord(spacesJson)?.spaces ?? asRecord(spacesJson)?.data)
    .map(parseSpace)
    .filter((s): s is SpaceEntry => s !== null)

  // Every space's data-source lookup is an independent round trip against the same workspace — run them
  // concurrently instead of one at a time (M2-0144 / review finding P4-F6). Neither Dust endpoint here
  // paginates (verified against the live API reference, 2026-09-26: no cursor/page/limit/has_more field
  // on GET .../spaces or GET .../spaces/{spaceId}/data_sources), so AGUC-022 does not apply to this pair.
  const dsResults = await Promise.all(
    spaceEntries.map((space) => fetchSpaceDataSources(fetchImpl, base, workspaceId, headers, space))
  )

  const rejected = dsResults.find((r): r is { rejected: true; error: string } => r.rejected)
  if (rejected) return { ok: false, error: rejected.error }

  const projects: DustProject[] = []
  spaceEntries.forEach((space, i) => {
    projects.push({ sId: space.sId, name: space.name, kind: space.kind, source: 'space' })
    const result = dsResults[i]
    if (!result.rejected) projects.push(...result.dataSources)
  })

  return { ok: true, projects }
}
