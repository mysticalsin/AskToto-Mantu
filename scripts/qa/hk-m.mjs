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
  chmodSync,
  copyFileSync,
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
const UNRELATED_SAME_NAME_ROLE = 'llama-server'

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

function processIdentity(entry) {
  return `${entry.pid}:${entry.startedMs}`
}

function findProcess(table, identity) {
  return table.find((entry) => processIdentity(entry) === identity) ?? null
}

function terminalRow(scenario, cycle, status, detail = {}) {
  return { scenario, cycle, status, ...detail }
}

export function reportResultForRows(rows) {
  if (rows.some((row) => row.status === 'FAIL')) return 'fail'
  if (rows.some((row) => row.status === 'BLOCKED_EXTERNAL')) return 'blocked'
  return 'pass'
}

export function exitCodeForReportResult(result) {
  return result === 'pass' ? 0 : 1
}

function stopUnrelatedFixture(fixture) {
  if (!fixture?.proc?.pid) return
  hardKill(fixture.proc.pid)
  try {
    fixture.proc.unref()
  } catch {
    /* The process may already have exited. */
  }
}

async function startUnrelatedSameNameFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'metis-hk-m-unrelated-'))
  const executable = join(dir, UNRELATED_SAME_NAME_ROLE)
  let proc = null
  try {
    copyFileSync('/bin/sleep', executable)
    chmodSync(executable, 0o755)
    proc = spawn(executable, ['60'], { stdio: 'ignore' })
    let spawnError = null
    let exited = false
    proc.once('error', (error) => {
      spawnError = error
    })
    proc.once('exit', () => {
      exited = true
    })
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (spawnError) {
        stopUnrelatedFixture({ proc })
        rmSync(dir, { recursive: true, force: true })
        return {
          ok: false,
          failure: 'unrelated_same_name_fixture_unavailable',
          error: spawnError instanceof Error ? spawnError.message : String(spawnError)
        }
      }
      if (exited) {
        stopUnrelatedFixture({ proc })
        rmSync(dir, { recursive: true, force: true })
        return { ok: false, failure: 'unrelated_same_name_fixture_exited_early' }
      }
      const table = listProcesses('darwin')
      const entry = table.find((candidate) => candidate.pid === proc.pid) ?? null
      if (entry) {
        if (entry.role !== UNRELATED_SAME_NAME_ROLE) {
          stopUnrelatedFixture({ proc })
          rmSync(dir, { recursive: true, force: true })
          return {
            ok: false,
            failure: 'unrelated_same_name_fixture_role_mismatch',
            expectedRole: UNRELATED_SAME_NAME_ROLE,
            actualRole: entry.role
          }
        }
        return { ok: true, proc, dir, identity: processIdentity(entry), role: entry.role }
      }
      await sleep(POLL_MS)
    }
    stopUnrelatedFixture({ proc })
    rmSync(dir, { recursive: true, force: true })
    return { ok: false, failure: 'unrelated_same_name_fixture_not_observed' }
  } catch (error) {
    if (proc) stopUnrelatedFixture({ proc })
    rmSync(dir, { recursive: true, force: true })
    return {
      ok: false,
      failure: 'unrelated_same_name_fixture_unavailable',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function runCycle({ executable, installRoot, scenario, cycle }) {
  const rootResidents = ownedProcesses(listProcesses('darwin'), { mainPid: null, installRoot, platform: 'darwin' })
  if (rootResidents.length > 0) {
    return terminalRow(scenario, cycle, 'FAIL', { failure: 'install_root_busy', before: roleCounts(rootResidents) })
  }

  const unrelated = await startUnrelatedSameNameFixture()
  if (!unrelated.ok) {
    return terminalRow(scenario, cycle, 'FAIL', {
      failure: unrelated.failure,
      ...(unrelated.expectedRole ? { expectedRole: unrelated.expectedRole } : {}),
      ...(unrelated.actualRole ? { actualRole: unrelated.actualRole } : {}),
      ...(unrelated.error ? { error: unrelated.error } : {})
    })
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

    const unrelatedAtKill = findProcess(listProcesses('darwin'), unrelated.identity)
    if (!unrelatedAtKill) {
      hardKill(child.pid)
      return terminalRow(scenario, cycle, 'FAIL', { failure: 'unrelated_same_name_fixture_died_before_kill' })
    }

    const sidecarsAtKill = ownedAtKill.filter((entry) => entry.pid !== child.pid)
    if (ownedAtKill.some((entry) => processIdentity(entry) === unrelated.identity)) {
      hardKill(child.pid)
      return terminalRow(scenario, cycle, 'FAIL', { failure: 'unrelated_same_name_fixture_counted_as_owned' })
    }
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
      const table = listProcesses('darwin')
      if (!findProcess(table, unrelated.identity)) {
        return terminalRow(scenario, cycle, 'FAIL', {
          failure: 'unrelated_same_name_process_did_not_survive',
          unrelatedRole: unrelated.role
        })
      }
      survivors = computeSurvivors(ownedAtKill, table, { installRoot, platform: 'darwin' })
      if (survivors.length === 0) {
        return terminalRow(scenario, cycle, 'PASS', {
          timingsMs: { survivorsGone: Date.now() - killedAt },
          processes: { atKill: roleCounts(ownedAtKill), survivors: {} },
          unrelatedSameName: { role: unrelated.role, survived: true },
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
    stopUnrelatedFixture(unrelated)
    rmSync(unrelated.dir, { recursive: true, force: true })
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
    process.exit(exitCodeForReportResult(report.result))
  }

  const installRoot = realpathSync.native(appPath)
  const executable = macExecutable(installRoot)
  for (let cycle = 1; cycle <= cycles; cycle++) {
    for (const scenario of SCENARIOS) {
      report.rows.push(await runCycle({ executable, installRoot, scenario, cycle }))
    }
  }

  report.result = reportResultForRows(report.rows)
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const exitCode = exitCodeForReportResult(report.result)
  if (exitCode !== 0) process.exit(exitCode)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[hk-m] ${error?.message ?? error}`)
    process.exit(2)
  })
}
