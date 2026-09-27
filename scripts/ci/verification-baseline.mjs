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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BASELINE, REASONS, extractSkippedTests, reasonFor, relFileFromVitestName } from '../skip-reasons.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Summarizes a Vitest JSON-reporter object shaped as:
 * `{ testResults: Array<{ name: string, assertionResults: Array<{ title: string, status: string }> }> }`.
 *
 * Counts every assertion result, treats non-running statuses as skipped, and records named failed
 * assertions or file-level collection failures.
 *
 * @param {unknown} report
 * @returns {{ total: number, passed: number, failed: number, skipped: number, failedIds: string[] }}
 */
export function summarizeVitestReport(report) {
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0, failedIds: [] }
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) return counts

  for (const file of report.testResults) {
    if (!file || typeof file !== 'object') continue
    const relFile = relFileFromVitestName(file.name)
    if (!Array.isArray(file.assertionResults) || file.assertionResults.length === 0) {
      if (file.status === 'failed') {
        counts.total += 1
        counts.failed += 1
        counts.failedIds.push(`${relFile} (failed to collect)`)
      }
      continue
    }
    for (const assertion of file.assertionResults) {
      const status = assertion.status
      counts.total += 1
      if (status === 'passed') {
        counts.passed += 1
      } else if (status === 'failed') {
        counts.failed += 1
        counts.failedIds.push(`${relFile} :: ${assertion.title}`)
      } else {
        counts.skipped += 1
      }
    }
  }

  return counts
}

/**
 * Renders a Markdown CI verification-baseline report.
 *
 * PASS and FAIL entries render status, exit code, and Vitest counts. UNAVAILABLE or command-only
 * entries render notes without fabricated counts. Named failed tests are listed after the table.
 *
 * @param {Array<{
 *   suite: string,
 *   status: 'PASS' | 'FAIL' | 'UNAVAILABLE',
 *   exitCode: number | null,
 *   counts: { total: number, passed: number, failed: number, skipped: number, failedIds?: string[] } | null,
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

  const failedIds = entries.flatMap((entry) => (entry.counts?.failedIds ?? []).map((id) => ({ suite: entry.suite, id })))
  if (failedIds.length > 0) {
    lines.push('', '## Failing tests', '')
    for (const entry of failedIds) lines.push(`- ${entry.suite}: ${entry.id}`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * Renders the skipped tests inventory collected from the root Vitest report.
 *
 * @param {Array<{ id: string, reason: string }>} inventory
 * @returns {string}
 */
export function renderSkipInventory(inventory) {
  if (inventory.length === 0) return ''
  const lines = ['## Skipped tests', '', '| Test | Reason |', '| --- | --- |']
  for (const entry of inventory) {
    lines.push(`| ${escapeTableCell(entry.id)} | ${escapeTableCell(entry.reason)} |`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Redacts user-specific home directory prefixes from display text while preserving the remaining path.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactAbsolutePaths(text) {
  return String(text)
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '~')
}

function main() {
  let tmp
  const entries = []
  let skipInventory = []

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
    const skipSummary = skipEntry(skips.exitCode, rootReportPath)
    entries.push(skipSummary.entry)
    skipInventory = skipSummary.inventory

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
    const markdown = `${renderBaselineReport(entries)}${renderSkipInventory(skipInventory)}`
    writeFileSync(join(outputDir, 'verification-baseline.md'), markdown)
    writeFileSync(join(outputDir, 'verification-baseline.json'), `${JSON.stringify(entries, null, 2)}\n`)
    process.stdout.write(markdown)
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
      entry: {
        suite: 'check:skips',
        status: exitCode === 0 ? 'PASS' : 'FAIL',
        exitCode,
        counts: null,
        note: 'root vitest JSON report was not readable; skip count was not measured'
      },
      inventory: []
    }
  }
  const skipped = extractSkippedTests(report)
  const undeclared = skipped.filter((skip) => !reasonFor(skip.id))
  const allowed = BASELINE[process.platform]
  const baselineNote =
    allowed === undefined ? `no declared baseline for ${process.platform}` : `declared baseline ceiling ${allowed}`
  const inventory = skipped.map((skip) => ({
    id: redactAbsolutePaths(skip.id),
    reason: reasonFor(skip.id) ?? 'UNDECLARED'
  }))

  return {
    entry: {
      suite: 'check:skips',
      status: exitCode === 0 ? 'PASS' : 'FAIL',
      exitCode,
      counts: null,
      note:
        `${skipped.length} skipped tests found in the root vitest report; ${baselineNote}; ` +
        `${undeclared.length} undeclared; ${REASONS.length} declared reason patterns available`
    },
    inventory
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
    execFileSync(file, args, { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
    return { exitCode: 0 }
  } catch (error) {
    return { exitCode: typeof error.status === 'number' ? error.status : 1 }
  }
}

function escapeTableCell(value) {
  return String(value).replaceAll('|', '\\|').replace(/\r?\n/g, '<br>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
