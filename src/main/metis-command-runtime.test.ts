import { describe, expect, it, vi } from 'vitest'
import { createMetisCommandRuntime } from './metis-command-runtime'

describe('Cap2 command runtime', () => {
  it('deterministic execute works with Jev OFF', async () => {
    const states: string[] = []
    const rt = createMetisCommandRuntime({
      onState: (s) => states.push(`${s.phase}:${s.pending.map((p) => p.id).join(',')}`),
      jevEnabled: () => false,
      platform: 'linux' // unsupported execute → still exercises parse/commit path without OS apps
    })
    rt.ingestTranscript('Métis', 'command')
    expect(rt.getState().active).toBe(true)
    expect(rt.getState().chime).toBe('single')
    rt.ingestTranscript('Métis open notes', 'command')
    expect(rt.getState().pending[0]?.id).toBe('desktop.open_notes')
    // allow flush
    await new Promise((r) => setTimeout(r, 30))
    expect(rt.getState().committed).toContain('desktop.open_notes')
  })

  it('meeting transcript without wake never activates', () => {
    const rt = createMetisCommandRuntime({ onState: () => {}, jevEnabled: () => true })
    rt.ingestTranscript('open notes', 'meeting')
    expect(rt.getState().active).toBe(false)
  })

  it('stopLocal does not wait on decide', () => {
    const fetchImpl = vi.fn(
      () =>
        new Promise(() => {
          /* hang forever */
        })
    ) as unknown as typeof fetch
    const rt = createMetisCommandRuntime({
      onState: () => {},
      jevEnabled: () => true,
      operatorDecideAuth: () => ({
        baseUrl: 'https://metis-operator.tony-walteur.workers.dev',
        authorizationHeader: 'Bearer x'
      }),
      fetchImpl
    })
    rt.ingestTranscript('Métis', 'always')
    const t0 = Date.now()
    rt.stopLocal('escape')
    expect(Date.now() - t0).toBeLessThan(100)
    expect(rt.getState().reason === 'escape' || rt.getState().phase === 'deactivating' || !rt.getState().active).toBe(
      true
    )
  })
})
