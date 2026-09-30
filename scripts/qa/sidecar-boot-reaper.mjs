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
 * Usage:
 *   node scripts/qa/sidecar-boot-reaper.mjs <installed app> <report.json>
 *
 * Exit 0 PASS or PASS-with-BLOCKED_EXTERNAL · 1 FAIL · 2 usage/precondition. The report is
 * content-free: pids, counts, timings and audit event counts only; no paths, command lines, profile
 * locations or user content.
 */

import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { appendFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { freemem, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { listProcesses, ownedProcesses, roleCounts } from './owned-processes.mjs'

const READY_TIMEOUT_MS = 150_000
const LLAMA_TIMEOUT_MS = 120_000
const REAPER_BOUND_MS = 5_000
const POLL_MS = 250
const REAL_LLAMA_UNBLOCK = 'Seed the packaged local model assets.'

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
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify(
      {
        localLlm: {
          enabled: true,
          modelId: 'qwen3.5-0.8b',
          useFor: { suggest: true, summary: false, vision: false },
          fallback: true
        }
      },
      null,
      2
    )
  )
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
    hostFloorOverrides: report.hostFloorOverrides ?? []
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

export function combinedReport(standIn, realLlama) {
  const failed = [standIn, realLlama].filter((proof) => proof.result === 'fail')
  return {
    schema: 2,
    ticket: 'M2-0233',
    result: failed.length === 0 && standIn.result === 'pass' ? 'pass' : 'fail',
    proofs: { standIn, realLlama },
    externalBlockers: [standIn, realLlama]
      .filter((proof) => proof.result === 'BLOCKED_EXTERNAL')
      .map((proof) => ({ kind: proof.kind, unblock: proof.unblock }))
  }
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
  const [target, reportPath] = process.argv.slice(2)
  if (!target || !reportPath) throw new Precondition('usage: node scripts/qa/sidecar-boot-reaper.mjs <installed app> <report.json>')

  const targetInfo = resolveTarget(target)
  const standIn = await runStandInProof(targetInfo)
  const realLlama = await runRealLlamaProof(targetInfo)
  const report = combinedReport(standIn, realLlama)
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  emitExternalBlockerWarnings(report)
  process.exit(report.result === 'pass' ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(`[sidecar-boot-reaper] ${failureLabel(error)}`)
    process.exit(error instanceof Precondition ? 2 : 1)
  }
}
