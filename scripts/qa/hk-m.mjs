#!/usr/bin/env node
/**
 * HK-M packaged sidecar supervision proof. Runs only against an installed macOS app on hosted QA.
 *
 * Usage:
 *   node scripts/qa/hk-m.mjs <Metis.app> <report.json> [--cycles 20] [--budget-ms N]
 *
 * --budget-ms is a total wall-clock budget: no wait starts or continues past it, and every row not reached is
 * reported NOT_RUN (a failure). One progress line per row goes to stdout, and the report is written even when
 * the run is interrupted, so a step timeout still leaves a partial report.
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
const SUPERVISOR_HELPER_ROLE = 'metis-mac-helper'
const SCENARIO_TIMEOUT_MS = 240_000
const RELAUNCH_SETTLE_MS = 3_000
// The same-name fixture is an independent `sleep` that must outlive the slowest row: ready wait, scenario wait, the
// survivor bound and the relaunch check, plus a margin. A shorter fixture expires mid-row on a slow model load and
// masquerades as a process Métis killed (model rows: unrelated_same_name_fixture_died_before_kill).
export const UNRELATED_FIXTURE_LIFETIME_MS =
  READY_TIMEOUT_MS + SCENARIO_TIMEOUT_MS + SURVIVOR_BOUND_MS + READY_TIMEOUT_MS + RELAUNCH_SETTLE_MS + 60_000
const MODEL_SCENARIOS = Object.freeze(['model-starting', 'active-inference'])

function usage() {
  console.error('usage: node scripts/qa/hk-m.mjs <Metis.app> <report.json> [--cycles 20] [--budget-ms N]')
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
  const budgetIndex = argv.indexOf('--budget-ms')
  const budgetMs = budgetIndex === -1 ? null : Number(argv[budgetIndex + 1])
  if (budgetMs !== null && (!Number.isInteger(budgetMs) || budgetMs < 1)) usage()
  return { appPath: argv[0], reportPath: argv[1], cycles, budgetMs }
}

// Wall-clock end of the run's budget; Infinity when no budget was given.
let budgetEnd = Infinity
const budgetSpent = () => Date.now() >= budgetEnd
// A wait deadline that never outlives the budget.
const boundedDeadline = (ms) => Math.min(Date.now() + ms, budgetEnd)

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
        unblock: 'The app did not start a local model sidecar for this row: confirm the bundled local model is packaged and intact.',
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
        unblock: 'The app never reported a live completion (hk-m.active-inference): confirm the bundled local model starts on this runner.',
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
        unblock: 'The app never reported a held ffmpeg decode (hk-m.ffmpeg-import): confirm the reviewed ffmpeg sidecar is packaged.',
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
        unblock: 'The app never reported a registry write loop (hk-m.registry-write).',
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

/**
 * "Relaunch does not duplicate runtimes": after the SIGKILL cycle the app is started again on the same
 * profile. Each runtime role must have at most one process; a row that starts a model must end with exactly one.
 */
export function runtimeRoleVerdict(sidecars, expectRuntime) {
  const counts = roleCounts(sidecars.filter((entry) => LOCAL_MODEL_ROLES.includes(entry.role)))
  const duplicated = Object.keys(counts).filter((role) => counts[role] > 1)
  if (duplicated.length > 0) return { ok: false, failure: 'duplicate_runtime_after_relaunch', counts }
  if (expectRuntime) {
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
    if (total !== 1) return { ok: false, failure: total === 0 ? 'runtime_missing_after_relaunch' : 'multiple_runtime_roles_after_relaunch', counts }
  }
  return { ok: true, counts }
}

/**
 * The codesign/entitlement criterion, observed live: the packaged llama-server cold-started as a child of the
 * supervise wrapper (so the shipped entitlements allowed the helper to spawn it) and never fell back to a
 * direct spawn. `requireHealthy` additionally demands that it reached health.
 */
export function supervisedColdStartVerdict({ records, sidecars, table, requireHealthy }) {
  const runtime = sidecars.find((entry) => entry.role === 'llama-server')
  if (!runtime) return { ok: false, failure: 'supervised_runtime_absent' }
  const parent = table.find((entry) => entry.pid === runtime.ppid)
  if (!parent || parent.role !== SUPERVISOR_HELPER_ROLE) return { ok: false, failure: 'runtime_not_supervised' }
  if (hasEvent(records, 'sidecar.unsupervised')) return { ok: false, failure: 'sidecar_unsupervised_fallback' }
  if (requireHealthy && countEvent(records, 'local.runtime.start') === 0) {
    return { ok: false, failure: 'supervised_cold_start_unhealthy' }
  }
  return { ok: true }
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
  if (rows.some((row) => row.status === 'FAIL' || row.status === 'NOT_RUN')) return 'fail'
  if (rows.some((row) => row.status === 'BLOCKED_EXTERNAL')) return 'blocked'
  return 'pass'
}

export function exitCodeForReportResult(result) {
  return result === 'pass' ? 0 : 1
}

// A killed app can still land a late write in its temp dir while it is removed. That is a cleanup problem, not an
// owned-process leak: retry, then record a warning. It never throws and never changes a scenario result.
export const cleanupWarnings = []

export function removeTempDir(dir, warnings = cleanupWarnings, remove = rmSync) {
  try {
    remove(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    return true
  } catch (error) {
    warnings.push({ code: error?.code ?? 'UNKNOWN', message: error instanceof Error ? error.message : String(error) })
    return false
  }
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
    proc = spawn(executable, [String(Math.ceil(UNRELATED_FIXTURE_LIFETIME_MS / 1000))], { stdio: 'ignore' })
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
        removeTempDir(dir)
        return {
          ok: false,
          failure: 'unrelated_same_name_fixture_unavailable',
          error: spawnError instanceof Error ? spawnError.message : String(spawnError)
        }
      }
      if (exited) {
        stopUnrelatedFixture({ proc })
        removeTempDir(dir)
        return { ok: false, failure: 'unrelated_same_name_fixture_exited_early' }
      }
      const table = listProcesses('darwin')
      const entry = table.find((candidate) => candidate.pid === proc.pid) ?? null
      if (entry) {
        if (entry.role !== UNRELATED_SAME_NAME_ROLE) {
          stopUnrelatedFixture({ proc })
          removeTempDir(dir)
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
    removeTempDir(dir)
    return { ok: false, failure: 'unrelated_same_name_fixture_not_observed' }
  } catch (error) {
    if (proc) stopUnrelatedFixture({ proc })
    removeTempDir(dir)
    return {
      ok: false,
      failure: 'unrelated_same_name_fixture_unavailable',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

// A row's proof is still "coming" while its marker has not landed, or the marker landed a beat before the
// sidecar process became visible. Any other failure is final.
export function scenarioStillStarting(proof) {
  return !proof.ok && (proof.status === 'BLOCKED_EXTERNAL' || proof.failure === 'expected_model_sidecar_absent')
}

/**
 * Starts the app again on the profile the killed instance used, then requires at most one process per runtime
 * role (exactly one when the row had started a model) and nothing owned left over after this instance is killed.
 */
async function relaunchAndCountRuntimes({ executable, installRoot, profile, env, expectRuntime }) {
  const child = spawn(executable, [], {
    env: { ...env, METIS_HK_M_SCENARIO: expectRuntime ? 'model-starting' : 'idle' },
    stdio: 'ignore'
  })
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  child.once('error', () => {
    exited = true
  })
  const owned = () => ownedProcesses(listProcesses('darwin'), { mainPid: child.pid, installRoot, platform: 'darwin' })
  const sidecars = () => owned().filter((entry) => entry.pid !== child.pid)
  let ownedAtKill = []
  try {
    const readyDeadline = boundedDeadline(READY_TIMEOUT_MS)
    // The profile's audit log spans both boots, so the second renderer.ready marks this instance.
    while (!exited && Date.now() < readyDeadline && countEvent(readAudit(profile), 'app.renderer.ready') < 2) {
      await sleep(POLL_MS)
    }
    if (exited || countEvent(readAudit(profile), 'app.renderer.ready') < 2) {
      return { ok: false, failure: budgetSpent() ? 'budget_exhausted' : 'relaunch_not_ready' }
    }
    if (expectRuntime) {
      const runtimeDeadline = boundedDeadline(SCENARIO_TIMEOUT_MS)
      while (!exited && Date.now() < runtimeDeadline && !hasRole(sidecars(), LOCAL_MODEL_ROLES)) await sleep(POLL_MS)
      if (!hasRole(sidecars(), LOCAL_MODEL_ROLES) && budgetSpent()) return { ok: false, failure: 'budget_exhausted' }
    }
    // A duplicate start would have spawned its second runtime by now.
    await sleep(RELAUNCH_SETTLE_MS)
    ownedAtKill = owned()
    const verdict = runtimeRoleVerdict(
      ownedAtKill.filter((entry) => entry.pid !== child.pid),
      expectRuntime
    )
    if (!verdict.ok) return verdict
    hardKill(child.pid)
    const killedAt = Date.now()
    let left = []
    while (Date.now() - killedAt <= SURVIVOR_BOUND_MS) {
      left = computeSurvivors(ownedAtKill, listProcesses('darwin'), { installRoot, platform: 'darwin' })
      if (left.length === 0) return { ok: true, counts: verdict.counts }
      await sleep(POLL_MS)
    }
    for (const entry of left) hardKill(entry.pid)
    return { ok: false, failure: 'relaunch_owned_processes_survived', counts: verdict.counts }
  } finally {
    if (child.pid && !exited) hardKill(child.pid)
  }
}

async function runCycle({ executable, installRoot, scenario, cycle, timings }) {
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
    METIS_SUPERVISION: 'on',
    METIS_DISABLE_APPLE_FM: '1',
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
    const startedAt = Date.now()
    const readyDeadline = boundedDeadline(READY_TIMEOUT_MS)
    while (Date.now() < readyDeadline) {
      if (exitInfo.settled) {
        return terminalRow(scenario, cycle, 'FAIL', { failure: 'exited_before_ready', exit: exitInfo })
      }
      if (hasEvent(readAudit(profile), 'app.renderer.ready')) break
      await sleep(POLL_MS)
    }
    if (!hasEvent(readAudit(profile), 'app.renderer.ready')) {
      hardKill(child.pid)
      if (budgetSpent()) return terminalRow(scenario, cycle, 'NOT_RUN', { failure: 'budget_exhausted' })
      return terminalRow(scenario, cycle, 'FAIL', { failure: 'renderer_not_ready' })
    }
    timings.ready = Date.now() - startedAt

    const snapshot = () => {
      const records = readAudit(profile)
      const registry = readRegistry(profile)
      const table = listProcesses('darwin')
      const owned = ownedProcesses(table, { mainPid: child.pid, installRoot, platform: 'darwin' })
      const sidecars = owned.filter((entry) => entry.pid !== child.pid)
      return { records, registry, table, owned, sidecars, proof: scenarioEvidence(scenario, { records, registry, sidecars }) }
    }
    // The app stamps each row's marker once its work is genuinely in flight (a model can take a while to load),
    // so wait for it rather than killing main on a fixed timer.
    let snap = snapshot()
    const scenarioDeadline = boundedDeadline(SCENARIO_TIMEOUT_MS)
    while (scenarioStillStarting(snap.proof) && Date.now() < scenarioDeadline && !exitInfo.settled) {
      await sleep(POLL_MS)
      snap = snapshot()
    }
    if (exitInfo.settled) {
      return terminalRow(scenario, cycle, 'FAIL', { failure: 'exited_before_scenario', exit: exitInfo })
    }
    if (scenarioStillStarting(snap.proof) && budgetSpent()) {
      hardKill(child.pid)
      return terminalRow(scenario, cycle, 'NOT_RUN', { failure: 'budget_exhausted' })
    }
    const recordsAtKill = snap.records
    const registryAtKill = snap.registry
    const ownedAtKill = snap.owned
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
    if (MODEL_SCENARIOS.includes(scenario)) {
      const coldStart = supervisedColdStartVerdict({
        records: recordsAtKill,
        sidecars: sidecarsAtKill,
        table: snap.table,
        requireHealthy: scenario === 'active-inference'
      })
      if (!coldStart.ok) {
        hardKill(child.pid)
        return terminalRow(scenario, cycle, 'FAIL', { failure: coldStart.failure, evidence: scenarioProof.evidence })
      }
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
        const survivorsGoneMs = Date.now() - killedAt
        const relaunch = await relaunchAndCountRuntimes({
          executable,
          installRoot,
          profile,
          env,
          expectRuntime: MODEL_SCENARIOS.includes(scenario)
        })
        if (!relaunch.ok) {
          if (relaunch.failure === 'budget_exhausted') return terminalRow(scenario, cycle, 'NOT_RUN', { failure: 'budget_exhausted' })
          return terminalRow(scenario, cycle, 'FAIL', {
            failure: relaunch.failure,
            relaunch: { runtimes: relaunch.counts ?? {} },
            evidence: scenarioProof.evidence
          })
        }
        return terminalRow(scenario, cycle, 'PASS', {
          timingsMs: { survivorsGone: survivorsGoneMs },
          processes: { atKill: roleCounts(ownedAtKill), survivors: {} },
          unrelatedSameName: { role: unrelated.role, survived: true },
          relaunch: { runtimes: relaunch.counts },
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
    removeTempDir(unrelated.dir)
    removeTempDir(profile)
  }
}

// One content-free line per row: no paths or command lines.
function progressLine(row) {
  const t = row.timingsMs ?? {}
  const survivors = JSON.stringify(row.processes?.survivors ?? {})
  return `[hk-m] scenario=${row.scenario} cycle=${row.cycle} status=${row.status} readyMs=${t.ready ?? '-'} killToCleanMs=${t.survivorsGone ?? '-'} survivors=${survivors}${row.failure ? ` failure=${row.failure}` : ''}`
}

async function main() {
  const { appPath, reportPath, cycles, budgetMs } = parseArgs(process.argv.slice(2))
  mkdirSync(dirname(reportPath), { recursive: true })
  if (budgetMs !== null) budgetEnd = Date.now() + budgetMs
  const report = {
    schema: 1,
    ticket: 'M2-0028',
    platform: process.platform,
    cycles,
    ...(budgetMs !== null ? { budgetMs } : {}),
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

  // Every planned row that was not reached is recorded, so a partial report still states what did not run.
  const finalize = (reason) => {
    for (let cycle = 1; cycle <= cycles; cycle++) {
      for (const scenario of SCENARIOS) {
        if (!report.rows.some((row) => row.scenario === scenario && row.cycle === cycle)) {
          report.rows.push(terminalRow(scenario, cycle, 'NOT_RUN', { failure: reason }))
        }
      }
    }
    report.result = reportResultForRows(report.rows)
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      finalize('interrupted')
      process.exit(1)
    })
  }

  try {
    const installRoot = realpathSync.native(appPath)
    const executable = macExecutable(installRoot)
    for (let cycle = 1; cycle <= cycles && !budgetSpent(); cycle++) {
      for (const scenario of SCENARIOS) {
        if (budgetSpent()) break
        const timings = {}
        const row = await runCycle({ executable, installRoot, scenario, cycle, timings })
        if (timings.ready !== undefined) row.timingsMs = { ...timings, ...row.timingsMs }
        report.rows.push(row)
        console.log(progressLine(row))
      }
    }
  } finally {
    if (cleanupWarnings.length > 0) report.cleanupWarnings = cleanupWarnings
    finalize(budgetSpent() ? 'budget_exhausted' : 'aborted')
  }
  const exitCode = exitCodeForReportResult(report.result)
  if (exitCode !== 0) process.exit(exitCode)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[hk-m] ${error?.message ?? error}`)
    process.exit(2)
  })
}
