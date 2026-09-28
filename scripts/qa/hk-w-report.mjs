#!/usr/bin/env node
/**
 * Verdict logic for HK-W (M2-0029), the Windows hard-kill lane: scripts/qa/hk-w.ps1 hard-kills only
 * Metis.exe (Stop-Process -Id) for N cycles and records, per cycle, the owned descendants that were alive
 * before the kill and the ones still alive after the settle window. This turns that raw record into the
 * ticket's decision: do libuv's kill-on-close job semantics cover descendants under Electron, or is a
 * private-job supervise.exe needed. Content-free: pids, roles, counts and timings only.
 *
 * Usage: node scripts/qa/hk-w-report.mjs <hk-w.json> [summary.json]
 * Exit 0 when the lane measured what it was asked to · 1 when it did not (incomplete cycles, no
 * descendants ever observed, start-time path unverified) · 2 usage.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const LLAMA_UNBLOCK = 'Seed the packaged local model assets so the prewarm starts llama-server.exe.'
const REGISTRY_UNBLOCK =
  'Re-run with a release tag built after the M2-0027 process registry so the registry osStartTime is present to compare.'

/**
 * @param {{
 *   requestedCycles: number,
 *   cycles: Array<{ cycle: number, killed: boolean, prewarmOk?: boolean | null, llamaObserved: boolean,
 *     descendants: Array<{ pid: number, startedMs: number, role: string }>,
 *     survivors: Array<{ pid: number, startedMs: number, role: string }> }>,
 *   startTime: { checked: number, mismatches: number, registryChecked: number, registryMismatches: number }
 * }} raw
 */
export function summarizeHkW(raw) {
  const failures = []
  const cycles = Array.isArray(raw?.cycles) ? raw.cycles : []
  const completed = cycles.filter((c) => c.killed).length
  if (completed !== raw?.requestedCycles) {
    failures.push(`completed ${completed} of ${raw?.requestedCycles} kill cycles`)
  }

  const observed = cycles.filter((c) => c.descendants.length > 0)
  const survivorCycles = cycles.filter((c) => c.survivors.length > 0)
  const survivorRoles = {}
  for (const cycle of cycles) {
    for (const survivor of cycle.survivors) survivorRoles[survivor.role] = (survivorRoles[survivor.role] ?? 0) + 1
  }
  if (observed.length === 0) failures.push('no cycle observed any descendant of Metis.exe, so the job semantics are unmeasured')

  // Census completeness: in how many cycles each role was alive before the kill. A role absent from every
  // cycle is reported as unobserved rather than implied covered.
  const observedRoles = {}
  for (const cycle of cycles) {
    for (const role of new Set(cycle.descendants.map((d) => d.role))) observedRoles[role] = (observedRoles[role] ?? 0) + 1
  }
  const roleCycles = (pattern) =>
    Object.entries(observedRoles).reduce((n, [role, count]) => (pattern.test(role) ? n + count : n), 0)
  const watcherCycles = roleCycles(/powershell|pwsh/i)
  const utilityCycles = roleCycles(/\(utility\)/)

  const llamaCycles = cycles.filter((c) => c.llamaObserved).length
  const startTime = raw?.startTime ?? { checked: 0, mismatches: 0, registryChecked: 0, registryMismatches: 0 }
  if (startTime.checked === 0 || startTime.mismatches > 0) {
    failures.push('GetProcessTimes did not agree with the process table for every checked process')
  }
  if (startTime.registryMismatches > 0) failures.push('a registry osStartTime differed from GetProcessTimes')

  // OBSERVED only when descendants were present; one surviving descendant in any cycle is enough to need
  // a private job.
  let jobSemantics = 'unobserved'
  if (observed.length > 0) jobSemantics = survivorCycles.length === 0 ? 'descendants-killed' : 'descendants-survive'

  return {
    result: failures.length === 0 ? 'pass' : 'fail',
    failures,
    requestedCycles: raw?.requestedCycles ?? 0,
    completedCycles: completed,
    cyclesWithDescendants: observed.length,
    cyclesWithSurvivors: survivorCycles.length,
    survivorRoles,
    jobSemantics,
    superviseNeeded: jobSemantics === 'descendants-survive',
    llama:
      llamaCycles > 0
        ? { observedCycles: llamaCycles }
        : { observedCycles: 0, status: 'BLOCKED_EXTERNAL', unblock: LLAMA_UNBLOCK },
    observedRoles,
    watcher: { observedCycles: watcherCycles, ...(watcherCycles === 0 && { status: 'UNOBSERVED' }) },
    utilityHosts: { observedCycles: utilityCycles, ...(utilityCycles === 0 && { status: 'UNOBSERVED' }) },
    startTimePath: {
      checked: startTime.checked,
      mismatches: startTime.mismatches,
      registryChecked: startTime.registryChecked,
      registryMismatches: startTime.registryMismatches,
      ...(!startTime.registryChecked && { status: 'BLOCKED_EXTERNAL', unblock: REGISTRY_UNBLOCK })
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2)
  if (!input) {
    console.error('usage: hk-w-report.mjs <hk-w.json> [summary.json]')
    process.exit(2)
  }
  const summary = summarizeHkW(JSON.parse(readFileSync(input, 'utf8')))
  const text = `${JSON.stringify(summary, null, 2)}\n`
  if (output) writeFileSync(output, text)
  process.stdout.write(text)
  process.exit(summary.result === 'pass' ? 0 : 1)
}
