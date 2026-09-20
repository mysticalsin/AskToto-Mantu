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
    rt.ingestTranscript('Métis open notes', 'meeting')
    expect(rt.getState().active).toBe(false)
    expect(rt.getState().pending).toEqual([])
  })

  it('moves the pill to listening after a same-utterance command', async () => {
    vi.useFakeTimers()
    try {
      const rt = createMetisCommandRuntime({ onState: () => {}, platform: 'linux' })
      rt.ingestTranscript('Métis open notes', 'command')
      expect(rt.getState().pillCopy).toBe('Hi Métis')
      await vi.advanceTimersByTimeAsync(450)
      expect(rt.getState().pillCopy).toContain('listening')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains a command that arrives while an earlier action is committing', async () => {
    let releaseFirst: () => void = () => {
      throw new Error('first adapter action was not started')
    }
    let executions = 0
    const execute: typeof import('./desktop-adapters').executeDesktopAction = async (request) => {
      executions++
      if (executions === 1) await new Promise<void>((resolve) => (releaseFirst = resolve))
      return { id: request.id, ok: true, outcome: 'unknown' }
    }
    const rt = createMetisCommandRuntime({ onState: () => {}, platform: 'linux', execute })
    rt.ingestTranscript('Métis open notes', 'command')
    await Promise.resolve()
    rt.ingestTranscript('open Arc', 'command')
    expect(rt.getState().pending.map((request) => request.id)).toEqual(['desktop.open_notes', 'desktop.open_arc'])
    releaseFirst()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(rt.getState().committed).toEqual(
      expect.arrayContaining(['desktop.open_notes', 'desktop.open_arc'])
    )
    expect(rt.getState().pending).toEqual([])
  })

  it('drains a new command session after an old action finishes', async () => {
    let releaseFirst: () => void = () => {
      throw new Error('first adapter action was not started')
    }
    const executed: string[] = []
    const execute: typeof import('./desktop-adapters').executeDesktopAction = async (request) => {
      executed.push(request.id)
      if (executed.length === 1) await new Promise<void>((resolve) => (releaseFirst = resolve))
      return { id: request.id, ok: true, outcome: 'unknown' }
    }
    const rt = createMetisCommandRuntime({ onState: () => {}, execute })
    rt.ingestTranscript('Métis open notes', 'command')
    await Promise.resolve()
    rt.reset('cloud_stt_replaced')
    rt.ingestTranscript('Métis open Arc', 'command')
    releaseFirst()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(executed).toEqual(['desktop.open_notes', 'desktop.open_arc'])
    expect(rt.getState().committed).toContain('desktop.open_arc')
  })

  it('expires command authority after local-microphone inactivity', async () => {
    vi.useFakeTimers()
    try {
      const rt = createMetisCommandRuntime({ onState: () => {} })
      rt.ingestTranscript('Métis', 'command')
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
    rt.ingestTranscript('Métis', 'command')
    rt.reset('cloud_stt_stop')
    rt.ingestTranscript('open notes', 'command')
    expect(rt.getState()).toMatchObject({ active: false, pending: [] })
  })

  it('does not let a prior stop timer erase a new wake', async () => {
    vi.useFakeTimers()
    try {
      const rt = createMetisCommandRuntime({ onState: () => {} })
      rt.ingestTranscript('Métis', 'command')
      rt.stopLocal('escape')
      rt.ingestTranscript('Métis', 'command')
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
    rt.ingestTranscript('Métis', 'command')
    const t0 = Date.now()
    rt.stopLocal('escape')
    expect(Date.now() - t0).toBeLessThan(100)
    expect(rt.getState().reason === 'escape' || rt.getState().phase === 'deactivating' || !rt.getState().active).toBe(
      true
    )
  })
})
