import { describe, expect, it, vi } from 'vitest'
import { createBrainRefresh } from './brain-refresh'
import { startIntelligenceUpdateFromClick, INTELLIGENCE_STATUS_UNAVAILABLE } from '@shared/intelligence-pass'

describe('dashboard refresh and click composition', () => {
  it('coalesces callers until the actual refresh settles, not an immediate no-op', async () => {
    let release!: (value: number) => void
    const read = vi.fn(() => new Promise<number>((resolve) => { release = resolve }))
    const apply = vi.fn()
    const settled = vi.fn()
    const refresh = createBrainRefresh(read, apply, vi.fn(), settled)
    const first = refresh()
    const second = refresh()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    expect(apply).not.toHaveBeenCalled()
    release(42)
    await expect(first).resolves.toEqual({ ok: true })
    expect(apply).toHaveBeenCalledWith(42)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('contains a real read rejection but carries failure into the actual click helper', async () => {
    const setError = vi.fn()
    const apply = vi.fn()
    const settled = vi.fn()
    const refresh = createBrainRefresh(async () => { throw new Error('private/path/provider-data') }, apply, setError, settled)
    const result = await startIntelligenceUpdateFromClick({
      runPass: async () => ({ queued: 2 }), refresh, setError
    })
    expect(result).toEqual({ queued: 2, error: INTELLIGENCE_STATUS_UNAVAILABLE })
    expect(setError).toHaveBeenLastCalledWith(INTELLIGENCE_STATUS_UNAVAILABLE)
    expect(apply).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('releases a failed refresh so a later valid snapshot can recover', async () => {
    const read = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(3)
    const apply = vi.fn()
    const refresh = createBrainRefresh(read, apply, vi.fn(), vi.fn())
    await expect(refresh()).resolves.toEqual({ ok: false })
    await expect(refresh()).resolves.toEqual({ ok: true })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(3)
  })
})
