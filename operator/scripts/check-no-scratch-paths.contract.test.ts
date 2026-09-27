import { describe, expect, it } from 'vitest'
import { BASELINE_VIOLATIONS, findRepoViolations, findViolations } from './check-no-scratch-paths.mjs'

describe('findViolations', () => {
  it('reports a past agent-session scratch-path literal as path:line', () => {
    const files = [{ path: 'fixture.mjs', content: 'const x = "/private/tmp/claude-501/foo"' }]
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

describe('the repo scan', () => {
  it('flags no violation outside the baseline', () => {
    const unexpected = findRepoViolations().filter((v) => !BASELINE_VIOLATIONS.has(v))
    expect(unexpected).toEqual([])
  })

  it('keeps every baseline entry a real, current violation (so a fixed file cannot linger unnoticed)', () => {
    const current = new Set(findRepoViolations())
    for (const entry of BASELINE_VIOLATIONS) {
      expect(current.has(entry)).toBe(true)
    }
  })
})
