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
  'Dust card: confirm the workspace is the one that hosts Spotlight Ref (managed agent GOr913Zr5V). If the agent name/sId shows, Dust is on that workspace — do not reconnect to a different one.',
  'CLI Integration: Connect Claude Code. Expect Connected, or "Signed in. Weekly usage limit reached" — never "not connected" for a weekly cap. Never auto-send a prompt.',
  'CLI Integration: Connect Codex. Expect Connected (codex login status = Logged in using ChatGPT). If it fails while the terminal says logged in, that is a Métis probe bug.',
  'Close Settings. Click Spotlight Ref on the bar.',
  'Ask: Data and AI projects.',
  'Record the project / space / data-source names the agent returns. Do not invent a list.'
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

  const spaces = asArray(asRecord(spacesJson)?.spaces ?? asRecord(spacesJson)?.data)
  const projects: DustProject[] = []

  for (const raw of spaces) {
    const s = asRecord(raw)
    if (!s) continue
    const sId = typeof s.sId === 'string' ? s.sId : typeof s.id === 'string' ? s.id : ''
    const name = typeof s.name === 'string' ? s.name : sId
    if (!sId) continue
    const kind = typeof s.kind === 'string' ? s.kind : 'space'
    projects.push({ sId, name, kind, source: 'space' })

    try {
      const dsRes = await fetchImpl(
        `${base}/api/v1/w/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(sId)}/data_sources`,
        { headers }
      )
      if (!dsRes.ok) continue
      const dsJson = await dsRes.json()
      const sources = asArray(asRecord(dsJson)?.data_sources ?? asRecord(dsJson)?.dataSources)
      for (const dRaw of sources) {
        const d = asRecord(dRaw)
        if (!d) continue
        const dsId =
          typeof d.sId === 'string'
            ? d.sId
            : typeof d.id === 'string'
              ? d.id
              : typeof d.name === 'string'
                ? d.name
                : ''
        const dsName = typeof d.name === 'string' ? d.name : dsId
        if (!dsId) continue
        projects.push({
          sId: dsId,
          name: dsName,
          kind: typeof d.connectorProvider === 'string' ? d.connectorProvider : 'data_source',
          source: 'data_source',
          spaceId: sId
        })
      }
    } catch {
      /* a single space's data sources failing must not drop the space list */
    }
  }

  return { ok: true, projects }
}
