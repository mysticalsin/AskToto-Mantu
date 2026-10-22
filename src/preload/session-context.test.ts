import { describe, expect, it, vi } from 'vitest'
import { createSessionContextPreloadApi } from './session-context'

describe('session context preload API', () => {
  it('sends a ledger line on its one channel and returns the content-free reply', async () => {
    const invoke = vi.fn(async () => ({ status: 'accepted' }))
    const api = createSessionContextPreloadApi({ invoke } as never)
    const line = {
      op: 'final',
      startedAt: 1_700_000_000_000,
      t: 1_700_000_000_005,
      speaker: 'you',
      text: 'hi'
    } as const
    await expect(api.appendSessionLedgerLine(line)).resolves.toEqual({ status: 'accepted' })
    expect(invoke).toHaveBeenCalledExactlyOnceWith('session-context:appendLine', line)
  })

  it('exposes nothing that reads transcript text back', () => {
    const api = createSessionContextPreloadApi({ invoke: vi.fn() } as never)
    expect(Object.keys(api)).toEqual(['appendSessionLedgerLine'])
  })
})
