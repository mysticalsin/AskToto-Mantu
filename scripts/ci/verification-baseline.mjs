#!/usr/bin/env node
/**
 * verification-baseline.mjs — M2-0005. CI verification-baseline report collector.
 *
 * Suite failures are data for the report, not failures of this collector. The workflow uploads the
 * generated Markdown and JSON so every push has a reproducible host-specific verification baseline.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0 }
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) return counts

  for (const file of report.testResults) {
    if (!file || typeof file !== 'object' || !Array.isArray(file.assertionResults)) continue
    for (const assertion of file.assertionResults) {
      const status = assertion && typeof assertion === 'object' ? assertion.status : undefined
      counts.total += 1
      if (status === 'passed') counts.passed += 1
      else if (status === 'failed') counts.failed += 1
      else if (status === 'pending' || status === 'skipped') counts.skipped += 1
    }
  }

  return counts
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
  const summary = { pass: null, fail: null, skipped: null }
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^# (pass|fail|skipped) (\d+)$/.exec(line.trim())
    if (match) summary[match[1]] = Number(match[2])
  }

  if (summary.pass === null && summary.fail === null && summary.skipped === null) return null
  return {
    pass: summary.pass ?? 0,
    fail: summary.fail ?? 0,
    skipped: summary.skipped ?? 0
  }
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
  const summary =
    /Executed (\d+) tests?, with (\d+) failures?(?: \(\d+ unexpected\))? in [0-9.]+(?: \([0-9.]+\))? seconds/g
  let match
  let last = null
  while ((match = summary.exec(String(text))) !== null) {
    last = { executed: Number(match[1]), failures: Number(match[2]) }
  }
  return last
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
  const lines = [
    '# Verification baseline',
    '',
    '| Suite | Status | Exit code | Total | Passed | Failed | Skipped | Note |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |'
  ]

  for (const entry of entries) {
    const counts = entry.counts
    lines.push(
      [
        escapeTableCell(entry.suite),
        entry.status,
        entry.exitCode === null ? '' : String(entry.exitCode),
        counts ? String(counts.total) : '',
        counts ? String(counts.passed) : '',
        counts ? String(counts.failed) : '',
        counts ? String(counts.skipped) : '',
        escapeTableCell(entry.note ?? '')
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |')
    )
  }

  return `${lines.join('\n')}\n`
}

function main() {
  let tmp
  const entries = []

  try {
    const outputDir = resolve(process.argv[2] ?? process.cwd())
    tmp = mkdtempSync(join(tmpdir(), 'metis-verification-baseline-'))
    const rootReportPath = join(tmp, 'root.json')
    const proxyReportPath = join(tmp, 'proxy.json')
    const operatorReportPath = join(tmp, 'operator.json')

    const typecheck = runCommand('npm', ['run', 'typecheck'])
    entries.push(
      commandEntry('typecheck', typecheck.exitCode, 'no per-test counts; command does not emit a test report')
    )

    const bugs = runCommand('npm', ['run', 'check:bugs'])
    entries.push(
      commandEntry('check:bugs', bugs.exitCode, 'no per-test counts; command does not emit a test report')
    )

    const root = runCommand('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${rootReportPath}`])
    entries.push(vitestEntry('root vitest', root.exitCode, rootReportPath))

    const skips = runCommand('node', ['scripts/check-skipped-tests.mjs', rootReportPath])
    entries.push(skipEntry(skips.exitCode, rootReportPath))

    const proxy = runCommand('npx', [
      'vitest',
      'run',
      '--config',
      'cloudflare-proxy/vitest.config.ts',
      '--reporter=json',
      `--outputFile=${proxyReportPath}`
    ])
    entries.push(vitestEntry('cloudflare-proxy vitest', proxy.exitCode, proxyReportPath))

    const operator = runCommand('npx', [
      'vitest',
      'run',
      '--config',
      'operator/vitest.config.ts',
      '--reporter=json',
      `--outputFile=${operatorReportPath}`
    ])
    entries.push(vitestEntry('operator vitest', operator.exitCode, operatorReportPath))

    mkdirSync(outputDir, { recursive: true })
    const markdown = renderBaselineReport(entries)
    writeFileSync(join(outputDir, 'verification-baseline.md'), markdown)
    writeFileSync(join(outputDir, 'verification-baseline.json'), `${JSON.stringify(entries, null, 2)}\n`)
    process.stdout.write(markdown)
  } catch (error) {
    console.error(`[verification-baseline] unable to complete report: ${error instanceof Error ? error.message : error}`)
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

function commandEntry(suite, exitCode, note) {
  return { suite, status: exitCode === 0 ? 'PASS' : 'FAIL', exitCode, counts: null, note }
}

function vitestEntry(suite, exitCode, reportPath) {
  const report = readJsonReport(reportPath)
  if (!report) {
    return {
      suite,
      status: 'UNAVAILABLE',
      exitCode,
      counts: null,
      note: 'vitest JSON report was not readable'
    }
  }
  return {
    suite,
    status: exitCode === 0 ? 'PASS' : 'FAIL',
    exitCode,
    counts: summarizeVitestReport(report)
  }
}

function skipEntry(exitCode, reportPath) {
  const report = readJsonReport(reportPath)
  if (!report) {
    return {
      suite: 'check:skips',
      status: exitCode === 0 ? 'PASS' : 'FAIL',
      exitCode,
      counts: null,
      note: 'root vitest JSON report was not readable; skip count was not measured'
    }
  }
  return {
    suite: 'check:skips',
    status: exitCode === 0 ? 'PASS' : 'FAIL',
    exitCode,
    counts: summarizeVitestReport(report),
    note: 'counts reuse the root vitest JSON report from this run'
  }
}

function readJsonReport(reportPath) {
  if (!existsSync(reportPath)) return null
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    return null
  }
}

function runCommand(file, args) {
  try {
    execFileSync(file, args, { stdio: 'inherit', shell: process.platform === 'win32' })
    return { exitCode: 0 }
  } catch (error) {
    return { exitCode: typeof error.status === 'number' ? error.status : 1 }
  }
}

function escapeTableCell(value) {
  return String(value).replaceAll('|', '\\|').replace(/\r?\n/g, '<br>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
