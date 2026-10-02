import { describe, expect, it } from 'vitest'
import { ownerFor, parseNodeTestSummary, parseSwiftSummary, parseVitestJson } from './baseline-gates.mjs'

describe('baseline-gates parsers', () => {
  it('reads pass/fail/skip counts and failing test ids from a vitest JSON report', () => {
    const report = JSON.stringify({
      numPassedTests: 7,
      numFailedTests: 1,
      numPendingTests: 2,
      numTodoTests: 1,
      testResults: [
        { name: 'a.test.ts', status: 'failed', assertionResults: [{ status: 'failed', fullName: 'a breaks' }, { status: 'passed', fullName: 'a ok' }] },
        { name: 'b.test.ts', status: 'failed', assertionResults: [] }
      ]
    })
    expect(parseVitestJson(report)).toEqual({
      passed: 7,
      failed: 1,
      skipped: 3,
      failedTests: ['a.test.ts :: a breaks', 'b.test.ts :: (suite failed to run)']
    })
  })

  it('reads the node --test summary in TAP and spec form, ignoring colour codes', () => {
    expect(parseNodeTestSummary('# tests 5\n# pass 4\n# fail 1\n# skipped 0\n')).toMatchObject({ passed: 4, failed: 1, skipped: 0 })
    expect(parseNodeTestSummary('\u001b[34mℹ pass 9\u001b[39m\nℹ fail 0\nℹ skipped 2\nℹ todo 1\n')).toMatchObject({ passed: 9, failed: 0, skipped: 3 })
    expect(parseNodeTestSummary('no summary here')).toBeNull()
  })

  it('takes the last XCTest total and folds in a Swift Testing run', () => {
    const xctest = "Executed 3 tests, with 0 failures (0 unexpected) in 0.1 seconds\nExecuted 12 tests, with 2 failures (0 unexpected) in 1.0 seconds\n"
    expect(parseSwiftSummary(xctest)).toMatchObject({ passed: 10, failed: 2 })
    expect(parseSwiftSummary("Test run with 4 tests passed after 0.01 seconds.")).toMatchObject({ passed: 4, failed: 0 })
    expect(parseSwiftSummary('build error')).toBeNull()
  })

  it('links a failing test to its owning ticket and marks the rest UNOWNED', () => {
    const owners = [{ match: 'recall', ticket: 'M2-0012' }]
    expect(ownerFor('src/main/recall.test.ts :: reads', owners)).toBe('M2-0012')
    expect(ownerFor('src/main/other.test.ts :: x', owners)).toBe('UNOWNED')
  })
})
