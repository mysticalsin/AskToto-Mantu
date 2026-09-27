#!/usr/bin/env node
/**
 * verification-baseline.mjs — M2-0005. Contract stub for the CI verification-baseline report.
 *
 * This file intentionally contains no implementation yet. The companion contract test records the
 * behavior the next M2-0005 step must build; every exported function throws immediately so no partial
 * logic can accidentally satisfy the RED suite.
 */
import { pathToFileURL } from 'node:url'

/**
 * Summarize a Vitest JSON-reporter object shaped as:
 * `{ testResults: Array<{ name: string, assertionResults: Array<{ title: string, status: string }> }> }`.
 *
 * Intended contract: count every assertionResult across every testResults entry and return
 * `{ total, passed, failed, skipped }`; `pending` counts as skipped; an empty or missing testResults
 * array returns all-zero counts.
 *
 * @param {unknown} report
 * @returns {{ total: number, passed: number, failed: number, skipped: number }}
 */
export function summarizeVitestReport(report) {
  throw new Error('not implemented — M2-0005')
}

/**
 * Parse Node's built-in test runner TAP summary lines from arbitrary captured stdout/stderr.
 *
 * Intended contract: parse `# pass N`, `# fail N`, and `# skipped N` lines and return
 * `{ pass, fail, skipped }`; return `null` when no such summary lines are present.
 *
 * @param {string} text
 * @returns {{ pass: number, fail: number, skipped: number } | null}
 */
export function parseNodeTestSummary(text) {
  throw new Error('not implemented — M2-0005')
}

/**
 * Parse XCTest's `swift test` summary line.
 *
 * Intended contract: parse the documented XCTest form
 * `Executed N test(s), with F failure(s) (U unexpected) in S.sss (S.sss) seconds` and the plain
 * `F failure(s)` variant, returning `{ executed, failures }`; return `null` when absent. No captured
 * MetisKit summary fixture was present in this repository, so the contract uses the XCTest summary
 * format documented by the runner output itself.
 *
 * @param {string} text
 * @returns {{ executed: number, failures: number } | null}
 */
export function parseSwiftTestSummary(text) {
  throw new Error('not implemented — M2-0005')
}

/**
 * Render a Markdown CI verification-baseline report.
 *
 * Intended contract: `entries` is an array of suite results, one per CI verification suite. PASS and
 * FAIL entries render their status, exit code, and `{ total, passed, failed, skipped }` counts.
 * UNAVAILABLE entries render their note instead of fabricating counts.
 *
 * @param {Array<{
 *   suite: string,
 *   status: 'PASS' | 'FAIL' | 'UNAVAILABLE',
 *   exitCode: number | null,
 *   counts: { total: number, passed: number, failed: number, skipped: number } | null,
 *   note?: string
 * }>} entries
 * @returns {string}
 */
export function renderBaselineReport(entries) {
  throw new Error('not implemented — M2-0005')
}

function main() {
  throw new Error('not implemented — M2-0005')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
