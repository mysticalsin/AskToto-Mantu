import { describe, expect, it, vi } from 'vitest'
import { METIS_COMMAND_IDLE_TIMEOUT_MS, createMetisCommandRuntime } from './metis-command-runtime'

describe('command runtime proposals', () => {
  it('does not execute after parsing a command', async () => {
    const execute = vi.fn()
    const runtime = createMetisCommandRuntime({ onState: () => {}, execute })
    runtime.ingestTranscript('open notes', 'command')
    await Promise.resolve()
    expect(runtime.getState().proposal?.request.id).toBe('desktop.open_notes')
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps only the first allowlisted candidate from a chained utterance', () => {
    const runtime = createMetisCommandRuntime({ onState: () => {} })
    runtime.ingestTranscript('open notes then open Arc', 'command')
    expect(runtime.getState().proposal?.request.id).toBe('desktop.open_notes')
  })

  it('expires and revokes proposals on reset or stop', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createMetisCommandRuntime({ onState: () => {} })
      runtime.ingestTranscript('open notes', 'command')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(runtime.getState().proposal).toBeUndefined()
      expect(runtime.getState().reason).toBe('proposal_expired')

      runtime.ingestTranscript('open Arc', 'command')
      expect(runtime.getState().proposal).toBeDefined()
      runtime.reset('source_replaced')
      expect(runtime.getState().proposal).toBeUndefined()
      runtime.ingestTranscript('open notes', 'command')
      runtime.stopLocal('escape')
      expect(runtime.getState().proposal).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts stale optional decision work when a new partial replaces its context', async () => {
    let capturedSignal: AbortSignal | undefined
    let capturedTranscript = ''
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      capturedTranscript = JSON.parse(String(init?.body)).payload.transcript
      return new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    const runtime = createMetisCommandRuntime({
      onState: () => {},
      jevEnabled: () => true,
      operatorDecideAuth: () => ({ baseUrl: 'https://operator.example', authorizationHeader: 'Bearer test' }),
      fetchImpl
    })
    runtime.ingestTranscript(`create note ${'x'.repeat(600)}`, 'command')
    await Promise.resolve()
    expect(capturedSignal?.aborted).toBe(false)
    expect(capturedTranscript.length).toBeLessThanOrEqual(512)
    runtime.ingestTranscript('open notes', 'command')
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('never re-drains an old generation into a replacement session', async () => {
    const execute = vi.fn()
    const runtime = createMetisCommandRuntime({ onState: () => {}, execute })
    runtime.ingestTranscript('open notes', 'command')
    runtime.reset('source_replaced')
    runtime.ingestTranscript('open Arc', 'command')
    await Promise.resolve()
    expect(runtime.getState().proposal?.request.id).toBe('desktop.open_arc')
    expect(execute).not.toHaveBeenCalled()
  })

  it('expires command capture after inactivity without accepting ordinary speech', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createMetisCommandRuntime({ onState: () => {} })
      runtime.ingestTranscript('Métis', 'command')
      await vi.advanceTimersByTimeAsync(METIS_COMMAND_IDLE_TIMEOUT_MS)
      expect(runtime.getState()).toMatchObject({ active: false, phase: 'deactivating', reason: 'inactivity' })
      await vi.advanceTimersByTimeAsync(50)
      runtime.ingestTranscript('ordinary meeting words', 'command')
      expect(runtime.getState().active).toBe(false)
      expect(runtime.getState().proposal).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
