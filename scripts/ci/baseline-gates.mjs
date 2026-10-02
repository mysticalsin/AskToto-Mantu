#!/usr/bin/env node
/**
 * baseline-gates.mjs — M2-0263. Runs the baseline gates against a checked-out ref and writes a
 * content-free record: for each gate the command, exit code, and pass/fail/skip counts, plus every
 * failing test so it can be linked to an owning ticket.
 *
 * It exists because a gate the record cannot measure is reported UNAVAILABLE, and UNAVAILABLE is not a
 * baseline. The tool runs inside GitHub Actions (baseline-gates.yml) — never on a developer Mac — and
 * only writes into --out; the lead files the evidence from the uploaded artifact.
 *
 * The tool is checked out from the branch under test while --target is the ref being measured (an old
 * commit predates this tool and the M2-0190 isolation wrappers), so wrappers come from the tool's own
 * tree and every gate runs with cwd = --target.
 *
 * A gate whose script or directory does not exist at the target ref is recorded as NOT_PRESENT with the
 * reason — never as a pass and never dropped — because absence at that ref is itself a baseline fact.
 *
 * Usage: node baseline-gates.mjs --target <dir> --out <dir> --label <name> [--owners <file.json>]
 *   --owners: JSON array of { "match": "<substring of file :: test title>", "ticket": "M2-####" }.
 *             A failing test matching no entry is recorded with ticket UNOWNED.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const ANSI = /\u001b\[[0-9;]*m/g

/** Counts and failing-test ids from a vitest `--reporter=json` report. */
export function parseVitestJson(text) {
  const report = JSON.parse(text)
  const failed = []
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.status === 'failed') failed.push(`${file.name} :: ${t.fullName ?? t.title}`)
    }
    // A file that failed to load has no assertions but must still count as a failure.
    if (file.status === 'failed' && !(file.assertionResults ?? []).some((t) => t.status === 'failed')) {
      failed.push(`${file.name} :: (suite failed to run)`)
    }
  }
  return {
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
    failedTests: failed
  }
}

/** Counts from the summary block `node --test` prints ("# pass 3" in TAP, "ℹ pass 3" in spec). */
export function parseNodeTestSummary(output) {
  const text = output.replace(ANSI, '')
  const read = (name) => {
    const m = text.match(new RegExp(`^\\s*(?:#|ℹ)\\s+${name}\\s+(\\d+)\\s*$`, 'm'))
    return m ? Number(m[1]) : null
  }
  const passed = read('pass')
  if (passed === null) return null
  return {
    passed,
    failed: read('fail') ?? 0,
    skipped: (read('skipped') ?? 0) + (read('todo') ?? 0),
    failedTests: []
  }
}

/** Counts from `swift test` output: XCTest ("Executed N tests, with M failures") and Swift Testing. */
export function parseSwiftSummary(output) {
  const text = output.replace(ANSI, '')
  const xc = [...text.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)]
  // XCTest prints a per-suite line and then the overall one last; the last match is the run total.
  const last = xc.at(-1)
  let total = last ? Number(last[1]) : 0
  let failed = last ? Number(last[2]) : 0
  const skippedXc = text.match(/with (\d+) tests? skipped/)
  let skipped = skippedXc ? Number(skippedXc[1]) : 0
  const st = text.match(/Test run with (\d+) tests?.* (passed|failed)(?: after [\d.]+ seconds)?(?: with (\d+) issues?)?/)
  if (st) {
    total += Number(st[1])
    if (st[2] === 'failed') failed += Number(st[3] ?? 1)
  }
  if (!last && !st) return null
  return { passed: Math.max(0, total - failed - skipped), failed, skipped, failedTests: [] }
}

/** Ticket owning a failing test, from the caller-supplied owners table. */
export function ownerFor(id, owners) {
  return owners.find((o) => id.includes(o.match))?.ticket ?? 'UNOWNED'
}

function run(command, args, cwd, logPath, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, // .cmd shims (npm/npx) cannot be spawned without a shell on Windows.
    shell: process.platform === 'win32'
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(logPath, output)
  return { exitCode: result.error ? 127 : (result.status ?? 1), output }
}

function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? null : argv[i + 1]
  }
  const target = resolve(flag('target') ?? '')
  const out = resolve(flag('out') ?? '')
  const label = flag('label')
  if (!flag('target') || !flag('out') || !label) {
    console.error('usage: baseline-gates.mjs --target <dir> --out <dir> --label <name> [--owners <file.json>]')
    process.exit(2)
  }
  const owners = flag('owners') ? JSON.parse(readFileSync(resolve(flag('owners')), 'utf8')) : []
  mkdirSync(out, { recursive: true })

  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  const hasScript = (name) => typeof pkg.scripts?.[name] === 'string'
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const node = process.execPath
  const gates = []

  const record = (gate, command, r, counts, extra = {}) => {
    const entry = {
      gate,
      command,
      status: r.exitCode === 0 ? 'PASS' : 'FAIL',
      exitCode: r.exitCode,
      counts: counts ? { passed: counts.passed, failed: counts.failed, skipped: counts.skipped } : null,
      failingTests: (counts?.failedTests ?? []).map((id) => ({ test: id, ticket: ownerFor(id, owners) })),
      ...extra
    }
    gates.push(entry)
    console.log(`[baseline-gates] ${label} ${gate}: ${entry.status} (exit ${entry.exitCode})`)
  }
  const notPresent = (gate, reason) => {
    gates.push({ gate, command: null, status: 'NOT_PRESENT', exitCode: null, counts: null, failingTests: [], reason })
    console.log(`[baseline-gates] ${label} ${gate}: NOT_PRESENT — ${reason}`)
  }

  const vitestGate = (gate, configArgs, needsDir) => {
    if (needsDir && !existsSync(join(target, needsDir))) return notPresent(gate, `${needsDir} does not exist at this ref`)
    const report = join(out, `${gate}.vitest.json`)
    const args = ['vitest', 'run', ...configArgs, '--reporter=json', `--outputFile=${report}`]
    const r = run(npx, args, target, join(out, `${gate}.log`))
    const counts = existsSync(report) ? parseVitestJson(readFileSync(report, 'utf8')) : null
    record(gate, `npx ${args.join(' ')}`, r, counts, { report: counts ? `${gate}.vitest.json` : null })
    return report
  }

  if (hasScript('typecheck')) {
    const r = run(npm, ['run', 'typecheck'], target, join(out, 'typecheck.log'))
    record('typecheck', 'npm run typecheck', r, null)
  } else notPresent('typecheck', 'no typecheck script at this ref')

  const rootReport = vitestGate('root-tests', [])
  vitestGate('proxy-tests', ['--config', 'cloudflare-proxy/vitest.config.ts'], 'cloudflare-proxy')
  vitestGate('operator-tests', ['--config', 'operator/vitest.config.ts'], 'operator')

  if (hasScript('check:skips')) {
    // Reuses the root suite's report so the skip gate judges the very run recorded above.
    const args = ['scripts/check-skipped-tests.mjs', ...(existsSync(rootReport) ? [rootReport] : [])]
    const r = run(node, args, target, join(out, 'check-skips.log'))
    record('check-skips', `node ${args.join(' ')}`, r, null)
  } else notPresent('check-skips', 'no check:skips script at this ref')

  if (hasScript('check:bugs')) {
    const r = run(npm, ['run', 'check:bugs'], target, join(out, 'check-bugs.log'))
    record('check-bugs', 'npm run check:bugs', r, null)
  } else notPresent('check-bugs', 'no check:bugs script at this ref')

  if (existsSync(join(target, 'license-server', 'package.json'))) {
    const install = run(npm, ['ci'], join(target, 'license-server'), join(out, 'license-server-install.log'))
    if (install.exitCode !== 0) {
      record('license-server', 'npm ci (license-server)', install, null)
    } else {
      // Under the tool's own M2-0190 wrapper (a fresh HOME/TMPDIR), not the runner's real home.
      const args = [join(TOOL_ROOT, 'scripts', 'hermetic', 'run-with-sandbox.mjs'), '--', node, '--test']
      const r = run(node, args, join(target, 'license-server'), join(out, 'license-server.log'))
      record('license-server', 'run-with-sandbox.mjs -- node --test (license-server)', r, parseNodeTestSummary(r.output))
    }
  } else notPresent('license-server', 'license-server does not exist at this ref')

  if (process.platform === 'darwin' && existsSync(join(target, 'native-app', 'MetisKit'))) {
    const wrapper = join(TOOL_ROOT, 'scripts', 'hermetic', 'run-swift-tests.sh')
    const r = run('bash', [wrapper, join(target, 'native-app', 'MetisKit')], target, join(out, 'swift-test.log'))
    record('swift-test', 'run-swift-tests.sh native-app/MetisKit', r, parseSwiftSummary(r.output))
  } else {
    notPresent('swift-test', process.platform === 'darwin' ? 'native-app/MetisKit does not exist at this ref' : 'swift test runs on macOS runners only')
  }

  const summary = {
    label,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runnerImage: process.env.ImageOS ? `${process.env.ImageOS}/${process.env.ImageVersion ?? 'unknown'}` : (process.env.RUNNER_OS ?? process.platform),
    runnerOs: process.env.RUNNER_OS ?? process.platform,
    targetSha: process.env.TARGET_SHA ?? null,
    gates
  }
  writeFileSync(join(out, `${label}.json`), `${JSON.stringify(summary, null, 2)}\n`)
  // The record is the deliverable; a red gate is a finding, not a tool failure.
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
