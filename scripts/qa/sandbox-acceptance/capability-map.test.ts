import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAP_IDS, E2E_CASES, mapProblems } from './capability-map.mjs'
import { MAP_SCENARIO_STEPS, SCENARIO_STEPS } from './scenario-registry.mjs'

const load = () => JSON.parse(readFileSync(join(__dirname, 'capability-map.json'), 'utf8'))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const problemsOf = (map: unknown) => mapProblems(map, MAP_SCENARIO_STEPS)

describe('capability map (G88)', () => {
  it('is complete and honest as committed', () => {
    expect(problemsOf(load())).toEqual([])
  })

  it('lists every CAP-01..CAP-40 exactly once', () => {
    const map = load()
    expect(map.capabilities.map((cap: { id: string }) => cap.id)).toEqual(CAP_IDS)
    const missing = clone(map)
    missing.capabilities = missing.capabilities.filter((cap: { id: string }) => cap.id !== 'CAP-17')
    expect(problemsOf(missing)).toContain('CAP-17: missing')
    const twice = clone(map)
    twice.capabilities.push(clone(twice.capabilities[0]))
    expect(problemsOf(twice)).toContain('CAP-01: listed 2 times')
  })

  it('lists all 54 E2E cases', () => {
    const map = load()
    expect(Object.values(E2E_CASES).flat()).toHaveLength(54)
    expect(map.e2e).toHaveLength(54)
    const missing = clone(map)
    missing.e2e = missing.e2e.filter(
      (entry: { id: string; case: string }) => !(entry.id === 'E2E-03' && entry.case === 'teach')
    )
    expect(problemsOf(missing)).toContain('E2E-03 teach: missing')
  })

  it('every sandbox row names a registered scenario and existing step ids', () => {
    const map = load()
    const bad = clone(map)
    bad.capabilities[13].rows[0].steps = ['no-such-step']
    expect(problemsOf(bad).join('\n')).toMatch(/CAP-14 row 1: unknown step "no-such-step" of scenario settings-hig/)
    const unknown = clone(map)
    unknown.capabilities[13].rows[0].scenario = 'no-such-scenario'
    expect(problemsOf(unknown).join('\n')).toMatch(/unknown scenario "no-such-scenario"/)
    for (const entry of [...map.capabilities, ...map.e2e])
      for (const row of entry.rows)
        if (row.kind === 'sandbox') expect(Object.keys(MAP_SCENARIO_STEPS)).toContain(row.scenario)
  })

  it('owner-checklist rows never name a scenario', () => {
    const map = load()
    const bad = clone(map)
    const row = bad.capabilities.find((cap: { id: string }) => cap.id === 'CAP-12').rows[0]
    row.scenario = 'voice-actions'
    expect(problemsOf(bad).join('\n')).toMatch(/CAP-12 row 1: an owner-checklist row never names a sandbox scenario/)
    for (const entry of [...map.capabilities, ...map.e2e])
      for (const each of entry.rows)
        if (each.kind === 'owner-checklist' || each.kind === 'blocked-external') {
          expect(each.scenario).toBeUndefined()
          expect(each.steps).toBeUndefined()
        }
  })

  it('sandbox rows never claim LIVE_VERIFIED, ACCEPTED or MEASURED', () => {
    const map = load()
    for (const claim of ['LIVE_VERIFIED', 'ACCEPTED', 'MEASURED']) {
      const bad = clone(map)
      bad.capabilities[13].rows[0].target = claim
      expect(problemsOf(bad).join('\n')).toMatch(new RegExp(`CAP-14 row 1: a sandbox row cannot claim ${claim}`))
    }
    for (const entry of [...map.capabilities, ...map.e2e])
      for (const row of entry.rows)
        if (row.kind === 'sandbox' || row.kind === 'ci-only')
          expect(['LOCALLY_TESTED', 'DESIGNED']).toContain(row.target)
  })

  it('blocked-external rows carry an unblock step and a decision', () => {
    const map = load()
    const bad = clone(map)
    const row = bad.capabilities
      .find((cap: { id: string }) => cap.id === 'CAP-04')
      .rows.find((r: { kind: string }) => r.kind === 'blocked-external')
    row.unblock = ''
    delete row.decision
    const text = problemsOf(bad).join('\n')
    expect(text).toMatch(/a blocked-external row needs an unblock step/)
    expect(text).toMatch(/a blocked-external row needs a decision id/)
  })

  it('E2E-04 and E2E-08 are pending-disposition G92 until G92 lands', () => {
    const map = load()
    for (const id of ['E2E-04', 'E2E-08']) {
      const cases = map.e2e.filter((entry: { id: string }) => entry.id === id)
      expect(cases).toHaveLength(5)
      for (const entry of cases) expect(entry.rows).toEqual([{ kind: 'pending-disposition', ticket: 'G92' }])
    }
  })

  it('a case without any row, or a row of an unknown kind, is refused', () => {
    const map = load()
    const empty = clone(map)
    empty.e2e[0].rows = []
    expect(problemsOf(empty)).toContain('E2E-01 H: needs at least one row')
    const odd = clone(map)
    odd.e2e[0].rows = [{ kind: 'wishful' }]
    expect(problemsOf(odd).join('\n')).toMatch(/unknown row kind "wishful"/)
  })

  it('the new scenarios are registered and the dry-run source of truth', () => {
    expect(SCENARIO_STEPS['quiet-mode']).toContain('qm-unsolicited-held')
    expect(SCENARIO_STEPS['memory-assistants']).toContain('ma-persisted-after-relaunch')
    expect(MAP_SCENARIO_STEPS.soak).toEqual(['SOAK-ACCEPT-1'])
    expect(Object.keys(SCENARIO_STEPS)).not.toContain('soak')
  })
})
