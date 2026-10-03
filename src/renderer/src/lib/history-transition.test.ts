import { describe, expect, it, vi } from 'vitest'
import { UNAUTHENTICATED_RESULT } from '@shared/ipc-auth'
import { IPC_UNAUTHENTICATED_EVENT } from './ipc-auth'
import { createHistoryTransitionRecorder } from './history-transition'

function recorder(at = 1_700_000_000_000) {
  const report = vi.fn()
  return { report, transitions: createHistoryTransitionRecorder({ report, wallClock: () => at }) }
}

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

describe('createHistoryTransitionRecorder', () => {
  it('records an open and a close of History with the commit time', () => {
    const { report, transitions } = recorder()

    transitions.requested('answer', 'history')
    transitions.committed('history')
    transitions.requested('history', 'answer')
    transitions.committed('answer')

    expect(report.mock.calls).toEqual([
      [{ from: 'answer', to: 'history', committedAtMs: 1_700_000_000_000 }],
      [{ from: 'history', to: 'answer', committedAtMs: 1_700_000_000_000 }]
    ])
  })

  it('records the toggle race (an open and a close batched into one render) as from === to', () => {
    const { report, transitions } = recorder()

    transitions.requested('answer', 'history')
    transitions.requested('history', 'answer')

    expect(transitions.committed('answer')).toEqual({ from: 'answer', to: 'answer', committedAtMs: 1_700_000_000_000 })
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('records nothing until the render commits, so a freeze leaves no transition', () => {
    const { report, transitions } = recorder()

    transitions.requested('answer', 'history')

    expect(report).not.toHaveBeenCalled()
  })

  it('takes from the first request when React calls the updater again for the same render', () => {
    const { transitions } = recorder()

    transitions.requested('answer', 'history')
    transitions.requested('answer', 'history')

    expect(transitions.committed('history')).toMatchObject({ from: 'answer', to: 'history' })
  })

  it('ignores navigation that never touches History, and a commit with no request', () => {
    const { report, transitions } = recorder()

    transitions.requested('answer', 'settings')
    expect(transitions.committed('settings')).toBeNull()
    expect(transitions.committed('settings')).toBeNull()
    transitions.requested('settings', 'history')
    expect(transitions.committed('history')).toMatchObject({ from: 'settings', to: 'history' })
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('routes the default History transition reporter through the shared unauthenticated handler', async () => {
    const events = installTestWindow()
    window.addEventListener(IPC_UNAUTHENTICATED_EVENT, (event) => events.push(event))
    const reportHistoryTransition = vi.fn().mockResolvedValue(UNAUTHENTICATED_RESULT)
    window.toto = { ...window.toto, reportHistoryTransition }

    const transitions = createHistoryTransitionRecorder()
    transitions.requested('answer', 'history')
    transitions.committed('history')
    await Promise.resolve()

    expect(reportHistoryTransition).toHaveBeenCalledWith({ from: 'answer', to: 'history', committedAtMs: expect.any(Number) })
    expect((events[0] as CustomEvent).detail).toEqual(UNAUTHENTICATED_RESULT)
  })
})
