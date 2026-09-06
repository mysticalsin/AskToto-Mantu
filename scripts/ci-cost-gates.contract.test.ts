import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ci-cost-gates.contract.test.ts — the packaging jobs must not run on every branch push.
 *
 * Why this exists. `build-macos` and `build-windows` are 90-minute packaging jobs, and GitHub bills a
 * macOS runner at 10x wall-clock and a Windows runner at 2x. Running both on every push to every branch
 * meant one feature-branch push could reserve ~900 + ~180 quota-minutes. On a private repo's monthly
 * allowance that is two or three pushes before GitHub refuses to start ANY job with "The job was not
 * started because an Actions budget is preventing further use" — the exact state this repo was found in
 * on 2026-08-17: quality and security failing in 3s with no runner assigned, both package jobs skipped,
 * and therefore no installer produced at all. The macOS job is the only supported way to build a DMG
 * (the Swift mac-helper, signing and DMG validation all need a real macOS host), so draining the
 * allowance does not merely slow CI down — it removes the ability to ship a Mac build.
 *
 * What is asserted. Not the presence of a string: the actual BEHAVIOUR of the shipped `if:` expression,
 * evaluated against every trigger this repo really uses. Plus the invariants the workflow file itself
 * marks load-bearing, so a future "simplification" of the cost gate cannot quietly take them with it.
 *
 * Deliberately no YAML library: js-yaml is present only as a transitive dependency here, so a test
 * built on it would break on an unrelated lockfile change. The extraction below is targeted and small,
 * matching how release-gates.test.ts already reads these same files.
 */

const root = join(__dirname, '..')
const source = readFileSync(join(root, '.github', 'workflows', 'build.yml'), 'utf8').replace(/\r\n/g, '\n')

/** The `if:` folded block scalar (`if: >-`) belonging to a top-level job, joined into one line. */
function jobCondition(job: string): string {
  const start = source.indexOf(`\n  ${job}:\n`)
  expect(start, `job not found in build.yml: ${job}`).toBeGreaterThan(-1)
  const nextJob = source.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  const block = nextJob === -1 ? source.slice(start) : source.slice(start, start + 1 + nextJob)
  const marker = block.indexOf('\n    if: >-\n')
  expect(marker, `job "${job}" has no \`if: >-\` cost gate`).toBeGreaterThan(-1)
  const lines: string[] = []
  for (const line of block.slice(marker + '\n    if: >-\n'.length).split('\n')) {
    if (!/^ {6}\S/.test(line)) break // dedent ends the folded scalar
    lines.push(line.trim())
  }
  expect(lines.length, `job "${job}" has an empty \`if:\``).toBeGreaterThan(0)
  return lines.join(' ')
}

/**
 * Evaluate a GitHub Actions `if:` expression for the small subset this workflow uses.
 *
 * STRICT ON PURPOSE: anything outside that subset throws rather than being guessed at. A silent
 * mis-evaluation would let this whole file report green while the real gate did something else, which
 * is worse than having no test — so an expression this cannot faithfully model must fail loudly and be
 * modelled properly instead.
 */
function evaluateCondition(expr: string, ctx: { event_name: string; ref: string }): boolean {
  const allowed = /^[\s()']*(?:(?:github\.(?:event_name|ref)\s*==\s*'[^']*'|\|\||&&)[\s()']*)+$/
  if (!allowed.test(expr)) {
    throw new Error(`unsupported expression shape — model it explicitly rather than guessing: ${expr}`)
  }
  const js = expr
    .replace(/github\.event_name/g, 'ctx.event_name')
    .replace(/github\.ref/g, 'ctx.ref')
    .replace(/([^=!<>])==([^=])/g, '$1===$2')
  return Function('ctx', `"use strict"; return (${js})`)(ctx) as boolean
}

const PACKAGE_JOBS = ['build-macos', 'build-windows'] as const

/** Every trigger this repo actually produces, and whether packaging should happen for it. */
const SCENARIOS: Array<{ what: string; ctx: { event_name: string; ref: string }; packages: boolean }> = [
  { what: 'push to main — the release candidate', ctx: { event_name: 'push', ref: 'refs/heads/main' }, packages: true },
  { what: 'push to master — the same, on the legacy name', ctx: { event_name: 'push', ref: 'refs/heads/master' }, packages: true },
  { what: 'pull request into main — packaged BEFORE it merges', ctx: { event_name: 'pull_request', ref: 'refs/pull/42/merge' }, packages: true },
  { what: 'manual workflow_dispatch on a feature branch', ctx: { event_name: 'workflow_dispatch', ref: 'refs/heads/fix/ci-actions-budget' }, packages: true },
  // The regression this file exists for.
  { what: 'push to a feature branch', ctx: { event_name: 'push', ref: 'refs/heads/fix/close-open-ledger-rows' }, packages: false },
  { what: 'push to a second feature branch', ctx: { event_name: 'push', ref: 'refs/heads/feat/anything' }, packages: false },
  { what: 'push to a branch whose name merely CONTAINS main', ctx: { event_name: 'push', ref: 'refs/heads/fix/main-thing' }, packages: false }
]

describe('CI cost gates — packaging must not run on every branch push', () => {
  for (const job of PACKAGE_JOBS) {
    describe(job, () => {
      for (const s of SCENARIOS) {
        it(`${s.packages ? 'packages' : 'does NOT package'} on ${s.what}`, () => {
          expect(evaluateCondition(jobCondition(job), s.ctx)).toBe(s.packages)
        })
      }
    })
  }

  it('keeps both platforms in lockstep — a push may not package one target and skip the other', () => {
    // Otherwise a release candidate could reach main verified on only one of the two targets it ships.
    const [mac, win] = PACKAGE_JOBS.map(jobCondition)
    for (const s of SCENARIOS) {
      expect(evaluateCondition(mac, s.ctx), `mac/win disagree on: ${s.what}`).toBe(evaluateCondition(win, s.ctx))
    }
  })

  it('still requires the cheap gates to pass before spending runner minutes', () => {
    expect((source.match(/needs: \[quality, security\]/g) ?? []).length).toBe(PACKAGE_JOBS.length)
  })
})

describe('CI cost gates — what must NOT be sacrificed to save minutes', () => {
  // Each of these is marked load-bearing in build.yml's own comments, with a recorded incident behind
  // it. They are cheap; the expensive jobs are the ones that needed gating, not these.
  it("keeps push: branches: ['**'] — a tags-only push block disables branch CI entirely", () => {
    expect(source).toMatch(/push:\n {4}branches:\n {6}- '\*\*'/)
  })

  it('keeps the quality matrix on BOTH hosts — ubuntu-only made every win32 test a silent false-pass', () => {
    expect(source).toMatch(/os: \[ubuntu-latest, windows-latest\]/)
  })

  it('keeps quality and security ungated, so branch feedback is unchanged', () => {
    for (const job of ['quality', 'security']) {
      const start = source.indexOf(`\n  ${job}:\n`)
      expect(start, `job not found: ${job}`).toBeGreaterThan(-1)
      const nextJob = source.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
      const block = nextJob === -1 ? source.slice(start) : source.slice(start, start + 1 + nextJob)
      expect(block, `${job} must not carry a cost gate`).not.toMatch(/\n {4}if:/)
    }
  })

  it('installs Playwright Chromium before quality npm test — the package is not the browser', () => {
    const start = source.indexOf('\n  quality:\n')
    expect(start, 'quality job not found').toBeGreaterThan(-1)
    const nextJob = source.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
    const block = nextJob === -1 ? source.slice(start) : source.slice(start, start + 1 + nextJob)
    expect(block).toMatch(/npx playwright install[^\n]*chromium/)
    expect(block.indexOf('playwright install')).toBeLessThan(block.indexOf('npm test'))
  })

  it('keeps workflow_dispatch, the escape hatch that packages a branch on demand', () => {
    expect(source).toMatch(/^ {2}workflow_dispatch:$/m)
  })
})
