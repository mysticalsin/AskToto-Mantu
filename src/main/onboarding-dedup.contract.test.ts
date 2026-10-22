import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Regression lock for the doubled "Continue without signing in" button (reported 2026-08-04): a gated copy of the
// skip button was added to legacy onboarding's welcome step beside the unconditional original, so every first-run
// user saw it twice. Q09 (2.12) deleted that legacy component; the lock now guards that it stays gone and that no
// onboarding component renders the label as a button more than once.
const COMPONENTS = join(__dirname, '..', 'renderer', 'src', 'components')
const BUTTON_LABEL = /Continue without signing in <ArrowRight/g

describe('onboarding renders at most one "Continue without signing in" button', () => {
  it('the legacy onboarding component stays deleted', () => {
    expect(existsSync(join(COMPONENTS, ['Onboarding', 'tsx'].join('.')))).toBe(false)
  })

  it('no onboarding component carries the button label more than once', () => {
    const onboarding = readdirSync(COMPONENTS).filter((name) => /^Onboarding\w*\.tsx$/.test(name))
    expect(onboarding.length).toBeGreaterThan(0)
    for (const name of onboarding) {
      const source = readFileSync(join(COMPONENTS, name), 'utf8')
      expect(source.match(BUTTON_LABEL)?.length ?? 0, name).toBeLessThanOrEqual(1)
    }
  })
})
