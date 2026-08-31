import { describe, it, expect, vi } from 'vitest'
import {
  DEVON_SPOTLIGHT_REF_MAC_PATH,
  fetchDustProjects,
  matchDataAndAiProjects,
  type DustProject
} from './dust-projects'

describe('matchDataAndAiProjects', () => {
  it('keeps only names that look like Data or AI projects — does not invent any', () => {
    const input: DustProject[] = [
      { sId: '1', name: 'Data and AI', kind: 'regular', source: 'space' },
      { sId: '2', name: 'Sales wiki', kind: 'regular', source: 'space' },
      { sId: '3', name: 'AI enablement', kind: 'folder', source: 'data_source', spaceId: '1' }
    ]
    expect(matchDataAndAiProjects(input).map((p) => p.name)).toEqual(['Data and AI', 'AI enablement'])
  })
})

describe('fetchDustProjects', () => {
  it('lists spaces then data sources and records the names Dust actually returned', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/spaces')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            spaces: [
              { sId: 'spc_data', name: 'Data and AI', kind: 'regular' },
              { sId: 'spc_sales', name: 'Sales', kind: 'regular' }
            ]
          }),
          text: async () => ''
        }
      }
      if (url.includes('/spaces/spc_data/data_sources')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data_sources: [{ sId: 'ds_wiki', name: 'AI project wiki', connectorProvider: 'notion' }]
          }),
          text: async () => ''
        }
      }
      if (url.includes('/spaces/spc_sales/data_sources')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data_sources: [{ sId: 'ds_crm', name: 'CRM notes' }] }),
          text: async () => ''
        }
      }
      throw new Error(`unexpected url ${url}`)
    })

    const r = await fetchDustProjects({
      apiKey: 'sk-test',
      workspaceId: 'ws_1',
      fetchImpl
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.projects.map((p) => p.name)).toEqual(['Data and AI', 'AI project wiki', 'Sales', 'CRM notes'])
    expect(matchDataAndAiProjects(r.projects).map((p) => p.name)).toEqual(['Data and AI', 'AI project wiki'])
  })

  it('fails loud when the spaces endpoint is unauthorized — does not invent a list', async () => {
    const r = await fetchDustProjects({
      apiKey: 'sk-bad',
      workspaceId: 'ws_1',
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => 'invalid credentials'
      })
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/401/)
  })
})

describe('Devon Totos-Mac click path', () => {
  it('names Settings → AI, CLI Connect, Spotlight Ref, and the Data and AI projects ask', () => {
    expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('Settings (gear) → AI')
    expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('Connect Claude')
    expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('Connect Codex')
    expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('Spotlight Ref')
    expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('Data and AI projects')
    expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('GOr913Zr5V')
    expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('Never auto-send')
  })
})

describe('live Dust workspace (optional)', () => {
  it('fetches real spaces when DUST_API_KEY and DUST_WORKSPACE_ID are set; otherwise records that this VM cannot', async () => {
    const key = process.env.DUST_API_KEY?.trim()
    const workspaceId = process.env.DUST_WORKSPACE_ID?.trim()
    const baseUrl = process.env.DUST_BASE_URL?.trim()
    if (!key || !workspaceId) {
      expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('Totos-Mac')
      return
    }
    const r = await fetchDustProjects({ apiKey: key, workspaceId, baseUrl })
    expect(r.ok, r.ok ? '' : r.error).toBe(true)
    if (!r.ok) return
    const hits = matchDataAndAiProjects(r.projects)
    // eslint-disable-next-line no-console
    console.log(
      '[dust-projects live] all=',
      r.projects.map((p) => p.name),
      'dataAndAi=',
      hits.map((p) => p.name)
    )
    expect(Array.isArray(r.projects)).toBe(true)
  })
})
