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

/**
 * Fetch one space's data sources. The API key itself is validated once, up front, by the `/spaces` call
 * in fetchDustProjects — a failure fetching one space's own data sources (a transient error, a non-ok
 * status, or any other rejection) reports that space as having no data sources rather than failing the
 * whole listing, so the rest of the workspace's spaces stay usable.
 */
async function fetchSpaceDataSources(
  fetchImpl: FetchLike,
  base: string,
  workspaceId: string,
  headers: Record<string, string>,
  space: SpaceEntry
): Promise<DustProject[]> {
  try {
    const dsRes = await fetchImpl(
      `${base}/api/v1/w/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(space.sId)}/data_sources`,
      { headers }
    )
    if (!dsRes.ok) return []
    const dsJson = await dsRes.json()
    return parseDataSources(dsJson, space.sId)
  } catch {
    return []
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

  // Lookups run concurrently; results stay index-aligned with spaceEntries so they can be zipped back
  // together below. Neither Dust endpoint here paginates (no cursor/page/limit/has_more field on GET
  // .../spaces or GET .../spaces/{spaceId}/data_sources), so there is no further page to fetch.
  const dsResults = await Promise.all(
    spaceEntries.map((space) => fetchSpaceDataSources(fetchImpl, base, workspaceId, headers, space))
  )

  const projects: DustProject[] = []
  spaceEntries.forEach((space, i) => {
    projects.push({ sId: space.sId, name: space.name, kind: space.kind, source: 'space' })
    projects.push(...dsResults[i])
  })

  return { ok: true, projects }
}
