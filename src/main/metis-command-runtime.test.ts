import { describe, expect, it, vi } from 'vitest'
import { createMetisCommandRuntime, METIS_COMMAND_IDLE_TIMEOUT_MS } from './metis-command-runtime'

describe('Cap2 command runtime', () => {
  it('deterministic execute works with Jev OFF', async () => {
    const states: string[] = []
    const rt = createMetisCommandRuntime({
      onState: (s) => states.push(`${s.phase}:${s.pending.map((p) => p.id).join(',')}`),
      jevEnabled: () => false,
      platform: 'linux' // unsupported execute → still exercises parse/commit path without OS apps
    })
    rt.ingestTranscript('Hey Métis', 'command')
    expect(rt.getState().active).toBe(true)
    expect(rt.getState().chime).toBe('single')
    rt.ingestTranscript('Hey Métis open notes', 'command')
    expect(rt.getState().pending[0]?.id).toBe('desktop.open_notes')
    // allow flush
    await new Promise((r) => setTimeout(r, 30))
    expect(rt.getState().committed).toContain('desktop.open_notes')
  })

  it('meeting transcript without wake never activates', () => {
    const rt = createMetisCommandRuntime({ onState: () => {}, jevEnabled: () => true })
    rt.ingestTranscript('Hey Métis open notes', 'meeting')
    expect(rt.getState().active).toBe(false)
    expect(rt.getState().pending).toEqual([])
  })

  it('moves the pill to listening after a same-utterance command', async () => {
    vi.useFakeTimers()
    try {
      const rt = createMetisCommandRuntime({ onState: () => {}, platform: 'linux' })
      rt.ingestTranscript('Hey Métis open notes', 'command')
      expect(rt.getState().pillCopy).toBe('Hi Métis')
      await vi.advanceTimersByTimeAsync(450)
      expect(rt.getState().pillCopy).toContain('listening')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains a command that arrives while an earlier action is committing', async () => {
    const rt = createMetisCommandRuntime({ onState: () => {}, platform: 'linux' })
    rt.ingestTranscript('Hey Métis open notes', 'command')
    rt.ingestTranscript('open Arc', 'command')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(rt.getState().committed).toEqual(
      expect.arrayContaining(['desktop.open_notes', 'desktop.open_arc'])
    )
    expect(rt.getState().pending).toEqual([])
  })

  it('expires command authority after local-microphone inactivity', async () => {
    vi.useFakeTimers()
    try {
      const rt = createMetisCommandRuntime({ onState: () => {} })
      rt.ingestTranscript('Hey Métis', 'command')
      await vi.advanceTimersByTimeAsync(METIS_COMMAND_IDLE_TIMEOUT_MS)
      expect(rt.getState()).toMatchObject({ active: false, phase: 'deactivating', reason: 'inactivity' })
      await vi.advanceTimersByTimeAsync(50)
      expect(rt.getState().active).toBe(false)
      rt.ingestTranscript('open notes', 'command')
      expect(rt.getState()).toMatchObject({ active: false, pending: [] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reset revokes a prior wake before a later capture can execute ordinary speech', () => {
    const rt = createMetisCommandRuntime({ onState: () => {} })
    rt.ingestTranscript('Hey Métis', 'command')
    rt.reset('cloud_stt_stop')
    rt.ingestTranscript('open notes', 'command')
    expect(rt.getState()).toMatchObject({ active: false, pending: [] })
  })

  it('does not let a prior stop timer erase a new wake', async () => {
    vi.useFakeTimers()
    try {
      const rt = createMetisCommandRuntime({ onState: () => {} })
      rt.ingestTranscript('Hey Métis', 'command')
      rt.stopLocal('escape')
      rt.ingestTranscript('Hey Métis', 'command')
      await vi.advanceTimersByTimeAsync(50)
      expect(rt.getState()).toMatchObject({ active: true, phase: 'waking' })
    } finally {
      vi.useRealTimers()
    }
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
    rt.ingestTranscript('Hey Métis', 'command')
    const t0 = Date.now()
    rt.stopLocal('escape')
    expect(Date.now() - t0).toBeLessThan(100)
    expect(rt.getState().reason === 'escape' || rt.getState().phase === 'deactivating' || !rt.getState().active).toBe(
      true
    )
  })
})
