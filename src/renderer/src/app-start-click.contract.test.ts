/**
 * Q14: App's toggleListen is the one entry for every Start/Stop control (bar, control bar, sidecar, hotkey).
 * It must route through the pure intent resolver and the Start watchdog, so a Start click that lands while a
 * Stop is still draining, or that never reaches a start, is answered on screen rather than swallowed.
 */
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

const APP = readModuleSource(__dirname, './App').text.replace(/\r\n/g, '\n')

function toggleListenBlock(): string {
  const start = APP.indexOf('const toggleListen = useCallback(')
  expect(start, 'toggleListen must stay a useCallback declaration').toBeGreaterThan(-1)
  const end = APP.indexOf('\n  )\n', start)
  expect(end).toBeGreaterThan(start)
  return APP.slice(start, end)
}

describe('App toggleListen (Q14)', () => {
  it('no longer decides Start versus Stop from the raw listening flag alone', () => {
    expect(toggleListenBlock()).not.toMatch(/if \(listen\.listening\) void endReview\(\)/)
  })

  it('routes through runListenToggle with the live Stop latch', () => {
    const block = toggleListenBlock()
    expect(block).toMatch(/runListenToggle\(/)
    expect(block).toMatch(/stopInProgress: stoppingRef\.current/)
  })

  it('keeps Q08 review guard on the start path and arms the watchdog only when the guarded start runs', () => {
    const block = toggleListenBlock()
    expect(block).toMatch(/guardReviewNav\(\(\) => \{\s*startListen\(\)\s*onStarted\(\)\s*\}, true\)/)
    expect(APP).toMatch(/cloudConsentFlow\.request \|\| navigationGuardRequest/)
  })

  it('arms the Start watchdog with the notice channel the cloud-consent refusals already use', () => {
    expect(APP).toMatch(/useStartWatchdog\(/)
    expect(toggleListenBlock()).toMatch(/notify: setOperatorGateNotice/)
  })
})
