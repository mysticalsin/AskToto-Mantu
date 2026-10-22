import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'

const source = readModuleSource(__dirname, './index').text.replace(/\r\n/g, '\n')

/** The ask handler, from its registration to the cancel handler that follows it. */
const askHandler = (): string => {
  const start = source.indexOf('ipcMain.handle(IPC.askStart')
  const end = source.indexOf('ipcMain.handle(IPC.askCancel')
  if (start < 0 || end < start) throw new Error('ask handler boundaries not found')
  return source.slice(start, end)
}

describe('G29: the capability router is the ask seam', () => {
  it('plans the route once, right after the fleet-narrowed allowlist, and refuses through the turn registry', () => {
    const body = askHandler()
    const narrowed = body.indexOf("narrowAllowedForCapability(s, getAllowedProviders(), 'askChat'")
    const planned = body.indexOf('planAsk({')
    expect(narrowed).toBeGreaterThan(0)
    expect(planned).toBeGreaterThan(narrowed)
    expect(body).toMatch(/planAsk\(\{ req, settings: s, allowed, orgAllowed, policy: getActiveModelPolicy\(s\) \}\)/)
    expect(body).toMatch(/if \(route\.unavailable\) return askTurns\.fail\(req\.id, route\.unavailable\)/)
  })

  it('every tier decision reads the plan: no second routeTier call is left in the ask handler', () => {
    const body = askHandler()
    expect(body).not.toMatch(/routeTier\(req/)
    expect(body).toMatch(/const localPrimaryEligible = route\.localPrimaryEligible/)
    expect(body.match(/const tier = route\.tier/g)?.length).toBe(2)
  })

  it('keeps the hedged race gated as before: base tier, an interactive mode, a fresh first attempt, failover allowed', () => {
    const body = askHandler()
    const gate = body.slice(body.indexOf('const hedgeEligible ='))
    expect(gate).toMatch(/s\.resilience\.hedge &&/)
    expect(gate).toMatch(/primary !== 'local' &&/)
    expect(gate).toMatch(/route\.tier === 'base' &&/)
    expect(gate).toMatch(/\(req\.mode === 'answer' \|\| req\.mode === 'vision' \|\| req\.mode === 'suggest'\) &&/)
    expect(gate).toMatch(/allowCrossProviderFailover\(req\)/)
  })

  it('Private View still blocks a frame before the router is consulted', () => {
    const body = askHandler()
    expect(body.indexOf('privateViewOn()')).toBeGreaterThan(0)
    expect(body.indexOf('privateViewOn()')).toBeLessThan(body.indexOf('planAsk({'))
  })

  it('the turn registry gets the ask goal and the G12 counter sink, so a deeper ask can take over its fast stage', () => {
    const body = askHandler()
    expect(body).toMatch(/askTurns\.begin\(\{[^}]*ask: req/)
    expect(source).toMatch(/const askTurns = createAskTurns\(\{[^}]*metrics: askMetrics/)
  })
})
