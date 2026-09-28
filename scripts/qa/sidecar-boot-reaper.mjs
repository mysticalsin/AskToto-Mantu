#!/usr/bin/env node
/**
 * Packaged proof for M2-0027. Runs only on hosted macOS QA lanes, against an installed packaged app and
 * a fresh ASKTOTO_USERDATA profile. The proof starts the real llama-server through the product bridge,
 * kills only the main process with SIGKILL, relaunches, and requires the old orphaned llama-server pid to
 * disappear within 5 s of boot with a sidecar.reaped legacy-orphan audit.
 *
 * Usage:
 *   node scripts/qa/sidecar-boot-reaper.mjs <installed app> <report.json>
 *
 * Exit 0 PASS · 1 FAIL · 2 PRECONDITION. The report is content-free: pids, counts, timings and audit
 * event counts only; no paths, command lines, profile locations or user content.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { listProcesses, ownedProcesses, roleCounts } from './owned-processes.mjs'

const READY_TIMEOUT_MS = 150_000
const LLAMA_TIMEOUT_MS = 120_000
const REAPER_BOUND_MS = 5_000
const POLL_MS = 250

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

function eventCounts(records) {
  const counts = {}
  for (const event of ['app.started', 'app.renderer.ready', 'sidecar.spawn', 'sidecar.reaped', 'sidecar.reap.skipped']) {
    counts[event] = records.filter((record) => record.event === event).length
  }
  return counts
}

function hasLegacyReap(records, pid) {
  return records.some((record) => record.event === 'sidecar.reaped' && record.reason === 'legacy-orphan' && record.pid === pid)
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

function launch(executable, profile, port) {
  const env = { ...process.env, ASKTOTO_USERDATA: profile }
  for (const key of Object.keys(env)) if (/_API_KEY$/i.test(key)) delete env[key]
  return spawn(executable, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
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

function summarize(report) {
  return {
    schema: 1,
    ticket: 'M2-0027',
    result: report.result,
    failures: report.failures,
    timingsMs: report.timingsMs,
    pids: report.pids,
    events: report.events,
    processes: report.processes
  }
}

function failureLabel(error) {
  if (error instanceof Precondition || error instanceof Failure) return error.message
  return 'unexpected-error'
}

async function main() {
  if (process.platform !== 'darwin') throw new Precondition('sidecar boot reaper proof runs on macOS only')
  const [target, reportPath] = process.argv.slice(2)
  if (!target || !reportPath) throw new Precondition('usage: node scripts/qa/sidecar-boot-reaper.mjs <installed app> <report.json>')

  const installRoot = realpathSync.native(target)
  const executable = join(installRoot, 'Contents', 'MacOS', basename(installRoot, '.app'))
  const profile = mkdtempSync(join(tmpdir(), 'metis-sidecar-reaper-'))
  let first = null
  let second = null
  const observation = {
    result: 'fail',
    failures: [],
    timingsMs: { firstReady: null, llamaStarted: null, reaped: null },
    pids: { firstMain: null, orphan: null, secondMain: null },
    events: {},
    processes: { beforeKill: null, afterReaper: null }
  }

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

    const llamaStartedAt = Date.now()
    const llama = await prewarmAndFindLlama(firstPort, first.pid, installRoot)
    if (!llama) throw new Precondition('real llama-server did not start; seed the packaged local model assets')
    observation.pids.orphan = llama.pid
    observation.timingsMs.llamaStarted = Date.now() - llamaStartedAt
    observation.processes.beforeKill = roleCounts(
      ownedProcesses(listProcesses(process.platform), { mainPid: first.pid, installRoot, platform: process.platform })
    )

    killBestEffort(first.pid)
    await waitFor(() => !processAlive(first.pid), 10_000, POLL_MS)
    const orphaned = await waitFor(() => psRows().some((proc) => proc.pid === llama.pid && proc.ppid === 1), 5_000, POLL_MS)
    if (!orphaned) throw new Failure('llama-server did not become a launchd orphan after SIGKILL')

    const secondPort = await freeLoopbackPort()
    const reaperStartedAt = Date.now()
    second = launch(executable, profile, secondPort)
    observation.pids.secondMain = second.pid ?? null
    if (!second.pid) throw new Failure('second main pid was unavailable')

    const reaped = await waitFor(() => {
      const audit = readAudit(profile)
      return !processAlive(llama.pid) && hasLegacyReap(audit, llama.pid)
    }, REAPER_BOUND_MS, POLL_MS)
    observation.timingsMs.reaped = reaped ? Date.now() - reaperStartedAt : null
    observation.events = eventCounts(readAudit(profile))
    observation.processes.afterReaper = roleCounts(
      ownedProcesses(listProcesses(process.platform), { mainPid: second.pid, installRoot, platform: process.platform })
    )

    if (!reaped) throw new Failure('legacy orphan was not reaped within 5 s of relaunch')
    observation.result = 'pass'
  } catch (error) {
    observation.result = error instanceof Precondition ? 'BLOCKED_EXTERNAL' : 'fail'
    observation.failures.push(failureLabel(error))
    observation.events = eventCounts(readAudit(profile))
  } finally {
    cleanOwned(first, installRoot)
    cleanOwned(second, installRoot)
    rmSync(profile, { recursive: true, force: true })
    const report = summarize(observation)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.result === 'pass' ? 0 : report.result === 'BLOCKED_EXTERNAL' ? 2 : 1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(`[sidecar-boot-reaper] ${failureLabel(error)}`)
    process.exit(error instanceof Precondition ? 2 : 1)
  }
}
