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
          text: async (): Promise<string> => ''
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

  it("fetches every space's data sources concurrently, not one at a time (P4-F6)", async () => {
    const callOrder: string[] = []
    let resolveA: (() => void) | undefined
    const aWaitsForBToStart = new Promise<void>((resolve) => {
      resolveA = resolve
    })

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/spaces')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            spaces: [
              { sId: 'a', name: 'A', kind: 'regular' },
              { sId: 'b', name: 'B', kind: 'regular' }
            ]
          }),
          text: async (): Promise<string> => ''
        }
      }
      if (url.includes('/spaces/a/data_sources')) {
        callOrder.push('a-start')
        // A blocks here until B's own fetch has started. Under the OLD sequential `for`-loop this never
        // unblocks (B is never even dispatched until A resolves) and the test times out; concurrent
        // dispatch (Promise.all) starts B immediately, which unblocks A.
        await aWaitsForBToStart
        callOrder.push('a-end')
        return { ok: true, status: 200, json: async () => ({ data_sources: [] }), text: async () => '' }
      }
      if (url.includes('/spaces/b/data_sources')) {
        callOrder.push('b-start')
        resolveA?.()
        return { ok: true, status: 200, json: async () => ({ data_sources: [] }), text: async () => '' }
      }
      throw new Error(`unexpected url ${url}`)
    })

    const r = await fetchDustProjects({ apiKey: 'sk-test', workspaceId: 'ws_1', fetchImpl })
    expect(r.ok).toBe(true)
    expect(callOrder).toEqual(['a-start', 'b-start', 'a-end'])
  }, 2000)

  it('fails loud instead of silently reporting zero data sources when the key is rejected mid-discovery (AGUC-021)', async () => {
    const r = await fetchDustProjects({
      apiKey: 'sk-revoked',
      workspaceId: 'ws_1',
      fetchImpl: async (url: string) => {
        if (url.endsWith('/spaces')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ spaces: [{ sId: 'spc_data', name: 'Data and AI', kind: 'regular' }] }),
            text: async () => ''
          }
        }
        return { ok: false, status: 401, json: async () => ({}), text: async () => 'token revoked' }
      }
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/401/)
    expect(r.error).toMatch(/reconnect/i)
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
    expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('managed Dust CLI')
    expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('--sId GOr913Zr5V')
    expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('never --with-tools')
    expect(DEVON_SPOTLIGHT_REF_MAC_PATH).toContain('READY TO MERGE stays no')
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
