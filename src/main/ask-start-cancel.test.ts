import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { registerPendingAskCancellation, type AskStreamHandle } from './ask-start-cancel'

const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

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

  it('wires the pending cancel gate around askStart brain context before provider routing', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.askStart')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, indexSrc.indexOf('ipcMain.handle(IPC.askCancel', start))
    const register = body.indexOf('pendingAsk = registerPendingAskCancellation(streams, req.id)')
    const brainAwait = body.indexOf('await buildBrainContext')
    const cancelCheck = body.indexOf('if (!pendingAsk.stillPending())', brainAwait)
    const providerRouting = body.indexOf('const allowed = getAllowedProviders()')

    expect(register).toBeGreaterThan(-1)
    expect(register).toBeLessThan(brainAwait)
    expect(cancelCheck).toBeGreaterThan(brainAwait)
    expect(cancelCheck).toBeLessThan(providerRouting)
  })
})
