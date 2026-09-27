import { describe, expect, it } from 'vitest'
import { BASELINE_VIOLATIONS, compareViolations, findRepoViolations, findViolations } from './check-no-scratch-paths.mjs'

describe('findViolations', () => {
  it('reports a past agent-session scratch-path literal as path:line', () => {
    const files = [{ path: 'fixture.mjs', content: 'const x = "/private/tmp/claude-501/foo"' }]
    expect(findViolations(files)).toEqual(['fixture.mjs:1'])
  })

  it('reports the /tmp/claude- form agents receive as $TMPDIR as path:line', () => {
    const files = [{ path: 'fixture.mjs', content: 'const x = "/tmp/claude-501/foo"' }]
    expect(findViolations(files)).toEqual(['fixture.mjs:1'])
  })

  it('reports an absolute per-user path literal as path:line', () => {
    const files = [{ path: 'fixture.mjs', content: 'const x = "/Users/someone/foo"' }]
    expect(findViolations(files)).toEqual(['fixture.mjs:1'])
  })

  it('gives [] for a clean file', () => {
    const files = [{ path: 'fixture.mjs', content: 'import { tmpdir } from "node:os"\nconst x = tmpdir()' }]
    expect(findViolations(files)).toEqual([])
  })
})

describe('compareViolations', () => {
  it('passes a baselined file whose one violation moved to a different line', () => {
    const baseline = new Map([['fixture.mjs', 1]])
    expect(compareViolations(['fixture.mjs:42'], baseline)).toEqual({ unexpected: [], stale: [] })
  })

  it('flags an extra hit in a grandfathered file as unexpected', () => {
    const baseline = new Map([['fixture.mjs', 1]])
    const { unexpected, stale } = compareViolations(['fixture.mjs:5', 'fixture.mjs:9'], baseline)
    expect(unexpected).toEqual(['fixture.mjs:5', 'fixture.mjs:9'])
    expect(stale).toEqual([])
  })

  it('reports a fixed file (its violation gone) as stale', () => {
    const baseline = new Map([['fixture.mjs', 1]])
    const { unexpected, stale } = compareViolations([], baseline)
    expect(unexpected).toEqual([])
    expect(stale).toEqual(['fixture.mjs (expected 1, found 0)'])
  })

  it('flags a violation in a file the baseline never mentions', () => {
    const { unexpected, stale } = compareViolations(['unbaselined.mjs:1'], new Map())
    expect(unexpected).toEqual(['unbaselined.mjs:1'])
    expect(stale).toEqual([])
  })
})

describe('the repo scan', () => {
  it('flags no violation outside the baseline and no stale baseline entry', () => {
    const { unexpected, stale } = compareViolations(findRepoViolations(), BASELINE_VIOLATIONS)
    expect(unexpected).toEqual([])
    expect(stale).toEqual([])
  })
})
