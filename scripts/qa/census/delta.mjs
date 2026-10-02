#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const COMPARABLE = 'COMPARABLE'
export const NOT_COMPARABLE = 'NOT_COMPARABLE'
export const CENSUS_STATES = Object.freeze(['cold-start', 'settled-idle', 'parked-idle'])

function usage() {
  return `Usage:
  node scripts/qa/census/delta.mjs --baseline <dir> --candidate <dir> --output <json> [--summary <md>]
`
}

function readArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--baseline' || arg === '--candidate' || arg === '--output' || arg === '--summary') {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      args[arg.slice(2)] = argv[i]
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function stateFromFileName(name) {
  for (const state of CENSUS_STATES) {
    if (name === `${state}.json` || name.endsWith(`-${state}.json`)) return state
  }
  return null
}

function censusFiles(dir) {
  const files = new Map()
  if (!existsSync(dir)) return files
  for (const name of readdirSync(dir).sort()) {
    const state = stateFromFileName(name)
    if (state) files.set(state, join(dir, name))
  }
  return files
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function profileManifestPath(dir, state) {
  const file = state === 'parked-idle' ? 'parked-profile-manifest.json' : 'profile-manifest.json'
  return join(dir, file)
}

function profileHash(dir, state) {
  const path = profileManifestPath(dir, state)
  return existsSync(path) ? sha256File(path) : null
}

function setDelta(candidate, baseline) {
  return [...candidate].filter((value) => !baseline.has(value)).sort()
}

function processKey(process) {
  return `${process.pid}:${process.startedMs}`
}

function cpuSecondsByKind(samples, plannedSeconds) {
  const byIdentity = new Map()
  for (const sample of samples) {
    for (const process of sample.processes ?? []) {
      if (!Number.isFinite(process.cpuSeconds)) continue
      const key = processKey(process)
      const current = byIdentity.get(key)
      if (current) current.last = process.cpuSeconds
      else byIdentity.set(key, { kind: process.kind ?? 'other', first: process.cpuSeconds, last: process.cpuSeconds })
    }
  }
  const scale = plannedSeconds > 0 ? 300 / plannedSeconds : 1
  const byKind = new Map()
  for (const identity of byIdentity.values()) {
    const delta = Math.max(0, identity.last - identity.first) * scale
    byKind.set(identity.kind, (byKind.get(identity.kind) ?? 0) + delta)
  }
  return byKind
}

function lastProcesses(report) {
  return report.samples?.at(-1)?.processes ?? []
}

function allProcesses(report) {
  return (report.samples ?? []).flatMap((sample) => sample.processes ?? [])
}

function memoryMetrics(platform) {
  return platform === 'win32' ? ['workingSetBytes', 'privateBytes'] : ['physFootprintBytes']
}

function sumMapValues(map) {
  return [...map.values()].reduce((sum, value) => sum + value, 0)
}

function aggregateReport(report) {
  const last = lastProcesses(report)
  const kinds = new Set()
  const observedKinds = new Set()
  const processCountByKind = new Map()
  const memoryByMetric = new Map(memoryMetrics(report.platform).map((metric) => [metric, new Map()]))
  for (const process of allProcesses(report)) observedKinds.add(process.kind ?? 'other')
  for (const process of last) {
    const kind = process.kind ?? 'other'
    kinds.add(kind)
    processCountByKind.set(kind, (processCountByKind.get(kind) ?? 0) + 1)
    for (const [metric, byKind] of memoryByMetric) {
      byKind.set(kind, (byKind.get(kind) ?? 0) + (Number(process[metric]) || 0))
    }
  }
  return {
    platform: report.platform,
    state: report.state,
    seconds: report.seconds,
    intervalMs: report.intervalMs,
    kinds,
    llamaServerPresent: observedKinds.has('llama-server'),
    cpuSecondsPer300sByKind: cpuSecondsByKind(report.samples ?? [], Number(report.seconds) || 300),
    memoryBytesByMetricByKind: memoryByMetric,
    processCountByKind
  }
}

function metricDelta(candidate, baseline) {
  const kinds = new Set([...candidate.keys(), ...baseline.keys()])
  return Object.fromEntries(
    [...kinds].sort().map((kind) => [
      kind,
      {
        baseline: baseline.get(kind) ?? 0,
        candidate: candidate.get(kind) ?? 0,
        delta: (candidate.get(kind) ?? 0) - (baseline.get(kind) ?? 0)
      }
    ])
  )
}

function scalarDelta(candidate, baseline) {
  return {
    baseline,
    candidate,
    delta: candidate - baseline
  }
}

function compatibilityProblems({ baseline, candidate, baselineProfileSha256, candidateProfileSha256, baselineStates, candidateStates }) {
  const problems = []
  if (baselineProfileSha256 !== candidateProfileSha256) problems.push('profile-manifest sha256 differs')
  if (baselineStates.join(',') !== candidateStates.join(',')) problems.push('state list differs')
  if (baseline.seconds !== candidate.seconds) problems.push('seconds differs')
  if (baseline.intervalMs !== candidate.intervalMs) problems.push('intervalMs differs')
  return problems
}

function compareState({ state, baselineReport, candidateReport, baselineProfileSha256, candidateProfileSha256, baselineStates, candidateStates }) {
  const baseline = aggregateReport(baselineReport)
  const candidate = aggregateReport(candidateReport)
  const problems = compatibilityProblems({ baseline, candidate, baselineProfileSha256, candidateProfileSha256, baselineStates, candidateStates })
  const modelPresenceDiffers = baseline.llamaServerPresent !== candidate.llamaServerPresent
  if (modelPresenceDiffers) problems.push('llama-server presence differs')

  const baselineKinds = baseline.kinds
  const candidateKinds = candidate.kinds
  const memory = {}
  const memoryTotals = {}
  for (const metric of new Set([...baseline.memoryBytesByMetricByKind.keys(), ...candidate.memoryBytesByMetricByKind.keys()])) {
    const baselineByKind = baseline.memoryBytesByMetricByKind.get(metric) ?? new Map()
    const candidateByKind = candidate.memoryBytesByMetricByKind.get(metric) ?? new Map()
    memory[metric] = metricDelta(candidateByKind, baselineByKind)
    memoryTotals[metric] = scalarDelta(sumMapValues(candidateByKind), sumMapValues(baselineByKind))
  }
  const cpuByKind = metricDelta(candidate.cpuSecondsPer300sByKind, baseline.cpuSecondsPer300sByKind)
  const cpuTotal = scalarDelta(sumMapValues(candidate.cpuSecondsPer300sByKind), sumMapValues(baseline.cpuSecondsPer300sByKind))
  const processCountByKind = metricDelta(candidate.processCountByKind, baseline.processCountByKind)
  const processCountTotal = scalarDelta(sumMapValues(candidate.processCountByKind), sumMapValues(baseline.processCountByKind))

  return {
    state,
    status: problems.length ? NOT_COMPARABLE : COMPARABLE,
    reasons: problems,
    inputs: {
      baselineProfileSha256,
      candidateProfileSha256,
      baselineStates,
      candidateStates,
      seconds: { baseline: baseline.seconds, candidate: candidate.seconds },
      intervalMs: { baseline: baseline.intervalMs, candidate: candidate.intervalMs }
    },
    llamaServerPresent: {
      baseline: baseline.llamaServerPresent,
      candidate: candidate.llamaServerPresent,
      differs: modelPresenceDiffers
    },
    newKinds: setDelta(candidateKinds, baselineKinds),
    removedKinds: setDelta(baselineKinds, candidateKinds),
    processCountTotal,
    processCountByKind,
    cpuSecondsPer300s: problems.length
      ? { comparable: false, reason: problems.join('; '), total: cpuTotal }
      : { comparable: true, total: cpuTotal },
    cpuSecondsPer300sByKind: problems.length
      ? { comparable: false, reason: problems.join('; '), byKind: cpuByKind }
      : { comparable: true, byKind: cpuByKind },
    memoryBytesByMetric: problems.length
      ? { comparable: false, reason: problems.join('; '), totals: memoryTotals }
      : { comparable: true, totals: memoryTotals },
    memoryBytesByKind: problems.length ? { comparable: false, reason: problems.join('; '), byMetric: memory } : { comparable: true, byMetric: memory }
  }
}

export function buildDelta({ baselineDir, candidateDir }) {
  const baselineFiles = censusFiles(baselineDir)
  const candidateFiles = censusFiles(candidateDir)
  const baselineStates = [...baselineFiles.keys()].sort()
  const candidateStates = [...candidateFiles.keys()].sort()
  const commonStates = CENSUS_STATES.filter((state) => baselineFiles.has(state) && candidateFiles.has(state))
  const states = commonStates.map((state) =>
    compareState({
      state,
      baselineReport: readJson(baselineFiles.get(state)),
      candidateReport: readJson(candidateFiles.get(state)),
      baselineProfileSha256: profileHash(baselineDir, state),
      candidateProfileSha256: profileHash(candidateDir, state),
      baselineStates,
      candidateStates
    })
  )
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    kind: 'resource-census-delta',
    baseline: { dir: basename(resolve(baselineDir)), states: baselineStates },
    candidate: { dir: basename(resolve(candidateDir)), states: candidateStates },
    commonStates,
    missingStates: {
      baseline: CENSUS_STATES.filter((state) => !baselineFiles.has(state)),
      candidate: CENSUS_STATES.filter((state) => !candidateFiles.has(state))
    },
    states
  }
}

export function summaryMarkdown(delta) {
  const formatNumber = (value) => (Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value) : '-')
  const formatBytes = (value) => (Number.isFinite(value) ? `${formatNumber(value)} B` : '-')
  const formatScalar = (entry, formatter = formatNumber) =>
    `${formatter(entry.baseline)} -> ${formatter(entry.candidate)} (${entry.delta >= 0 ? '+' : ''}${formatter(entry.delta)})`
  const formatComparison = (comparison, entry, formatter = formatNumber) =>
    `${comparison.comparable ? '' : 'NOT_COMPARABLE: '}${formatScalar(entry, formatter)}`
  const formatMemory = (state) =>
    Object.entries(state.memoryBytesByMetric.totals)
      .map(([metric, entry]) => `${metric} ${formatComparison(state.memoryBytesByMetric, entry, formatBytes)}`)
      .join('<br>') || '-'
  const rows = [
    '| State | Status | CPU seconds/300 s total | Memory totals | Process count total | llama-server baseline | llama-server candidate | New candidate kinds | Reasons |',
    '|---|---|---:|---|---:|---:|---:|---|---|'
  ]
  for (const state of delta.states) {
    rows.push(
      `| ${state.state} | ${state.status} | ${formatComparison(state.cpuSecondsPer300s, state.cpuSecondsPer300s.total)} | ${formatMemory(state)} | ${formatScalar(state.processCountTotal)} | ${state.llamaServerPresent.baseline ? 'yes' : 'no'} | ${state.llamaServerPresent.candidate ? 'yes' : 'no'} | ${state.newKinds.join(', ') || '-'} | ${state.reasons.join('; ') || '-'} |`
    )
  }
  if (delta.states.length === 0) rows.push('| - | NOT_COMPARABLE | NOT_COMPARABLE | - | - | - | - | - | no states present in both runs |')
  return `${rows.join('\n')}\n`
}

async function main() {
  const args = readArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (!args.baseline || !args.candidate || !args.output) throw new Error('Usage: delta.mjs --baseline <dir> --candidate <dir> --output <json> [--summary <md>]')
  const delta = buildDelta({ baselineDir: args.baseline, candidateDir: args.candidate })
  const output = resolve(args.output)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(delta, null, 2)}\n`)
  if (args.summary) {
    const summary = resolve(args.summary)
    mkdirSync(dirname(summary), { recursive: true })
    writeFileSync(summary, summaryMarkdown(delta))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`[census-delta] ${error?.message ?? error}`)
    process.exitCode = 1
  })
}
