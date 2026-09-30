#!/usr/bin/env node
/**
 * Hosted candidate proof for M2-0471. Runs the M2-0192 stall sampler check against an installed,
 * promotable macOS app on a fresh ASKTOTO_USERDATA profile, then writes a content-free report.
 *
 * Usage:
 *   node scripts/qa/stall-sampler-hosted.mjs <installed app> <report.json> [--stop-seconds 15]
 *
 * Exit 0 PASS · 1 FAIL · 2 PRECONDITION.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const READY_TIMEOUT_MS = 60_000
const HELPER_TIMEOUT_MS = 30_000
const POLL_MS = 500
const DEFAULT_STOP_SECONDS = 15

export const IDLE_SLEEP_WAKE_ROW = Object.freeze({
  row: 'idle-60m-sleep-wake',
  status: 'BLOCKED_EXTERNAL',
  unblock: 'Run this row on a long-lived physical macOS QA host that can remain idle for 60 minutes, including one sleep and one wake, before the stop.'
})

class Precondition extends Error {}
class Failure extends Error {}

function parseArgs(argv) {
  const args = { stopSeconds: DEFAULT_STOP_SECONDS }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--stop-seconds') args.stopSeconds = Number(argv[++i])
    else if (arg.startsWith('--')) throw new Precondition(`Unknown argument: ${arg}`)
    else positional.push(arg)
  }
  if (positional.length !== 2 || !Number.isInteger(args.stopSeconds) || args.stopSeconds <= 0) {
    throw new Precondition('Usage: stall-sampler-hosted.mjs <installed app> <report.json> [--stop-seconds 15]')
  }
  args.app = positional[0]
  args.report = positional[1]
  return args
}

function parseAuditLog(text) {
  const records = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      records.push({ parse_error: true })
    }
  }
  return records
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function readAudit(profile) {
  return parseAuditLog(readText(join(profile, 'logs', 'audit.log')))
}

function countAuditEvent(profile, event) {
  return readAudit(profile).filter((record) => record.event === event).length
}

function countBundles(profile) {
  const dir = join(profile, 'diagnostics', 'stalls')
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.txt')).length
  } catch {
    return 0
  }
}

function samplerErrorSeen(profile) {
  const audit = readAudit(profile)
  if (audit.some((record) => record.event === 'app.stall.sample_failed')) return true
  const logsDir = join(profile, 'logs')
  try {
    return readdirSync(logsDir)
      .filter((name) => /\.log$/.test(name))
      .some((name) => /sample.*(fail|error|not permitted)|not permitted.*sample/i.test(readText(join(logsDir, name))))
  } catch {
    return false
  }
}

function helperChildren(pid) {
  const child = spawnSync('pgrep', ['-P', String(pid), '-f', 'metis-mac-helper stall-watch'], { encoding: 'utf8' })
  return child.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await sleep(POLL_MS)
  }
}

function stripSecretEnv(env, profile) {
  const next = { ...env, ASKTOTO_USERDATA: profile }
  for (const key of Object.keys(next)) {
    if (/_API_KEY$/i.test(key) || /TOKEN/i.test(key) || /SECRET/i.test(key)) delete next[key]
  }
  return next
}

function appExecutable(app) {
  if (!app.endsWith('.app') || !existsSync(app)) throw new Precondition('The installed app must be an existing .app bundle.')
  const executable = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', join(app, 'Contents', 'Info.plist')], {
    encoding: 'utf8'
  }).trim()
  const path = join(app, 'Contents', 'MacOS', executable)
  if (!existsSync(path)) throw new Precondition('The installed app has no executable declared by Info.plist.')
  return path
}

function parseCensusLine(line) {
  const match = line.match(/^helper \d+ after (boot|idle|stop) \(cputime rss_kb\):\s*(\S+)\s+(\d+)$/)
  if (!match) return null
  return {
    row: match[1] === 'stop' ? 'after-stop' : 'after-boot',
    cputime: match[2],
    rss_kb: Number(match[3])
  }
}

function contentFreeFailure(reason) {
  if (!reason) return null
  return /[/\\@]/.test(reason) ? 'stall sampler check failed before content-free detail could be recorded' : reason
}

export function parseCheckOutput({ stdout = '', stderr = '', exitCode = 0 }) {
  const helper = {}
  let bundleSizeBytes = null
  let detectionLatencyMs = null
  let helperExitMs = null
  for (const line of stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const census = parseCensusLine(line)
    if (census) {
      helper[census.row] = { cputime: census.cputime, rss_kb: census.rss_kb }
      continue
    }
    const stop = line.match(/^PASS stop: [^,]+, (\d+) bytes, raw left: \d+, detection latency: (-?\d+)s$/)
    if (stop) {
      bundleSizeBytes = Number(stop[1])
      detectionLatencyMs = Number(stop[2]) * 1000
      continue
    }
    const parentDeath = line.match(/^PASS parent death: helper exited in (\d+)ms$/)
    if (parentDeath) helperExitMs = Number(parentDeath[1])
  }
  const failLine = stderr.split(/\r?\n/).map((value) => value.trim()).find((line) => line.startsWith('FAIL: '))
  return {
    exitCode,
    failure: contentFreeFailure(failLine ? failLine.slice('FAIL: '.length) : null),
    helper,
    bundleSizeBytes,
    detectionLatencyMs,
    helperExitMs
  }
}

export function buildReport({
  check,
  stopSeconds,
  stallWatchChildCount,
  bundleCount,
  appStallSampledCount,
  samplerError = false
}) {
  const rows = [
    { row: 'stall-watch-child', status: stallWatchChildCount === 1 ? 'PASS' : 'FAIL', count: stallWatchChildCount },
    IDLE_SLEEP_WAKE_ROW,
    { row: 'stop-sampled-bundle', status: bundleCount === 1 ? 'PASS' : 'FAIL', count: bundleCount },
    { row: 'stop-sampled-audit', status: appStallSampledCount === 1 ? 'PASS' : 'FAIL', count: appStallSampledCount },
    { row: 'helper-parent-death', status: check.helperExitMs !== null && check.helperExitMs <= 6000 ? 'PASS' : 'FAIL', exit_ms: check.helperExitMs }
  ]
  if (samplerError) rows.push({ row: 'sampler-access', status: 'FAIL', reason: 'sampler-error-recorded' })
  if (check.failure) rows.push({ row: 'check-script', status: 'FAIL', reason: check.failure })
  const failing = rows.find((row) => row.status === 'FAIL')
  return {
    schema: 1,
    ticket: 'M2-0471',
    scenario: 'stall-sampler',
    result: failing ? 'FAIL' : 'PASS',
    stop_seconds: stopSeconds,
    stall_watch_child_count: stallWatchChildCount,
    bundle_count: bundleCount,
    app_stall_sampled_count: appStallSampledCount,
    bundle_size_bytes: check.bundleSizeBytes,
    detection_latency_ms: check.detectionLatencyMs,
    helper: {
      after_boot: check.helper['after-boot'] ?? null,
      after_stop: check.helper['after-stop'] ?? null,
      exit_after_main_kill_ms: check.helperExitMs
    },
    rows
  }
}

export function hostedOutcomeForExit(exitCode) {
  return exitCode === 0 ? 'PASS' : exitCode === 2 ? 'PRECONDITION' : 'FAIL'
}

async function main() {
  if (process.platform !== 'darwin') throw new Precondition('This proof runs on macOS only.')
  const args = parseArgs(process.argv.slice(2))
  const executable = appExecutable(args.app)
  const profile = mkdtempSync(join(tmpdir(), 'metis-stall-sampler-'))
  let child
  try {
    const env = stripSecretEnv(process.env, profile)
    child = spawn(executable, [], { env, stdio: 'ignore' })
    if (!child.pid) throw new Failure('The app process did not expose a pid.')
    const ready = await waitFor(() => readAudit(profile).some((record) => record.event === 'app.renderer.ready'), READY_TIMEOUT_MS)
    if (!ready) throw new Failure('app.renderer.ready was not recorded within 60s.')
    const helpers = await waitFor(() => {
      const children = helperChildren(child.pid)
      return children.length ? children : undefined
    }, HELPER_TIMEOUT_MS)
    if (!helpers) throw new Failure('stall-watch child did not appear within 30s.')

    const check = spawnSync('bash', ['scripts/qa/stall-sampler-check.sh', String(child.pid), profile], {
      encoding: 'utf8',
      env: { ...process.env, STALL_STOP_SECONDS: String(args.stopSeconds) },
      maxBuffer: 64 * 1024 * 1024
    })
    const parsed = parseCheckOutput({ stdout: check.stdout, stderr: check.stderr, exitCode: check.status })
    const report = buildReport({
      check: parsed,
      stopSeconds: args.stopSeconds,
      stallWatchChildCount: helpers.length,
      bundleCount: countBundles(profile),
      appStallSampledCount: countAuditEvent(profile, 'app.stall.sampled'),
      samplerError: samplerErrorSeen(profile)
    })
    mkdirSync(dirname(args.report), { recursive: true })
    writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report, null, 2))
    if (check.status === 2) throw new Precondition(parsed.failure ?? 'stall sampler check precondition failed')
    if (check.status !== 0 || report.result !== 'PASS') throw new Failure(parsed.failure ?? 'stall sampler check failed')
  } finally {
    if (child?.pid) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    rmSync(profile, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
    process.exit(0)
  } catch (error) {
    console.error(`[stall-sampler-hosted] ${error.message}`)
    process.exit(error instanceof Precondition ? 2 : 1)
  }
}
