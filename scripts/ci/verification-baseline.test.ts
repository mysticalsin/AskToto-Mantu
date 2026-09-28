import { describe, expect, it } from 'vitest'
import {
  redactAbsolutePaths,
  renderBaselineReport,
  renderSkipInventory,
  summarizeVitestReport
} from './verification-baseline.mjs'

describe('summarizeVitestReport', () => {
  it('returns all-zero counts when testResults is missing or empty', () => {
    const missing = summarizeVitestReport({})
    const empty = summarizeVitestReport({ testResults: [] })

    expect(missing).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0, failedIds: [] })
    expect(missing.total).toBe(missing.passed + missing.failed + missing.skipped)
    expect(empty).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0, failedIds: [] })
    expect(empty.total).toBe(empty.passed + empty.failed + empty.skipped)
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

    const summary = summarizeVitestReport(report)

    expect(summary).toEqual({
      total: 6,
      passed: 3,
      failed: 1,
      skipped: 2,
      failedIds: ['scripts/alpha.test.ts :: rejects bad settings']
    })
    expect(summary.total).toBe(summary.passed + summary.failed + summary.skipped)
  })

  it('counts a file-level collection failure as one named failure', () => {
    const report = {
      testResults: [
        {
          name: '/repo/scripts/broken-import.test.ts',
          status: 'failed',
          assertionResults: []
        }
      ]
    }

    const summary = summarizeVitestReport(report)

    expect(summary).toEqual({
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      failedIds: ['scripts/broken-import.test.ts (failed to collect)']
    })
    expect(summary.total).toBe(summary.passed + summary.failed + summary.skipped)
  })

  it('buckets todo assertions into skipped so counts always balance', () => {
    const report = {
      testResults: [
        {
          name: '/repo/scripts/future.test.ts',
          assertionResults: [{ title: 'documents the next assertion', status: 'todo' }]
        }
      ]
    }

    const summary = summarizeVitestReport(report)

    expect(summary).toEqual({ total: 1, passed: 0, failed: 0, skipped: 1, failedIds: [] })
    expect(summary.total).toBe(summary.passed + summary.failed + summary.skipped)
  })
})

describe('renderBaselineReport', () => {
  it('renders suite names, statuses, counts, and unavailable notes without invented counts', () => {
    const report = renderBaselineReport([
      {
        suite: 'root vitest',
        status: 'PASS',
        exitCode: 0,
        counts: { total: 128, passed: 127, failed: 0, skipped: 1, failedIds: [] }
      },
      {
        suite: 'operator tests',
        status: 'FAIL',
        exitCode: 1,
        counts: { total: 9, passed: 8, failed: 1, skipped: 0, failedIds: [] }
      },
      {
        suite: 'swift MetisKit',
        status: 'UNAVAILABLE',
        exitCode: null,
        counts: null,
        note: 'swift toolchain unavailable on this runner'
      }
    ])

    expect(report).toBe(
      [
        '# Verification baseline',
        '',
        '| Suite | Status | Exit code | Total | Passed | Failed | Skipped | Note |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
        '| root vitest | PASS | 0 | 128 | 127 | 0 | 1 |  |',
        '| operator tests | FAIL | 1 | 9 | 8 | 1 | 0 |  |',
        '| swift MetisKit | UNAVAILABLE |  |  |  |  |  | swift toolchain unavailable on this runner |',
        ''
      ].join('\n')
    )
  })

  it('escapes pipe characters inside report notes', () => {
    const report = renderBaselineReport([
      {
        suite: 'operator tests',
        status: 'FAIL',
        exitCode: 1,
        counts: null,
        note: 'see suite A | suite B'
      }
    ])

    expect(report).toBe(
      [
        '# Verification baseline',
        '',
        '| Suite | Status | Exit code | Total | Passed | Failed | Skipped | Note |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
        '| operator tests | FAIL | 1 |  |  |  |  | see suite A \\| suite B |',
        ''
      ].join('\n')
    )
  })

  it('renders a failing tests section for named failed ids', () => {
    const report = renderBaselineReport([
      {
        suite: 'root vitest',
        status: 'FAIL',
        exitCode: 1,
        counts: {
          total: 2,
          passed: 1,
          failed: 1,
          skipped: 0,
          failedIds: ['scripts/alpha.test.ts :: rejects bad settings']
        }
      }
    ])

    expect(report).toBe(
      [
        '# Verification baseline',
        '',
        '| Suite | Status | Exit code | Total | Passed | Failed | Skipped | Note |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
        '| root vitest | FAIL | 1 | 2 | 1 | 1 | 0 |  |',
        '',
        '## Failing tests',
        '',
        '- root vitest: scripts/alpha.test.ts :: rejects bad settings',
        ''
      ].join('\n')
    )
  })

  it('omits the failing tests section when no failed ids are present', () => {
    const report = renderBaselineReport([
      {
        suite: 'root vitest',
        status: 'PASS',
        exitCode: 0,
        counts: { total: 1, passed: 1, failed: 0, skipped: 0, failedIds: [] }
      }
    ])

    expect(report).not.toContain('## Failing tests')
  })
})

describe('redactAbsolutePaths', () => {
  it('replaces fake macOS and Windows user roots while preserving surrounding text and path remainder', () => {
    expect(redactAbsolutePaths('before /Users/example/dev/project/file.ts after')).toBe(
      'before ~/dev/project/file.ts after'
    )
    expect(redactAbsolutePaths('before C:\\Users\\Example\\dev\\project\\file.ts after')).toBe(
      'before ~\\dev\\project\\file.ts after'
    )
  })
})

describe('renderSkipInventory', () => {
  it('renders skipped tests as a two-column table', () => {
    expect(
      renderSkipInventory([
        { id: 'scripts/local-runtime.test.ts :: skips live server', reason: 'Runs only with local weights.' },
        { id: 'scripts/cli-win.test.ts :: quotes empty args', reason: 'Windows-only shell quoting.' }
      ])
    ).toBe(
      [
        '## Skipped tests',
        '',
        '| Test | Reason |',
        '| --- | --- |',
        '| scripts/local-runtime.test.ts :: skips live server | Runs only with local weights. |',
        '| scripts/cli-win.test.ts :: quotes empty args | Windows-only shell quoting. |',
        ''
      ].join('\n')
    )
  })

  it('escapes pipe characters inside reasons', () => {
    expect(renderSkipInventory([{ id: 'scripts/example.test.ts :: skips', reason: 'Reason with a | pipe.' }])).toBe(
      [
        '## Skipped tests',
        '',
        '| Test | Reason |',
        '| --- | --- |',
        '| scripts/example.test.ts :: skips | Reason with a \\| pipe. |',
        ''
      ].join('\n')
    )
  })

  it("renders an empty string when there isn't a skip inventory", () => {
    expect(renderSkipInventory([])).toBe('')
  })
})
