/**
 * dashboard-state.contract.test.ts — MQA-221 and MQA-222.
 *
 * Both defects are render-path behaviour in a React hook and two views. This app's vitest run has no
 * jsdom (every sibling suite here is pure-lib), so these follow the repo's established structural-proof
 * pattern — readFileSync plus anchored regex over the real source — the same one
 * src/main/*.contract.test.ts uses for main-process seams it cannot import.
 *
 * They pin the SHAPE of two decisions that are easy to undo by accident:
 *
 *   MQA-221 — a refresh that fails while a good snapshot is on screen must keep the snapshot AND say
 *   the numbers stopped updating. The single-expression catch it replaced (`prev.data ? null : err`)
 *   reads like a sensible guard and silently threw the failure away.
 *
 *   MQA-222 — a view with no data must still be a page: its own heading and standfirst, plus a sentence
 *   about how records get here. Returning a bare sentence is one line shorter and looks like a bug.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SRC = join(__dirname, '..')
const read = (...p: string[]): string => readFileSync(join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n')

const hook = read('lib', 'useDashboardData.ts')
const app = read('App.tsx')
const people = read('views', 'PeopleView.tsx')
const accounts = read('views', 'AccountsView.tsx')
const emptyState = read('components', 'EmptyState.tsx')

describe('MQA-221 — a failed refresh is never swallowed behind a good snapshot', () => {
  it('the state carries a non-fatal staleness reason alongside the fatal error', () => {
    expect(hook).toMatch(/interface State \{[\s\S]*?\bstale: string \| null[\s\S]*?\}/)
  })

  it('a failure with a snapshot in hand sets stale rather than discarding it', () => {
    // The exact regression: `error: prev.data ? null : err.message` with nothing else recording it.
    const start = hook.indexOf('.catch(')
    expect(start).toBeGreaterThan(-1)
    const body = hook.slice(start, start + 700)
    expect(body).toMatch(/error: prev\.data \? null : err\.message/)
    expect(body, 'the failure must survive as `stale` when a snapshot is kept').toMatch(
      /stale: prev\.data \? err\.message : null/
    )
  })

  it('a successful read clears staleness, so the banner cannot stick after recovery', () => {
    expect(hook).toMatch(/setState\(\{ data, loading: false, error: null, stale: null \}\)/)
  })

  it('the page renders the staleness, instead of only storing it', () => {
    expect(app).toMatch(/const \{ data, loading, error, stale \} = useDashboardData\(\)/)
    expect(app).toMatch(/\{data && stale &&/)
    expect(app).toMatch(/Showing the last successful read\. The latest refresh failed/)
    expect(app).toMatch(/role="status"/)
  })

  it('the fatal screen no longer blames data.json in the mode that never reads it', () => {
    // Live-brain mode throws "Live brain bridge unavailable ..."; prefixing that with a data.json
    // failure sent the user to fix a file that is not involved.
    expect(app).not.toMatch(/Failed to load data\.json: \{error\}/)
    expect(app).toMatch(/<p className="text-sm text-rose-300">\{error\}<\/p>/)
  })
})

describe('MQA-222 — an empty view is still a page', () => {
  it('EmptyState keeps the view\'s own identity, not just a message', () => {
    for (const prop of ['title', 'standfirst', 'headline', 'body']) {
      expect(emptyState, `EmptyState must take ${prop}`).toMatch(new RegExp(`\\b${prop}[?]?:\\s*string`))
    }
    expect(emptyState).toMatch(/<h1/)
    expect(emptyState).toMatch(/role="status"/)
  })

  for (const [name, source] of [
    ['PeopleView', people],
    ['AccountsView', accounts]
  ] as const) {
    it(`${name} renders it instead of a bare sentence`, () => {
      expect(source).toMatch(/import \{ EmptyState \} from '\.\.\/components\/EmptyState'/)
      expect(source).toMatch(/<EmptyState/)
      // The exact shape that shipped: a lone div carrying only muted text.
      expect(source).not.toMatch(/return \(?\s*<div className="mx-auto max-w-7xl px-6 py-8 text-sm text-white\/50">/)
    })

    it(`${name}'s empty state says how records actually get here`, () => {
      const start = source.indexOf('<EmptyState')
      const block = source.slice(start, source.indexOf('/>', start))
      expect(block).toMatch(/title=/)
      expect(block).toMatch(/standfirst=/)
      expect(block).toMatch(/body=".*Métis extracts them from your meetings/)
    })
  }
})
