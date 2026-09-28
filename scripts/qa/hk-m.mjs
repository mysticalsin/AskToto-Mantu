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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listProcesses, ownedProcesses, roleCounts, survivors as computeSurvivors } from './owned-processes.mjs'

const READY_TIMEOUT_MS = 150_000
const SURVIVOR_BOUND_MS = 5_000
const POLL_MS = 250
const SCENARIOS = Object.freeze(['idle', 'model-starting', 'active-inference', 'ffmpeg-import', 'registry-write'])
const LOCAL_MODEL_ROLES = Object.freeze(['llama-server', 'fm'])
const LOCAL_MODEL_AUDIT_NAMES = Object.freeze(['llama-server', 'fm-serve'])

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

function readRegistry(profile) {
  try {
    const runDir = join(profile, 'run')
    return readdirSync(runDir)
      .filter((name) => /^sidecars-[a-f0-9-]+\.json$/i.test(name))
      .flatMap((name) => parseAuditLog(readFileSync(join(runDir, name), 'utf8')))
  } catch {
    return []
  }
}

function hasEvent(records, event) {
  return records.some((record) => record.event === event)
}

function countEvent(records, event, predicate = () => true) {
  return records.filter((record) => record.event === event && predicate(record)).length
}

function hasRole(entries, roles) {
  return entries.some((entry) => roles.includes(entry.role))
}

function summarizeEvidence(records, registry, sidecars) {
  return {
    audit: {
      sidecarSpawn: countEvent(records, 'sidecar.spawn'),
      localRuntimeStart: countEvent(records, 'local.runtime.start'),
      hkActiveInference: countEvent(records, 'hk-m.active-inference'),
      hkFfmpegImport: countEvent(records, 'hk-m.ffmpeg-import'),
      hkRegistryWrite: countEvent(records, 'hk-m.registry-write')
    },
    registry: {
      intent: registry.filter((record) => record.kind === 'intent').length,
      spawned: registry.filter((record) => record.kind === 'spawned').length
    },
    roles: roleCounts(sidecars)
  }
}

export function scenarioEvidence(scenario, { records, registry, sidecars }) {
  const evidence = summarizeEvidence(records, registry, sidecars)
  const modelRole = hasRole(sidecars, LOCAL_MODEL_ROLES)
  const modelStartAudit =
    countEvent(records, 'local.runtime.start') > 0 ||
    countEvent(records, 'sidecar.spawn', (record) => LOCAL_MODEL_AUDIT_NAMES.includes(record.name)) > 0

  if (scenario === 'idle') return { ok: true, evidence }
  if (scenario === 'model-starting') {
    if (!modelStartAudit) {
      return {
        ok: false,
        status: 'BLOCKED_EXTERNAL',
        failure: 'scenario_not_triggered',
        unblock: 'Expose the packaged HK-M model-starting trigger so this row starts a local model sidecar.',
        evidence
      }
    }
    if (!modelRole) return { ok: false, status: 'FAIL', failure: 'expected_model_sidecar_absent', evidence }
    return { ok: true, evidence }
  }
  if (scenario === 'active-inference') {
    if (countEvent(records, 'hk-m.active-inference') === 0) {
      return {
        ok: false,
        status: 'BLOCKED_EXTERNAL',
        failure: 'scenario_not_triggered',
        unblock: 'Expose the packaged HK-M active-inference trigger and content-free audit marker.',
        evidence
      }
    }
    if (!modelRole) return { ok: false, status: 'FAIL', failure: 'expected_model_sidecar_absent', evidence }
    return { ok: true, evidence }
  }
  if (scenario === 'ffmpeg-import') {
    if (countEvent(records, 'hk-m.ffmpeg-import') === 0) {
      return {
        ok: false,
        status: 'BLOCKED_EXTERNAL',
        failure: 'scenario_not_triggered',
        unblock: 'Expose the packaged HK-M ffmpeg-import trigger and content-free audit marker.',
        evidence
      }
    }
    if (!hasRole(sidecars, ['ffmpeg'])) return { ok: false, status: 'FAIL', failure: 'expected_ffmpeg_sidecar_absent', evidence }
    return { ok: true, evidence }
  }
  if (scenario === 'registry-write') {
    if (countEvent(records, 'hk-m.registry-write') === 0) {
      return {
        ok: false,
        status: 'BLOCKED_EXTERNAL',
        failure: 'scenario_not_triggered',
        unblock: 'Expose the packaged HK-M registry-write trigger and content-free audit marker.',
        evidence
      }
    }
    if (evidence.registry.intent + evidence.registry.spawned === 0) {
      return { ok: false, status: 'FAIL', failure: 'expected_registry_evidence_absent', evidence }
    }
    return { ok: true, evidence }
  }
  return { ok: false, status: 'FAIL', failure: 'unknown_scenario', evidence }
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

    const recordsAtKill = readAudit(profile)
    const registryAtKill = readRegistry(profile)
    const ownedAtKill = ownedProcesses(listProcesses('darwin'), { mainPid: child.pid, installRoot, platform: 'darwin' })
    if (!ownedAtKill.some((entry) => entry.pid === child.pid)) {
      hardKill(child.pid)
      return terminalRow(scenario, cycle, 'FAIL', { failure: 'main_not_owned' })
    }

    const sidecarsAtKill = ownedAtKill.filter((entry) => entry.pid !== child.pid)
    const scenarioProof = scenarioEvidence(scenario, {
      records: recordsAtKill,
      registry: registryAtKill,
      sidecars: sidecarsAtKill
    })
    if (!scenarioProof.ok) {
      hardKill(child.pid)
      return terminalRow(scenario, cycle, scenarioProof.status, {
        failure: scenarioProof.failure,
        evidence: scenarioProof.evidence,
        ...(scenarioProof.unblock ? { unblock: scenarioProof.unblock } : {})
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
          processes: { atKill: roleCounts(ownedAtKill), survivors: {} },
          evidence: scenarioProof.evidence
        })
      }
      await sleep(POLL_MS)
    }
    return terminalRow(scenario, cycle, 'FAIL', {
      failure: 'owned_processes_survived',
      processes: { atKill: roleCounts(ownedAtKill), survivors: roleCounts(survivors) },
      evidence: scenarioProof.evidence
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[hk-m] ${error?.message ?? error}`)
    process.exit(2)
  })
}
