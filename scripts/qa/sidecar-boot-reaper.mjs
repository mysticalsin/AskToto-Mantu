#!/usr/bin/env node
/**
 * Packaged proof for M2-0233. Runs on hosted macOS and Windows QA lanes against an installed packaged
 * app and fresh ASKTOTO_USERDATA profiles. The required proof registers a live stand-in sidecar with the
 * same append-only identity contract as llama-server, hard-kills the app, relaunches, and requires the
 * old sidecar pid to disappear within 5 s of boot with a sidecar.reaped safe-ownership audit. A real
 * llama-server variant is also reported; missing model assets are BLOCKED_EXTERNAL evidence, not a red
 * smoke lane. The real llama-server launches set METIS_QA_HOST_FLOOR_OVERRIDE=1 (M2-0482) so a 7 GiB hosted runner
 * is not refused by the bundled model's RAM floors; the report records that and the host memory figures.
 *
 * On macOS a third row (M2-0468) isolates the reaper's legacy rule: the harness seeds a sha256-verified copy of
 * the bundled pinned model into <profile>/local-llm, starts the bundle's own llama-server on it as a launchd
 * orphan before the app, and requires sidecar.reaped {reason: 'legacy-orphan'} for that pid within 5 s of boot.
 * A second orphan of the same binary whose -m stays on the bundled model is the negative control: it must
 * survive, so the rule never matches by name or executable alone.
 *
 * Usage:
 *   node scripts/qa/sidecar-boot-reaper.mjs <installed app> <report.json> [--require-real-llama]
 *
 * Exit 0 PASS or PASS-with-BLOCKED_EXTERNAL · 1 FAIL · 2 usage/precondition, and with --require-real-llama
 * also 2 when the real llama-server row is BLOCKED_EXTERNAL. The report is content-free: pids, counts,
 * timings and audit event counts only; no paths, command lines, profile locations or user content.
 */

import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { freemem, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { LOCAL_MODEL_ASSETS, LOCAL_MODEL_ID } from '../local-model-assets.mjs'
import { LOCAL_LLM_SETTINGS } from './lib/local-llm-settings.mjs'
import { listProcesses, ownedProcesses, roleCounts } from './owned-processes.mjs'
import { sha256File } from './provenance.mjs'

const READY_TIMEOUT_MS = 150_000
const LLAMA_TIMEOUT_MS = 120_000
const REAPER_BOUND_MS = 5_000
const POLL_MS = 250
const REAL_LLAMA_UNBLOCK = 'Seed the packaged local model assets.'
const LEGACY_ORPHAN_UNBLOCK = 'Seed the packaged llama-server and local model assets.'
const LEGACY_ORPHAN_OFF_MAC_UNBLOCK = 'Run the legacy-orphan proof on a macOS hosted runner; it is macOS-only.'
// The reaper reads process start times from ps lstart, which has one-second resolution, and requires the
// orphan to start strictly before the current main.
const START_ORDER_GAP_MS = 2_000
// The boot reaper checks every process in one pass; this lets it finish that pass after the orphan's reap.
const REAPER_PASS_SETTLE_MS = 1_000

export const REQUIRE_REAL_LLAMA_FLAG = '--require-real-llama'

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/

class Precondition extends Error {}
class Failure extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function parseAuditLog(text) {
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      /* ignore partial or malformed lines */
    }
  }
  return records
}

function readAudit(profile) {
  try {
    return parseAuditLog(readFileSync(join(profile, 'logs', 'audit.log'), 'utf8'))
  } catch {
    return []
  }
}

export function parseSidecarRegistry(text) {
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      /* corrupt registry lines are product failures, but the proof must not guess from them */
    }
  }
  return records
}

export function registryHasSpawnedPid(records, pid) {
  return records.some((record) => record?.kind === 'spawned' && record.pid === pid)
}

function readSidecarRegistry(profile) {
  const runDir = join(profile, 'run')
  try {
    return readdirSync(runDir)
      .filter((file) => /^sidecars-[a-zA-Z0-9-]+\.json$/.test(file))
      .flatMap((file) => parseSidecarRegistry(readFileSync(join(runDir, file), 'utf8')))
  } catch {
    return []
  }
}

function eventCounts(records) {
  const counts = {}
  for (const event of ['app.started', 'app.renderer.ready', 'sidecar.spawn', 'sidecar.reaped', 'sidecar.reap.skipped']) {
    counts[event] = records.filter((record) => record.event === event).length
  }
  return counts
}

export function hasAtLeastEvent(records, event, count) {
  return records.filter((record) => record.event === event).length >= count
}

function sidecarReapReason(records, pid) {
  const record = records.find(
    (entry) =>
      entry.event === 'sidecar.reaped' &&
      entry.pid === pid &&
      (entry.reason === 'registry' || entry.reason === 'legacy-orphan')
  )
  return record?.reason
}

export function observedReapedOrphan(records, pid, alive = processAlive) {
  const reason = sidecarReapReason(records, pid)
  if (!reason || alive(pid)) return null
  return reason
}

/** The legacy rule's own audit for `pid`: a registry reap of the same pid never counts for this row. */
export function observedLegacyReap(records, pid, alive = processAlive) {
  const reaped = records.some(
    (entry) => entry.event === 'sidecar.reaped' && entry.name === 'llama-server' && entry.reason === 'legacy-orphan' && entry.pid === pid
  )
  return reaped && !alive(pid)
}

/**
 * The legacy-orphan row's verdict from its observations: the seeded orphan was reaped by the legacy rule within
 * 5 s of boot, and the negative control (same binary, -m outside <userData>/local-llm) was neither reaped nor gone.
 */
export function legacyOrphanVerdict({ records, orphanPid, controlPid, reapedMs, orphanAlive, controlAlive }) {
  const failures = []
  const reapedInBound = typeof reapedMs === 'number' && reapedMs <= REAPER_BOUND_MS
  if (!observedLegacyReap(records, orphanPid, () => orphanAlive) || !reapedInBound) {
    failures.push('seeded llama-server orphan was not reaped as legacy-orphan within 5 s of boot')
  }
  if (records.some((entry) => entry.event === 'sidecar.reaped' && entry.pid === controlPid)) {
    failures.push('negative control llama-server was reaped although its model is outside the profile local-llm')
  } else if (!controlAlive) {
    failures.push('negative control llama-server was not alive after the boot reaper ran')
  }
  return { result: failures.length === 0 ? 'pass' : 'fail', failures }
}

function psRows() {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
    env: { ...process.env, LC_ALL: 'C' },
    encoding: 'utf8'
  })
  return parsePsRows(output)
}

function parsePsRows(output) {
  const rows = []
  for (const line of output.split('\n')) {
    const match = PS_ROW.exec(line)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), started: match[3], command: match[4] })
  }
  return rows
}

function argsFingerprint(args) {
  return createHash('sha256').update(JSON.stringify(args), 'utf8').digest('hex')
}

/**
 * `ps`'s command column is argv joined with plain spaces, with no quoting to mark which spaces were
 * inside a single argv element (e.g. a `node -e "<js with spaces>"` stand-in) versus between elements —
 * re-splitting it on whitespace cannot recover the original argv and silently produces the wrong
 * fingerprint. macOS production identity (registry.ts's darwin branch) never does this: it shells out to
 * the packaged metis-mac-helper's `proc-info`, which reads the kernel's real argv via KERN_PROCARGS2
 * (native/mac-helper/main.swift). This proof must use the exact same source, or its registration check
 * exercises a path the product never takes.
 */
export function parseMacHelperProcInfo(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (
    typeof parsed?.pid !== 'number' ||
    typeof parsed?.osStartTime !== 'string' ||
    typeof parsed?.exeRealpath !== 'string' ||
    !Array.isArray(parsed?.args)
  ) {
    return null
  }
  return {
    pid: parsed.pid,
    ppid: typeof parsed.ppid === 'number' ? parsed.ppid : undefined,
    pgid: typeof parsed.pgid === 'number' ? parsed.pgid : undefined,
    osStartTime: parsed.osStartTime,
    exeRealpath: parsed.exeRealpath,
    args: parsed.args
  }
}

function macHelperProcInfo(installRoot, pid) {
  const helperPath = join(installRoot, 'Contents', 'Resources', 'mac-helper', 'metis-mac-helper')
  let stdout
  try {
    stdout = execFileSync(helperPath, ['proc-info', String(pid)], { encoding: 'utf8', timeout: 5_000 })
  } catch {
    return null
  }
  return parseMacHelperProcInfo(stdout)
}

function windowsProcessIdentity(pid) {
  const powershell = win32.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script = [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class MetisProcNative { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr hProcess, out long creation, out long exit, out long kernel, out long user); [DllImport("shell32.dll", SetLastError=true)] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argc); [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr handle); public static string[] SplitCommandLine(string commandLine) { if (String.IsNullOrWhiteSpace(commandLine)) return new string[0]; int argc = 0; IntPtr argv = CommandLineToArgvW(commandLine, out argc); if (argv == IntPtr.Zero) return new string[] { commandLine }; try { string[] args = new string[argc]; for (int i = 0; i < argc; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size)) ?? ""; return args; } finally { LocalFree(argv); } } }\'',
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { exit 0 }',
    `$cim = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    '[long]$creation = 0; [long]$exit = 0; [long]$kernel = 0; [long]$user = 0',
    'if (-not [MetisProcNative]::GetProcessTimes($p.Handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) { exit 0 }',
    '$start = [DateTime]::FromFileTimeUtc($creation).ToString("o")',
    '$payload = @{ pid = [int]$p.Id; ppid = [int]$cim.ParentProcessId; pgid = [int]$p.Id; osStartTime = $start; exeRealpath = $p.Path; args = @([MetisProcNative]::SplitCommandLine($cim.CommandLine)) }',
    '$payload | ConvertTo-Json -Compress'
  ].join('; ')
  const stdout = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  }).trim()
  return stdout ? JSON.parse(stdout) : null
}

function processIdentity(pid, installRoot) {
  if (process.platform === 'win32') return windowsProcessIdentity(pid)
  return macHelperProcInfo(installRoot, pid)
}

function identityArgsMatchFingerprint(args, expected) {
  if (argsFingerprint(args) === expected) return true
  if (args.length > 0 && argsFingerprint(args.slice(1)) === expected) return true
  return false
}

function appendRegistryRecord(profile, sessionId, record) {
  const runDir = join(profile, 'run')
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  appendFileSync(join(runDir, `sidecars-${sessionId}.json`), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function recordSpawnedStandIn(profile, sessionId, name, child, executable, args, installRoot) {
  appendRegistryRecord(profile, sessionId, {
    kind: 'intent',
    sessionId,
    name,
    argsFingerprint: argsFingerprint(args),
    recordedAt: new Date().toISOString()
  })
  const pid = child.pid
  if (typeof pid !== 'number') throw new Failure('stand-in sidecar pid was unavailable')
  const identity = processIdentity(pid, installRoot)
  const exeRealpath = realpathSync.native(executable)
  if (!identity) throw new Failure('stand-in sidecar identity was unavailable')
  if (identity.pid !== pid) throw new Failure('stand-in sidecar identity pid mismatch')
  if (identity.exeRealpath !== exeRealpath) throw new Failure('stand-in sidecar identity executable mismatch')
  if (!identityArgsMatchFingerprint(identity.args, argsFingerprint(args))) throw new Failure('stand-in sidecar identity argv mismatch')
  appendRegistryRecord(profile, sessionId, {
    kind: 'spawned',
    sessionId,
    name,
    pid,
    pgid: identity.pgid ?? pid,
    osStartTime: identity.osStartTime,
    exeRealpath,
    argsFingerprint: argsFingerprint(args),
    recordedAt: new Date().toISOString()
  })
  return identity
}

function classify(command, bundle) {
  if (command.includes(`${bundle}/Contents/Resources/llama/`)) return 'llama-server'
  if (command.includes(`${bundle}/Contents/MacOS/`) && !command.includes('--type=')) return 'main'
  return 'other'
}

function descendantsOf(processes, rootPid) {
  const byPpid = new Map()
  for (const proc of processes) {
    const group = byPpid.get(proc.ppid) ?? []
    group.push(proc)
    byPpid.set(proc.ppid, group)
  }
  const found = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()
    for (const child of byPpid.get(pid) ?? []) {
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The real llama-server proof needs the sidecar to become a launchd orphan after SIGKILL of main. With supervision
// on (the shipped default) the helper kills it within about 2 s, so that proof asks for supervision off, which
// also emulates a legacy unsupervised orphan.
const REAL_LLAMA_SUPERVISION = 'off'

/**
 * The app's launch env. Only the real llama-server proof asks for the QA RAM-floor override (M2-0482): a 7 GiB hosted
 * runner otherwise sits under the bundled model's advertised-RAM floor. The app honours it only when packaged and on
 * this isolated profile; any inherited value is dropped so the stand-in launch never carries it.
 */
export function launchEnv(baseEnv, profile, { hostFloorOverride = false, extraEnv = {} } = {}) {
  const env = { ...baseEnv, ASKTOTO_USERDATA: profile, METIS_DISABLE_APPLE_FM: '1', ...extraEnv }
  for (const key of Object.keys(env)) if (/_API_KEY$/i.test(key)) delete env[key]
  delete env.METIS_QA_HOST_FLOOR_OVERRIDE
  if (hostFloorOverride) env.METIS_QA_HOST_FLOOR_OVERRIDE = '1'
  return env
}

function launch(executable, profile, port, options) {
  return spawn(executable, [`--remote-debugging-port=${port}`], { env: launchEnv(process.env, profile, options), stdio: 'ignore' })
}

/** Host memory as the runner reports it: hw.memsize (macOS), os.totalmem and os.freemem, in bytes. */
function hostMemoryFacts() {
  let hwMemsizeBytes = null
  if (process.platform === 'darwin') {
    try {
      const value = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim())
      hwMemsizeBytes = Number.isSafeInteger(value) ? value : null
    } catch {
      /* unreadable: reported as null */
    }
  }
  return { hwMemsizeBytes, totalmemBytes: totalmem(), freememBytes: freemem() }
}

/** The app's content-free local.host-floor-override records: floor and host figures only, never other fields. */
export function hostFloorOverrides(records) {
  return records
    .filter((record) => record.event === 'local.host-floor-override')
    .map(({ floor, hostTotalBytes, hostAvailableBytes }) => ({
      floor: floor === 'prewarm-available-ram' || floor === 'advertised-ram' ? floor : 'unknown',
      hostTotalBytes: Number.isFinite(hostTotalBytes) ? hostTotalBytes : null,
      hostAvailableBytes: Number.isFinite(hostAvailableBytes) ? hostAvailableBytes : null
    }))
}

function seedLocalLlmSettings(profile) {
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  writeFileSync(join(profile, 'settings.json'), JSON.stringify(LOCAL_LLM_SETTINGS, null, 2))
}

async function waitFor(predicate, timeoutMs, intervalMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await sleep(intervalMs)
  }
}

async function connectAndFindTotoPage(port) {
  return waitFor(async () => {
    let browser
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          try {
            if (await page.evaluate(() => typeof window.toto !== 'undefined')) return { browser, page }
          } catch {
            /* page navigated or is not the app page */
          }
        }
      }
      await browser.close()
    } catch {
      if (browser) await browser.close().catch(() => {})
    }
    return undefined
  }, READY_TIMEOUT_MS, 500)
}

async function waitForRendererReady(profile) {
  return waitFor(() => readAudit(profile).some((record) => record.event === 'app.renderer.ready'), READY_TIMEOUT_MS)
}

async function prewarmAndFindLlama(port, mainPid, bundle) {
  const found = await connectAndFindTotoPage(port)
  if (!found) throw new Precondition('renderer bridge was not reachable over CDP')
  try {
    await found.page.evaluate(() => window.toto.localPrewarm('M2-0027 sidecar boot reaper proof'))
  } finally {
    await found.browser.close().catch(() => {})
  }
  return waitFor(() => {
    const descendants = descendantsOf(psRows(), mainPid).filter((proc) => classify(proc.command, bundle) === 'llama-server')
    return descendants[0]
  }, LLAMA_TIMEOUT_MS, 500)
}

function killBestEffort(pid) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

function cleanOwned(child, installRoot) {
  try {
    const table = listProcesses(process.platform)
    const pid = child && child.exitCode === null && child.signalCode === null ? child.pid : null
    for (const proc of ownedProcesses(table, { mainPid: pid ?? null, installRoot, platform: process.platform })) {
      killBestEffort(proc.pid)
    }
  } catch {
    /* best effort */
  }
}

function resolveTarget(target) {
  if (process.platform === 'darwin') {
    const installRoot = realpathSync.native(target)
    return { installRoot, executable: join(installRoot, 'Contents', 'MacOS', basename(installRoot, '.app')) }
  }
  if (process.platform === 'win32') {
    const executable = realpathSync.native(target)
    return { installRoot: dirname(executable), executable }
  }
  throw new Precondition('sidecar boot reaper proof runs on macOS and Windows hosted runners only')
}

function initialObservation(kind) {
  return {
    kind,
    result: 'fail',
    failures: [],
    timingsMs: { firstReady: null, sidecarStarted: null, reaped: null },
    pids: { firstMain: null, sidecar: null, secondMain: null },
    events: {},
    reapedReason: null,
    processes: { beforeKill: null, afterReaper: null },
    unblock: null,
    hostFloorOverride: false,
    hostMemory: null,
    hostFloorOverrides: []
  }
}

function initialRealLlamaObservation() {
  const observation = initialObservation('real-llama-server')
  observation.supervision = REAL_LLAMA_SUPERVISION
  observation.timingsMs.llamaStarted = null
  observation.pids.orphan = null
  return observation
}

export function summarizeProof(report) {
  return {
    schema: 1,
    ticket: 'M2-0233',
    kind: report.kind,
    ...(report.supervision ? { supervision: report.supervision } : {}),
    result: report.result,
    failures: report.failures,
    unblock: report.unblock,
    timingsMs: report.timingsMs,
    pids: report.pids,
    reapedReason: report.reapedReason,
    events: report.events,
    processes: report.processes,
    // M2-0482: whether this launch asked for the QA RAM-floor override, the runner's memory, and the floors the
    // app reports it lifted.
    hostFloorOverride: report.hostFloorOverride === true,
    hostMemory: report.hostMemory ?? null,
    hostFloorOverrides: report.hostFloorOverrides ?? [],
    ...(report.negativeControl ? { negativeControl: report.negativeControl } : {})
  }
}

function failureLabel(error) {
  if (error instanceof Precondition || error instanceof Failure) return error.message
  return 'unexpected-error'
}

async function runStandInProof({ installRoot, executable }) {
  const profile = mkdtempSync(join(tmpdir(), 'metis-sidecar-reaper-'))
  let first = null
  let second = null
  let standIn = null
  const observation = initialObservation('stand-in-registry')

  try {
    const busy = ownedProcesses(listProcesses(process.platform), { mainPid: null, installRoot, platform: process.platform })
    if (busy.length > 0) throw new Precondition('install root already has resident processes')

    const firstPort = await freeLoopbackPort()
    const firstStartedAt = Date.now()
    first = launch(executable, profile, firstPort)
    observation.pids.firstMain = first.pid ?? null
    if (!first.pid) throw new Failure('first main pid was unavailable')
    if (!(await waitForRendererReady(profile))) throw new Failure('first launch did not reach renderer ready')
    observation.timingsMs.firstReady = Date.now() - firstStartedAt

    const sidecarStartedAt = Date.now()
    const standInArgs = ['-e', 'setInterval(() => {}, 1000)']
    standIn = spawn(process.execPath, standInArgs, { stdio: 'ignore' })
    const identity = await waitFor(() => {
      try {
        return standIn?.pid
          ? recordSpawnedStandIn(profile, 'stand-in', 'llama-server', standIn, process.execPath, standInArgs, installRoot)
          : null
      } catch {
        return null
      }
    }, 5_000, POLL_MS)
    if (!identity) throw new Failure('stand-in sidecar spawned identity registry did not land before hard kill')
    observation.pids.sidecar = standIn.pid
    observation.timingsMs.sidecarStarted = Date.now() - sidecarStartedAt
    observation.processes.beforeKill = roleCounts(
      ownedProcesses(listProcesses(process.platform), { mainPid: first.pid, installRoot, platform: process.platform })
    )

    killBestEffort(first.pid)
    await waitFor(() => !processAlive(first.pid), 10_000, POLL_MS)

    const secondPort = await freeLoopbackPort()
    second = launch(executable, profile, secondPort)
    observation.pids.secondMain = second.pid ?? null
    if (!second.pid) throw new Failure('second main pid was unavailable')

    const secondBoot = await waitFor(() => {
      const audit = readAudit(profile)
      const reason = observedReapedOrphan(audit, standIn.pid)
      if (reason) {
        observation.reapedReason = reason
        return { alreadyReaped: true }
      }
      if (hasAtLeastEvent(audit, 'app.started', 2)) return { alreadyReaped: false }
      return false
    }, READY_TIMEOUT_MS, POLL_MS)
    if (!secondBoot) throw new Failure('second launch did not record app.started before the boot timeout')

    const reaperStartedAt = Date.now()
    const reaped = secondBoot.alreadyReaped || await waitFor(() => {
      const reason = observedReapedOrphan(readAudit(profile), standIn.pid)
      if (!reason) return false
      observation.reapedReason = reason
      return true
    }, REAPER_BOUND_MS, POLL_MS)
    observation.timingsMs.reaped = reaped ? (secondBoot.alreadyReaped ? 0 : Date.now() - reaperStartedAt) : null
    observation.events = eventCounts(readAudit(profile))
    observation.processes.afterReaper = roleCounts(
      ownedProcesses(listProcesses(process.platform), { mainPid: second.pid, installRoot, platform: process.platform })
    )

    if (!reaped) {
      throw new Failure('stand-in sidecar was not reaped within 5 s of second boot')
    }
    observation.result = 'pass'
  } catch (error) {
    observation.result = error instanceof Precondition ? 'BLOCKED_EXTERNAL' : 'fail'
    observation.failures.push(failureLabel(error))
    if (error instanceof Precondition) observation.unblock = error.message
    observation.events = eventCounts(readAudit(profile))
  } finally {
    cleanOwned(first, installRoot)
    cleanOwned(second, installRoot)
    if (standIn && processAlive(standIn.pid)) killBestEffort(standIn.pid)
    await waitFor(() => !first?.pid || !processAlive(first.pid), 5_000, POLL_MS)
    await waitFor(() => !second?.pid || !processAlive(second.pid), 5_000, POLL_MS)
    await waitFor(() => !standIn?.pid || !processAlive(standIn.pid), 5_000, POLL_MS)
    rmSync(profile, { recursive: true, force: true })
  }
  return summarizeProof(observation)
}

async function runRealLlamaProof({ installRoot, executable }) {
  if (process.platform !== 'darwin') {
    return {
      ...summarizeProof({
        ...initialRealLlamaObservation(),
        result: 'BLOCKED_EXTERNAL',
        failures: ['real llama-server proof runs on macOS packaged smoke only'],
        unblock: REAL_LLAMA_UNBLOCK,
        hostMemory: hostMemoryFacts()
      })
    }
  }

  const profile = mkdtempSync(join(tmpdir(), 'metis-sidecar-reaper-real-'))
  seedLocalLlmSettings(profile)
  let first = null
  let second = null
  const observation = initialRealLlamaObservation()
  // M2-0482: both launches of this proof ask for the QA RAM-floor override; the report records it and the host.
  const launchOptions = { hostFloorOverride: true, extraEnv: { METIS_SUPERVISION: REAL_LLAMA_SUPERVISION } }
  observation.hostFloorOverride = true
  observation.hostMemory = hostMemoryFacts()

  try {
    const busy = ownedProcesses(listProcesses(process.platform), { mainPid: null, installRoot, platform: process.platform })
    if (busy.length > 0) throw new Precondition('install root already has resident processes')

    const firstPort = await freeLoopbackPort()
    const firstStartedAt = Date.now()
    first = launch(executable, profile, firstPort, launchOptions)
    observation.pids.firstMain = first.pid ?? null
    if (!first.pid) throw new Failure('first main pid was unavailable')
    if (!(await waitForRendererReady(profile))) throw new Failure('first launch did not reach renderer ready')
    observation.timingsMs.firstReady = Date.now() - firstStartedAt

    const llamaStartedAt = Date.now()
    const llama = await prewarmAndFindLlama(firstPort, first.pid, installRoot)
    if (!llama) throw new Precondition(REAL_LLAMA_UNBLOCK)
    const registered = await waitFor(() => registryHasSpawnedPid(readSidecarRegistry(profile), llama.pid), 5_000, POLL_MS)
    if (!registered) throw new Failure('llama-server spawned identity registry did not land before hard kill')
    observation.pids.sidecar = llama.pid
    observation.pids.orphan = llama.pid
    observation.timingsMs.sidecarStarted = Date.now() - llamaStartedAt
    observation.timingsMs.llamaStarted = observation.timingsMs.sidecarStarted
    observation.processes.beforeKill = roleCounts(
      ownedProcesses(listProcesses(process.platform), { mainPid: first.pid, installRoot, platform: process.platform })
    )

    killBestEffort(first.pid)
    await waitFor(() => !processAlive(first.pid), 10_000, POLL_MS)
    const orphaned = await waitFor(() => psRows().some((proc) => proc.pid === llama.pid && proc.ppid === 1), 5_000, POLL_MS)
    if (!orphaned) throw new Failure('llama-server did not become a launchd orphan after SIGKILL')

    const secondPort = await freeLoopbackPort()
    second = launch(executable, profile, secondPort, launchOptions)
    observation.pids.secondMain = second.pid ?? null
    if (!second.pid) throw new Failure('second main pid was unavailable')

    const secondBoot = await waitFor(() => {
      const audit = readAudit(profile)
      const reason = observedReapedOrphan(audit, llama.pid)
      if (reason) {
        observation.reapedReason = reason
        return { alreadyReaped: true }
      }
      if (hasAtLeastEvent(audit, 'app.started', 2)) return { alreadyReaped: false }
      return false
    }, READY_TIMEOUT_MS, POLL_MS)
    if (!secondBoot) throw new Failure('second launch did not record app.started before the boot timeout')

    const reaperStartedAt = Date.now()
    const reaped = secondBoot.alreadyReaped || await waitFor(() => {
      const reason = observedReapedOrphan(readAudit(profile), llama.pid)
      if (!reason) return false
      observation.reapedReason = reason
      return true
    }, REAPER_BOUND_MS, POLL_MS)
    observation.timingsMs.reaped = reaped ? (secondBoot.alreadyReaped ? 0 : Date.now() - reaperStartedAt) : null
    observation.events = eventCounts(readAudit(profile))
    observation.processes.afterReaper = roleCounts(
      ownedProcesses(listProcesses(process.platform), { mainPid: second.pid, installRoot, platform: process.platform })
    )

    if (!reaped) throw new Failure('llama-server orphan was not reaped within 5 s of second boot')
    observation.result = 'pass'
  } catch (error) {
    observation.result = error instanceof Precondition ? 'BLOCKED_EXTERNAL' : 'fail'
    observation.failures.push(failureLabel(error))
    if (error instanceof Precondition) observation.unblock = REAL_LLAMA_UNBLOCK
    observation.events = eventCounts(readAudit(profile))
  } finally {
    cleanOwned(first, installRoot)
    cleanOwned(second, installRoot)
    await waitFor(() => !first?.pid || !processAlive(first.pid), 5_000, POLL_MS)
    await waitFor(() => !second?.pid || !processAlive(second.pid), 5_000, POLL_MS)
    observation.hostFloorOverrides = hostFloorOverrides(readAudit(profile))
    rmSync(profile, { recursive: true, force: true })
  }
  return summarizeProof(observation)
}

function initialLegacyOrphanObservation() {
  const observation = initialObservation('legacy-orphan')
  observation.timingsMs = { modelSeeded: null, orphansHealthy: null, appStarted: null, reaped: null }
  observation.pids = { orphan: null, control: null, main: null }
  observation.negativeControl = { alive: null, reaped: null }
  return observation
}

/** Copies every pinned local-model file from the bundle into `dir`, each copy verified against the manifest. */
async function seedPinnedModel(bundledDir, dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const asset of LOCAL_MODEL_ASSETS) {
    const source = join(bundledDir, asset.file)
    if (!existsSync(source)) throw new Precondition(LEGACY_ORPHAN_UNBLOCK)
    const copy = join(dir, asset.file)
    copyFileSync(source, copy)
    if ((await sha256File(copy)) !== asset.sha256) throw new Failure('seeded model copy does not match the local-model manifest')
  }
}

/**
 * Starts `executable` through a shell that exits at once, so the process is reparented to launchd (ppid 1)
 * exactly like a llama-server whose Métis main died. Returns its pid.
 */
function spawnLaunchdOrphan(executable, args) {
  const stdout = execFileSync('/bin/sh', ['-c', '"$0" "$@" </dev/null >/dev/null 2>&1 & echo $!', executable, ...args], {
    encoding: 'utf8',
    timeout: 5_000
  })
  const pid = Number(stdout.trim())
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Failure('harness llama-server pid was unavailable')
  return pid
}

function harnessLlamaArgs(model, port) {
  return ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-c', '512', '-ngl', '0']
}

async function llamaHealthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

async function runLegacyOrphanProof({ installRoot, executable }) {
  if (process.platform !== 'darwin') {
    return summarizeProof({
      ...initialLegacyOrphanObservation(),
      result: 'BLOCKED_EXTERNAL',
      failures: ['legacy-orphan proof runs on macOS only'],
      unblock: LEGACY_ORPHAN_OFF_MAC_UNBLOCK
    })
  }

  // Realpath so the -m argument and ASKTOTO_USERDATA name the profile with the same string.
  const profile = realpathSync.native(mkdtempSync(join(tmpdir(), 'metis-sidecar-reaper-legacy-')))
  const observation = initialLegacyOrphanObservation()
  let app = null
  let orphanPid = null
  let controlPid = null

  try {
    const busy = ownedProcesses(listProcesses(process.platform), { mainPid: null, installRoot, platform: process.platform })
    if (busy.length > 0) throw new Precondition('install root already has resident processes')

    const llamaServer = join(installRoot, 'Contents', 'Resources', 'llama', 'mac', process.arch, 'llama-server')
    const bundledModelDir = join(installRoot, 'Contents', 'Resources', 'local-llm', 'models', LOCAL_MODEL_ID)
    const seededModelDir = join(profile, 'local-llm', 'models', LOCAL_MODEL_ID)
    if (!existsSync(llamaServer)) throw new Precondition(LEGACY_ORPHAN_UNBLOCK)
    // The product reads orphan argv from the ps command column, split on whitespace.
    if (/\s/.test(`${llamaServer}${bundledModelDir}${seededModelDir}`)) {
      throw new Precondition('install and profile paths must not contain whitespace')
    }

    const seedStartedAt = Date.now()
    await seedPinnedModel(bundledModelDir, seededModelDir)
    observation.timingsMs.modelSeeded = Date.now() - seedStartedAt

    const orphanPort = await freeLoopbackPort()
    const controlPort = await freeLoopbackPort()
    const orphansStartedAt = Date.now()
    orphanPid = spawnLaunchdOrphan(llamaServer, harnessLlamaArgs(join(seededModelDir, 'model.gguf'), orphanPort))
    observation.pids.orphan = orphanPid
    controlPid = spawnLaunchdOrphan(llamaServer, harnessLlamaArgs(join(bundledModelDir, 'model.gguf'), controlPort))
    observation.pids.control = controlPid

    const orphaned = await waitFor(() => {
      const rows = psRows()
      return [orphanPid, controlPid].every((pid) => rows.some((proc) => proc.pid === pid && proc.ppid === 1))
    }, 5_000, POLL_MS)
    if (!orphaned) throw new Failure('harness llama-server processes did not become launchd orphans')
    const healthy = await waitFor(async () => (await llamaHealthy(orphanPort)) && (await llamaHealthy(controlPort)), LLAMA_TIMEOUT_MS, 500)
    if (!healthy) throw new Failure('harness llama-server processes did not become healthy')
    observation.timingsMs.orphansHealthy = Date.now() - orphansStartedAt
    await sleep(START_ORDER_GAP_MS)

    const port = await freeLoopbackPort()
    const appStartedAt = Date.now()
    app = launch(executable, profile, port)
    observation.pids.main = app.pid ?? null
    if (!app.pid) throw new Failure('main pid was unavailable')

    const boot = await waitFor(() => {
      const audit = readAudit(profile)
      if (observedLegacyReap(audit, orphanPid)) return { alreadyReaped: true }
      if (hasAtLeastEvent(audit, 'app.started', 1)) return { alreadyReaped: false }
      return false
    }, READY_TIMEOUT_MS, POLL_MS)
    if (!boot) throw new Failure('launch did not record app.started before the boot timeout')
    observation.timingsMs.appStarted = Date.now() - appStartedAt

    const reaperStartedAt = Date.now()
    const reaped = boot.alreadyReaped || await waitFor(() => observedLegacyReap(readAudit(profile), orphanPid), REAPER_BOUND_MS, POLL_MS)
    const reapedMs = reaped ? (boot.alreadyReaped ? 0 : Date.now() - reaperStartedAt) : null
    await sleep(REAPER_PASS_SETTLE_MS)

    const audit = readAudit(profile)
    const verdict = legacyOrphanVerdict({
      records: audit,
      orphanPid,
      controlPid,
      reapedMs,
      orphanAlive: processAlive(orphanPid),
      controlAlive: processAlive(controlPid)
    })
    observation.timingsMs.reaped = reapedMs
    observation.reapedReason = observedLegacyReap(audit, orphanPid) ? 'legacy-orphan' : null
    observation.negativeControl = {
      alive: processAlive(controlPid),
      reaped: audit.some((entry) => entry.event === 'sidecar.reaped' && entry.pid === controlPid)
    }
    observation.events = eventCounts(audit)
    observation.processes.afterReaper = roleCounts(
      ownedProcesses(listProcesses(process.platform), { mainPid: app.pid, installRoot, platform: process.platform })
    )
    observation.result = verdict.result
    observation.failures.push(...verdict.failures)
  } catch (error) {
    observation.result = error instanceof Precondition ? 'BLOCKED_EXTERNAL' : 'fail'
    observation.failures.push(failureLabel(error))
    if (error instanceof Precondition) observation.unblock = error.message
    observation.events = eventCounts(readAudit(profile))
  } finally {
    cleanOwned(app, installRoot)
    for (const pid of [orphanPid, controlPid]) if (pid && processAlive(pid)) killBestEffort(pid)
    await waitFor(() => !app?.pid || !processAlive(app.pid), 5_000, POLL_MS)
    await waitFor(() => [orphanPid, controlPid].every((pid) => !pid || !processAlive(pid)), 5_000, POLL_MS)
    rmSync(profile, { recursive: true, force: true })
  }
  return summarizeProof(observation)
}

export function combinedReport(standIn, realLlama, legacyOrphan) {
  const proofs = [standIn, realLlama, ...(legacyOrphan ? [legacyOrphan] : [])]
  const failed = proofs.filter((proof) => proof.result === 'fail')
  return {
    schema: 3,
    ticket: 'M2-0233',
    result: failed.length === 0 && standIn.result === 'pass' ? 'pass' : 'fail',
    proofs: { standIn, realLlama, ...(legacyOrphan ? { legacyOrphan } : {}) },
    externalBlockers: proofs
      .filter((proof) => proof.result === 'BLOCKED_EXTERNAL')
      .map((proof) => ({ kind: proof.kind, unblock: proof.unblock }))
  }
}

/** 0 PASS · 1 FAIL · 2 PRECONDITION: only --require-real-llama turns a BLOCKED_EXTERNAL real-llama row into 2. */
export function exitCodeFor(report, { requireRealLlama = false } = {}) {
  if (report.result !== 'pass') return 1
  if (requireRealLlama && report.proofs.realLlama.result === 'BLOCKED_EXTERNAL') return 2
  return 0
}

export function parseCliArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('--'))
  const flags = argv.filter((arg) => arg.startsWith('--'))
  const unknown = flags.filter((flag) => flag !== REQUIRE_REAL_LLAMA_FLAG)
  if (positional.length !== 2 || unknown.length > 0) {
    throw new Precondition(`usage: node scripts/qa/sidecar-boot-reaper.mjs <installed app> <report.json> [${REQUIRE_REAL_LLAMA_FLAG}]`)
  }
  return { target: positional[0], reportPath: positional[1], requireRealLlama: flags.includes(REQUIRE_REAL_LLAMA_FLAG) }
}

function emitExternalBlockerWarnings(report) {
  for (const blocker of report.externalBlockers) {
    const message = `sidecar boot reaper ${blocker.kind} BLOCKED_EXTERNAL: ${blocker.unblock}`
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Sidecar boot reaper blocked::${message}`)
    else console.warn(message)
  }
  if (process.env.GITHUB_STEP_SUMMARY && report.externalBlockers.length > 0) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '### Sidecar boot reaper external blockers',
        '',
        ...report.externalBlockers.map((blocker) => `- ${blocker.kind}: ${blocker.unblock}`),
        ''
      ].join('\n')
    )
  }
}

async function main() {
  const { target, reportPath, requireRealLlama } = parseCliArgs(process.argv.slice(2))

  const targetInfo = resolveTarget(target)
  const standIn = await runStandInProof(targetInfo)
  const realLlama = await runRealLlamaProof(targetInfo)
  const legacyOrphan = await runLegacyOrphanProof(targetInfo)
  const report = combinedReport(standIn, realLlama, legacyOrphan)
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  emitExternalBlockerWarnings(report)
  const code = exitCodeFor(report, { requireRealLlama })
  if (code === 2) console.error(`[sidecar-boot-reaper] real llama-server proof is BLOCKED_EXTERNAL under ${REQUIRE_REAL_LLAMA_FLAG}: ${realLlama.unblock}`)
  process.exit(code)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(`[sidecar-boot-reaper] ${failureLabel(error)}`)
    process.exit(error instanceof Precondition ? 2 : 1)
  }
}
