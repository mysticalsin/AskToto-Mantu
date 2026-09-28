#!/usr/bin/env node
/**
 * HK-M packaged sidecar supervision proof. Runs only against an installed macOS app on hosted QA.
 *
 * Usage:
 *   node scripts/qa/hk-m.mjs <Metis.app> <report.json> [--cycles 20]
 *
 * The report is content-free: no paths, command lines, profile locations, transcripts, or secrets.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { listProcesses, ownedProcesses, roleCounts, survivors as computeSurvivors } from './owned-processes.mjs'

const READY_TIMEOUT_MS = 150_000
const SURVIVOR_BOUND_MS = 5_000
const POLL_MS = 250
const SCENARIOS = Object.freeze(['idle', 'model-starting', 'active-inference', 'ffmpeg-import', 'registry-write'])

function usage() {
  console.error('usage: node scripts/qa/hk-m.mjs <Metis.app> <report.json> [--cycles 20]')
  process.exit(2)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(argv) {
  if (argv.length < 2) usage()
  const cyclesIndex = argv.indexOf('--cycles')
  const cycles = cyclesIndex === -1 ? 20 : Number(argv[cyclesIndex + 1])
  if (!Number.isInteger(cycles) || cycles < 1) usage()
  return { appPath: argv[0], reportPath: argv[1], cycles }
}

function parseAuditLog(text) {
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      /* ignore partial audit lines */
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

function hasEvent(records, event) {
  return records.some((record) => record.event === event)
}

function macExecutable(appPath) {
  if (!appPath.endsWith('.app')) throw new Error('HK-M requires a macOS .app bundle')
  const executable = join(appPath, 'Contents', 'MacOS', basename(appPath, '.app'))
  if (!existsSync(executable)) throw new Error('app executable missing')
  return realpathSync.native(executable)
}

function hardKill(pid) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* Polling below decides whether the process is gone. */
  }
}

function terminalRow(scenario, cycle, status, detail = {}) {
  return { scenario, cycle, status, ...detail }
}

async function runCycle({ executable, installRoot, scenario, cycle }) {
  const rootResidents = ownedProcesses(listProcesses('darwin'), { mainPid: null, installRoot, platform: 'darwin' })
  if (rootResidents.length > 0) {
    return terminalRow(scenario, cycle, 'FAIL', { failure: 'install_root_busy', before: roleCounts(rootResidents) })
  }

  const profile = mkdtempSync(join(tmpdir(), 'metis-hk-m-'))
  const env = {
    ...process.env,
    ASKTOTO_USERDATA: profile,
    METIS_SIDECAR_SUPERVISION: '1',
    METIS_HK_M_SCENARIO: scenario
  }
  for (const key of Object.keys(env)) if (/_API_KEY$/i.test(key)) delete env[key]

  const child = spawn(executable, [], { env, stdio: 'ignore' })
  const exitInfo = { settled: false, code: null, signal: null }
  child.once('exit', (code, signal) => {
    exitInfo.settled = true
    exitInfo.code = code
    exitInfo.signal = signal
  })
  child.once('error', () => {
    exitInfo.settled = true
    exitInfo.code = null
    exitInfo.signal = 'spawn-error'
  })

  try {
    const readyDeadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < readyDeadline) {
      if (exitInfo.settled) {
        return terminalRow(scenario, cycle, 'FAIL', { failure: 'exited_before_ready', exit: exitInfo })
      }
      if (hasEvent(readAudit(profile), 'app.renderer.ready')) break
      await sleep(POLL_MS)
    }
    if (!hasEvent(readAudit(profile), 'app.renderer.ready')) {
      hardKill(child.pid)
      return terminalRow(scenario, cycle, 'FAIL', { failure: 'renderer_not_ready' })
    }

    const ownedAtKill = ownedProcesses(listProcesses('darwin'), { mainPid: child.pid, installRoot, platform: 'darwin' })
    if (!ownedAtKill.some((entry) => entry.pid === child.pid)) {
      hardKill(child.pid)
      return terminalRow(scenario, cycle, 'FAIL', { failure: 'main_not_owned' })
    }

    const sidecarsAtKill = ownedAtKill.filter((entry) => entry.pid !== child.pid)
    if (scenario !== 'idle' && sidecarsAtKill.length === 0) {
      hardKill(child.pid)
      return terminalRow(scenario, cycle, 'BLOCKED_EXTERNAL', {
        unblock: `Expose or seed the packaged QA trigger for ${scenario} so this row starts the intended owned sidecar.`
      })
    }

    const killedAt = Date.now()
    hardKill(child.pid)
    let survivors = []
    while (Date.now() - killedAt <= SURVIVOR_BOUND_MS) {
      survivors = computeSurvivors(ownedAtKill, listProcesses('darwin'), { installRoot, platform: 'darwin' })
      if (survivors.length === 0) {
        return terminalRow(scenario, cycle, 'PASS', {
          timingsMs: { survivorsGone: Date.now() - killedAt },
          processes: { atKill: roleCounts(ownedAtKill), survivors: {} }
        })
      }
      await sleep(POLL_MS)
    }
    return terminalRow(scenario, cycle, 'FAIL', {
      failure: 'owned_processes_survived',
      processes: { atKill: roleCounts(ownedAtKill), survivors: roleCounts(survivors) }
    })
  } finally {
    if (child.pid && !exitInfo.settled) hardKill(child.pid)
    rmSync(profile, { recursive: true, force: true })
  }
}

async function main() {
  const { appPath, reportPath, cycles } = parseArgs(process.argv.slice(2))
  mkdirSync(dirname(reportPath), { recursive: true })
  const report = {
    schema: 1,
    ticket: 'M2-0028',
    platform: process.platform,
    cycles,
    scenarios: SCENARIOS,
    result: 'fail',
    rows: []
  }

  if (process.platform !== 'darwin') {
    report.result = 'blocked'
    report.rows.push(
      terminalRow('all', 0, 'BLOCKED_EXTERNAL', { unblock: 'Run HK-M on the macos-latest packaged-smoke workflow.' })
    )
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    return
  }

  const installRoot = realpathSync.native(appPath)
  const executable = macExecutable(installRoot)
  for (let cycle = 1; cycle <= cycles; cycle++) {
    for (const scenario of SCENARIOS) {
      report.rows.push(await runCycle({ executable, installRoot, scenario, cycle }))
    }
  }

  const failures = report.rows.filter((row) => row.status === 'FAIL')
  const blocked = report.rows.filter((row) => row.status === 'BLOCKED_EXTERNAL')
  report.result = failures.length > 0 ? 'fail' : blocked.length > 0 ? 'blocked' : 'pass'
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (failures.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error(`[hk-m] ${error?.message ?? error}`)
  process.exit(2)
})
