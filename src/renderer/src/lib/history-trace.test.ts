import { describe, expect, it, vi } from 'vitest'
import { UNAUTHENTICATED_RESULT } from '@shared/ipc-auth'
import { IPC_UNAUTHENTICATED_EVENT } from './ipc-auth'
import { beginHistoryRequest } from './history-trace'

const requestId = '123e4567-e89b-12d3-a456-426614174000'

function installTestWindow(toto: Partial<Window['toto']> = {}): Event[] {
  const events: Event[] = []
  const target = new EventTarget()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      toto,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target)
    }
  })
  return events
}

describe('beginHistoryRequest', () => {
  it('creates a trace with uuid requestId and sentAt wall time', () => {
    const request = beginHistoryRequest({
      report: vi.fn(),
      newId: () => requestId,
      wallClock: () => 1_700_000_000_000,
      clock: () => 10
    })

    expect(request.trace).toEqual({ requestId, sentAt: 1_700_000_000_000 })
  })

  it('painted reports ok with ipcMs and renderMs', () => {
    const report = vi.fn()
    const times = [10, 35, 50]
    const request = beginHistoryRequest({
      report,
      newId: () => requestId,
      wallClock: () => 1,
      clock: () => times.shift() ?? 50
    })

    request.resolved()
    request.painted()

    expect(report).toHaveBeenCalledExactlyOnceWith({ requestId, outcome: 'ok', ipcMs: 25, renderMs: 15 })
  })

  it('discarded reports ipcMs without renderMs', () => {
    const report = vi.fn()
    const times = [10, 25]
    const request = beginHistoryRequest({
      report,
      newId: () => requestId,
      wallClock: () => 1,
      clock: () => times.shift() ?? 25
    })

    request.discarded()

    expect(report).toHaveBeenCalledExactlyOnceWith({ requestId, outcome: 'discarded', ipcMs: 15 })
  })

  it('failed reports ipcMs without renderMs', () => {
    const report = vi.fn()
    const times = [10, 28]
    const request = beginHistoryRequest({
      report,
      newId: () => requestId,
      wallClock: () => 1,
      clock: () => times.shift() ?? 28
    })

    request.failed()

    expect(report).toHaveBeenCalledExactlyOnceWith({ requestId, outcome: 'failed', ipcMs: 18 })
  })

  it('only the first terminal call reports', () => {
    const report = vi.fn()
    const request = beginHistoryRequest({
      report,
      newId: () => requestId,
      wallClock: () => 1,
      clock: () => 10
    })

    request.discarded()
    request.failed()
    request.painted()

    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0][0].outcome).toBe('discarded')
  })

  it('routes the default History settled reporter through the shared unauthenticated handler', async () => {
    const events = installTestWindow()
    window.addEventListener(IPC_UNAUTHENTICATED_EVENT, (event) => events.push(event))
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId as `${string}-${string}-${string}-${string}-${string}`)
    vi.spyOn(performance, 'now').mockReturnValue(10)
    const reportHistorySettled = vi.fn().mockResolvedValue(UNAUTHENTICATED_RESULT)
    window.toto = { ...window.toto, reportHistorySettled }

    beginHistoryRequest().discarded()
    await Promise.resolve()

    expect(reportHistorySettled).toHaveBeenCalledWith({ requestId, outcome: 'discarded', ipcMs: 0 })
    expect((events[0] as CustomEvent).detail).toEqual(UNAUTHENTICATED_RESULT)
  })
})
