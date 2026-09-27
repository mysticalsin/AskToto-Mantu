import { describe, expect, it } from 'vitest'
import {
  parseNodeTestSummary,
  parseSwiftTestSummary,
  renderBaselineReport,
  summarizeVitestReport
} from './verification-baseline.mjs'

describe('summarizeVitestReport', () => {
  it('returns all-zero counts when testResults is missing or empty', () => {
    expect(summarizeVitestReport({})).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 })
    expect(summarizeVitestReport({ testResults: [] })).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 })
  })

  it('counts assertionResults across files, folding pending into skipped', () => {
    const report = {
      testResults: [
        {
          name: '/repo/scripts/alpha.test.ts',
          assertionResults: [
            { title: 'loads settings', status: 'passed' },
            { title: 'rejects bad settings', status: 'failed' },
            { title: 'mac-only keychain path', status: 'pending' }
          ]
        },
        {
          name: '/repo/scripts/beta.test.ts',
          assertionResults: [
            { title: 'parses output', status: 'passed' },
            { title: 'windows-only ACL path', status: 'skipped' },
            { title: 'renders report', status: 'passed' }
          ]
        }
      ]
    }

    expect(summarizeVitestReport(report)).toEqual({ total: 6, passed: 3, failed: 1, skipped: 2 })
  })
})

describe('parseNodeTestSummary', () => {
  it('parses Node test runner TAP summary lines mixed with log noise', () => {
    const text = [
      'preflight: checking fixtures',
      'TAP version 13',
      '# tests 13',
      '# suites 0',
      '# pass 12',
      '# fail 0',
      '# cancelled 0',
      '# skipped 1',
      '# todo 0',
      'postflight: done'
    ].join('\n')

    expect(parseNodeTestSummary(text)).toEqual({ pass: 12, fail: 0, skipped: 1 })
  })

  it('returns null when no Node test summary lines are present', () => {
    expect(parseNodeTestSummary('build completed without a TAP summary')).toBeNull()
  })
})

describe('parseSwiftTestSummary', () => {
  it('parses an XCTest summary line emitted by swift test', () => {
    const text = [
      'Test Suite MetisKitTests.xctest started',
      'Executed 26 tests, with 0 failures (0 unexpected) in 4.2 (4.3) seconds',
      'Test Suite MetisKitTests.xctest passed'
    ].join('\n')

    expect(parseSwiftTestSummary(text)).toEqual({ executed: 26, failures: 0 })
  })

  it('returns null when no XCTest summary line is present', () => {
    expect(parseSwiftTestSummary('swift build finished without running tests')).toBeNull()
  })
})

describe('renderBaselineReport', () => {
  it('renders suite names, statuses, counts, and unavailable notes without invented counts', () => {
    const report = renderBaselineReport([
      {
        suite: 'root vitest',
        status: 'PASS',
        exitCode: 0,
        counts: { total: 128, passed: 127, failed: 0, skipped: 1 }
      },
      {
        suite: 'operator tests',
        status: 'FAIL',
        exitCode: 1,
        counts: { total: 9, passed: 8, failed: 1, skipped: 0 }
      },
      {
        suite: 'swift MetisKit',
        status: 'UNAVAILABLE',
        exitCode: null,
        counts: null,
        note: 'swift toolchain unavailable on this runner'
      }
    ])

    expect(report).toContain('root vitest')
    expect(report).toContain('PASS')
    expect(report).toContain('128')
    expect(report).toContain('127')
    expect(report).toContain('0')
    expect(report).toContain('1')
    expect(report).toContain('operator tests')
    expect(report).toContain('FAIL')
    expect(report).toContain('9')
    expect(report).toContain('8')
    expect(report).toContain('swift MetisKit')
    expect(report).toContain('UNAVAILABLE')
    expect(report).toContain('swift toolchain unavailable on this runner')
    expect(report).not.toContain('swift MetisKit | UNAVAILABLE | 0')
  })
})
