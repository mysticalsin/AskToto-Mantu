import { describe, expect, it, vi } from 'vitest'
import { registerPendingAskCancellation, type AskStreamHandle } from './ask-start-cancel'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('askStart cancellation while brain context is pending', () => {
  it('keeps cancel visible until the awaited brain context returns, so no provider stream starts', async () => {
    const streams = new Map<string, AskStreamHandle>()
    const brainContext = deferred()
    const startProviderStream = vi.fn()
    const pendingAsk = registerPendingAskCancellation(streams, 'ask-1')

    const askStart = async (): Promise<void> => {
      await brainContext.promise
      if (!pendingAsk.stillPending()) {
        pendingAsk.releaseIfPending()
        return
      }
      startProviderStream()
    }

    const running = askStart()
    streams.get('ask-1')?.abort()
    streams.delete('ask-1')
    brainContext.resolve()
    await running

    expect(startProviderStream).not.toHaveBeenCalled()
  })

  it('releases only the placeholder it registered', () => {
    const streams = new Map<string, AskStreamHandle>()
    const pendingAsk = registerPendingAskCancellation(streams, 'ask-1')
    const replacement = { abort: vi.fn() }

    streams.set('ask-1', replacement)
    pendingAsk.releaseIfPending()

    expect(streams.get('ask-1')).toBe(replacement)
  })
})
