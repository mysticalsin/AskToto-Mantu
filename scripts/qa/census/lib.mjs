import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { listProcesses, ownedProcesses } from '../owned-processes.mjs'

export const STATES = [
  'cold-start',
  'settled-idle',
  'first-inference',
  'active-transcription',
  'post-meeting',
  'post-recovery'
]

export const REQUIRED_TRACE_SCENARIOS = ['parked-bar-orb', 'backdrop-filter', 'threejs-obsidian-orb']
export const STATES_REQUIRING_ATTACH_PRECONDITION = [
  'first-inference',
  'active-transcription',
  'post-meeting',
  'post-recovery'
]

export const DEFAULT_SECONDS = 300
export const DEFAULT_INTERVAL_MS = 5_000

const ONE_CORE_CPU_FORMULA = '100 * sum(delta cpuSeconds) / delta wallSeconds'

function entryKey(entry) {
  return `${entry.pid}:${entry.startedMs}`
}

function isWin(platform) {
  return platform === 'win32'
}

function baseRole(entry) {
  if (entry.exe) return basename(entry.exe).toLowerCase()
  return String(entry.role ?? '').toLowerCase()
}

function commandText(enriched) {
  return String(enriched.commandLine ?? enriched.role ?? enriched.exe ?? '').toLowerCase()
}

export function classifyProcess(entry) {
  const role = baseRole(entry)
  const cmd = commandText(entry)
  if (role.includes('crashpad')) return 'crashpad'
  if (role === 'llama-server' || role === 'llama-server.exe' || cmd.includes('llama-server')) return 'llama-server'
  if (cmd.includes('fm serve') || (role === 'fm' && cmd.includes(' serve'))) return 'fm-serve'
  if (cmd.includes('--type=gpu-process') || role.includes('helper (gpu)')) return 'gpu'
  if (cmd.includes('--type=renderer') || role.includes('helper (renderer)')) return 'renderer'
  if (cmd.includes('parakeet-asr-host') || cmd.includes('metis-parakeet-asr')) return 'parakeet-utility'
  if (cmd.includes('whisper-asr-host') || cmd.includes('metis-whisper-import')) return 'whisper-utility'
  if (cmd.includes('speaker-embedding-host') || cmd.includes('metis-speaker-embedding')) return 'speaker-utility'
  if (cmd.includes('--type=utility') || role.includes('helper (plugin)')) return 'utility'
  if (role === 'metis' || role === 'metis.exe') return 'main'
  return 'other'
}

export function oneCoreCpuPercent(samples, wallSeconds) {
  if (!(wallSeconds > 0)) throw new Error('wallSeconds must be positive')
  const observed = new Map()
  for (const sample of samples) {
    for (const process of sample.processes ?? []) {
      if (!Number.isFinite(process.cpuSeconds)) continue
      const key = entryKey(process)
      const current = observed.get(key)
      if (!current) {
        observed.set(key, { first: process.cpuSeconds, last: process.cpuSeconds })
      } else {
        current.last = process.cpuSeconds
      }
    }
  }
  let deltaSeconds = 0
  for (const sample of observed.values()) {
    const delta = sample.last - sample.first
    if (Number.isFinite(delta) && delta > 0) deltaSeconds += delta
  }
  return (100 * deltaSeconds) / wallSeconds
}

function observedProcessIdentities(samples) {
  const identities = new Map()
  for (const sample of samples) {
    for (const process of sample.processes ?? []) {
      const key = entryKey(process)
      if (!identities.has(key)) identities.set(key, process)
    }
  }
  return [...identities.values()]
}

export function validateState(state) {
  if (!STATES.includes(state)) {
    throw new Error(`state must be one of: ${STATES.join(', ')}`)
  }
  return state
}

export function stateRequiresAttachPrecondition(state) {
  return STATES_REQUIRING_ATTACH_PRECONDITION.includes(validateState(state))
}

export function validateStatePrecondition({ state, attachMode, evidence }) {
  const needsPrecondition = stateRequiresAttachPrecondition(state)
  const trimmed = typeof evidence === 'string' ? evidence.trim() : ''
  if (!needsPrecondition) {
    return {
      required: false,
      attachMode: Boolean(attachMode),
      evidence: trimmed || null
    }
  }
  if (!attachMode) {
    throw new Error(`${state} requires --main-pid attach mode after the state precondition is established`)
  }
  if (!trimmed) {
    throw new Error(`${state} requires --precondition-evidence describing the established non-idle state`)
  }
  return {
    required: true,
    attachMode: true,
    evidence: trimmed
  }
}

export function missingStates(observedStates) {
  const observed = new Set(observedStates)
  return STATES.filter((state) => !observed.has(state))
}

export function sanitizeProcessSample(sample) {
  return {
    pid: sample.pid,
    startedMs: sample.startedMs,
    role: sample.role,
    kind: sample.kind,
    rssBytes: sample.rssBytes ?? null,
    physFootprintBytes: sample.physFootprintBytes ?? null,
    workingSetBytes: sample.workingSetBytes ?? null,
    cpuSeconds: sample.cpuSeconds ?? null
  }
}

export function sanitizeReport(report) {
  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    ticket: 'M2-0009',
    productVersion: report.productVersion,
    platform: report.platform,
    state: report.state,
    seconds: report.seconds,
    intervalMs: report.intervalMs,
    accountingBoundary: report.accountingBoundary,
    cpuFormula: ONE_CORE_CPU_FORMULA,
    mainPid: report.mainPid,
    installRootKind: report.installRootKind,
    profileKind: report.profileKind,
    processIdentities: report.processIdentities.map(sanitizeProcessSample),
    samples: report.samples.map((sample) => ({
      tMs: sample.tMs,
      processes: sample.processes.map(sanitizeProcessSample)
    })),
    summary: report.summary,
    statePrecondition: report.statePrecondition,
    rendererTrace: report.rendererTrace,
    proveLocalTtft: report.proveLocalTtft,
    windowsWorkingSet: report.windowsWorkingSet
  }
}

export function summarize(samples, wallSeconds) {
  const last = samples[samples.length - 1]?.processes ?? []
  const byKind = new Map()
  for (const sample of last) {
    const current = byKind.get(sample.kind) ?? {
      count: 0,
      rssBytes: 0,
      physFootprintBytes: 0,
      workingSetBytes: 0
    }
    current.count += 1
    current.rssBytes += sample.rssBytes ?? 0
    current.physFootprintBytes += sample.physFootprintBytes ?? 0
    current.workingSetBytes += sample.workingSetBytes ?? 0
    byKind.set(sample.kind, current)
  }
  const gpuProcesses = last.filter((sample) => sample.kind === 'gpu')
  return {
    oneCoreCpuPercent: oneCoreCpuPercent(samples, wallSeconds),
    processCount: last.length,
    byKind: Object.fromEntries([...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))),
    gpuSampled: gpuProcesses.length > 0,
    gpuPids: gpuProcesses.map((sample) => sample.pid).sort((a, b) => a - b)
  }
}

function parsePsTimeToSeconds(value) {
  const text = String(value).trim()
  const dayParts = text.split('-')
  const clock = dayParts.length === 2 ? dayParts[1] : dayParts[0]
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0
  const parts = clock.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return 0
  if (parts.length === 3) return days * 86_400 + parts[0] * 3_600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return days * 86_400 + parts[0] * 60 + parts[1]
  return 0
}

function parseDarwinPhysFootprintBytes(output) {
  const match = /Physical footprint:\s+([\d.]+)\s*([KMG])?/i.exec(output)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const unit = (match[2] ?? 'K').toUpperCase()
  const factor = unit === 'G' ? 1024 ** 3 : unit === 'M' ? 1024 ** 2 : 1024
  return Math.round(value * factor)
}

function sampleDarwinPhysFootprintBytes(pid) {
  try {
    const output = execFileSync('/usr/bin/vmmap', ['-summary', String(pid)], { encoding: 'utf8', timeout: 8_000 })
    return parseDarwinPhysFootprintBytes(output)
  } catch {
    return null
  }
}

function darwinCommandLine(pid) {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: 2_000
    }).trim()
  } catch {
    return ''
  }
}

function darwinResourceRows(pids) {
  if (pids.length === 0) return new Map()
  const output = execFileSync('/bin/ps', ['-o', 'pid=,rss=,time=', '-p', pids.join(',')], {
    env: { ...process.env, LC_ALL: 'C' },
    encoding: 'utf8'
  })
  const rows = new Map()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)
    if (!match) continue
    rows.set(Number(match[1]), {
      rssBytes: Number(match[2]) * 1024,
      cpuSeconds: parsePsTimeToSeconds(match[3])
    })
  }
  return rows
}

const WIN32_RESOURCE_QUERY = (pids) => `[Console]::OutputEncoding = [Text.Encoding]::UTF8;
$pids = @(${pids.join(',')});
Get-CimInstance Win32_Process | Where-Object { $pids -contains $_.ProcessId } | ForEach-Object { [pscustomobject]@{
  pid = $_.ProcessId;
  ws = $_.WorkingSetSize;
  user = $_.UserModeTime;
  kernel = $_.KernelModeTime;
  cmd = $_.CommandLine
} } | ConvertTo-Json -Compress`

function win32PowerShell() {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function win32ResourceRows(pids) {
  if (pids.length === 0) return new Map()
  const output = execFileSync(win32PowerShell(), ['-NoProfile', '-NonInteractive', '-Command', WIN32_RESOURCE_QUERY(pids)], {
    encoding: 'utf8'
  })
  let parsed
  try {
    parsed = JSON.parse(output || '[]')
  } catch {
    parsed = []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const result = new Map()
  for (const row of rows) {
    if (!row || typeof row.pid !== 'number') continue
    result.set(row.pid, {
      workingSetBytes: Number(row.ws) || 0,
      rssBytes: Number(row.ws) || 0,
      cpuSeconds: ((Number(row.user) || 0) + (Number(row.kernel) || 0)) / 10_000_000,
      commandLine: typeof row.cmd === 'string' ? row.cmd : ''
    })
  }
  return result
}

function processIdentity(entry, resource = {}) {
  const enriched = { ...entry, commandLine: resource.commandLine ?? entry.commandLine ?? '' }
  return {
    pid: entry.pid,
    ppid: entry.ppid,
    startedMs: entry.startedMs,
    role: entry.role,
    kind: classifyProcess(enriched),
    rssBytes: resource.rssBytes ?? null,
    physFootprintBytes: resource.physFootprintBytes ?? null,
    workingSetBytes: resource.workingSetBytes ?? null,
    cpuSeconds: resource.cpuSeconds ?? 0
  }
}

export function resolveInstallTarget(target, platform = process.platform) {
  if (!target) throw new Error('--app is required unless --main-pid and --install-root are both provided')
  const absolute = resolve(target)
  if (!existsSync(absolute)) throw new Error(`app target does not exist: ${target}`)
  if (platform === 'darwin') {
    const root = extname(absolute) === '.app' ? absolute : dirname(dirname(dirname(absolute)))
    return { executable: join(root, 'Contents', 'MacOS', basename(root, '.app')), installRoot: root }
  }
  return { executable: absolute, installRoot: dirname(absolute) }
}

function cleanProductVersion(version) {
  const value = String(version ?? '').trim()
  if (!value) return null
  return value.replace(/\s+/g, ' ')
}

function readDarwinProductVersion(installRoot) {
  const plist = join(installRoot, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return null
  try {
    return cleanProductVersion(
      execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], {
        encoding: 'utf8',
        timeout: 2_000
      })
    )
  } catch {
    try {
      const text = readFileSync(plist, 'utf8')
      const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)
      return cleanProductVersion(match?.[1])
    } catch {
      return null
    }
  }
}

function win32VersionTarget(target) {
  try {
    if (statSync(target).isFile()) return target
  } catch {
    return target
  }
  return join(target, 'Metis.exe')
}

function readWin32ProductVersion(target) {
  const executable = win32VersionTarget(target)
  if (!existsSync(executable)) return null
  const command = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-Item -LiteralPath '${executable.replaceAll("'", "''")}').VersionInfo.ProductVersion`
  return cleanProductVersion(
    execFileSync(win32PowerShell(), ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 4_000
    })
  )
}

/**
 * @param {{ explicit?: string, installRoot: string, executable?: string | null, platform?: NodeJS.Platform }} options
 */
export function resolveProductVersion({ explicit = undefined, installRoot, executable = undefined, platform = process.platform }) {
  const fromCli = cleanProductVersion(explicit)
  if (fromCli) return fromCli
  const detected =
    platform === 'darwin'
      ? readDarwinProductVersion(installRoot)
      : platform === 'win32'
        ? readWin32ProductVersion(executable ?? installRoot)
        : null
  if (detected) return detected
  throw new Error('--product-version is required when the installed app version cannot be read')
}

export function ownedProcessPopulation({ mainPid, installRoot, platform = process.platform, table = listProcesses(platform) }) {
  return ownedProcesses(table, { mainPid, installRoot, platform })
}

export function sampleOwnedProcesses(owned, platform = process.platform) {
  const pids = owned.map((entry) => entry.pid)
  if (platform === 'darwin') {
    const rows = darwinResourceRows(pids)
    return owned.map((entry) => {
      const resource = rows.get(entry.pid) ?? {}
      const commandLine = darwinCommandLine(entry.pid)
      return processIdentity(entry, {
        ...resource,
        commandLine,
        physFootprintBytes: sampleDarwinPhysFootprintBytes(entry.pid)
      })
    })
  }
  if (platform === 'win32') {
    const rows = win32ResourceRows(pids)
    return owned.map((entry) => processIdentity(entry, rows.get(entry.pid) ?? {}))
  }
  throw new Error(`unsupported platform ${platform}`)
}

export async function collectCensus(options) {
  const platform = options.platform ?? process.platform
  const state = validateState(options.state)
  const seconds = Number(options.seconds ?? DEFAULT_SECONDS)
  const intervalMs = Number(options.intervalMs ?? DEFAULT_INTERVAL_MS)
  if (!(seconds > 0)) throw new Error('--seconds must be positive')
  if (!(intervalMs > 0)) throw new Error('--interval-ms must be positive')
  if (!options.installRoot) throw new Error('installRoot is required')
  if (!Number.isInteger(options.mainPid)) throw new Error('mainPid is required')
  const productVersion = cleanProductVersion(options.productVersion)
  if (!productVersion) throw new Error('productVersion is required')
  const statePrecondition = validateStatePrecondition({
    state,
    attachMode: Boolean(options.attachMode),
    evidence: options.preconditionEvidence
  })

  const started = Date.now()
  const end = started + seconds * 1000
  const samples = []
  do {
    const table = listProcesses(platform)
    const owned = ownedProcessPopulation({ mainPid: options.mainPid, installRoot: options.installRoot, platform, table })
    samples.push({ tMs: Date.now() - started, processes: sampleOwnedProcesses(owned, platform) })
    if (Date.now() >= end) break
    await sleep(Math.min(intervalMs, Math.max(1, end - Date.now())))
  } while (Date.now() < end)

  const processIdentities = observedProcessIdentities(samples)
  const report = {
    generatedAt: new Date().toISOString(),
    productVersion,
    platform,
    state,
    seconds,
    intervalMs,
    mainPid: options.mainPid,
    installRootKind: platform === 'darwin' ? 'app-bundle' : 'unpacked-directory',
    profileKind: options.profileKind ?? 'representative-synthetic',
    accountingBoundary:
      'main pid descendants whose start time is not older than their parent, plus processes whose executable resolves below the installed app root',
    processIdentities,
    samples,
    summary: summarize(samples, Math.max(seconds, (samples.at(-1)?.tMs ?? 0) / 1000)),
    statePrecondition,
    rendererTrace: options.rendererTrace ?? { captured: false, scenarios: [] },
    proveLocalTtft: options.proveLocalTtft ?? { recorded: false },
    windowsWorkingSet:
      platform === 'win32'
        ? { measured: true, metric: 'Win32_Process.WorkingSetSize' }
        : { measured: false, metric: 'Win32_Process.WorkingSetSize', lane: 'windows-qa' }
  }
  return sanitizeReport(report)
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function defaultOutputPath({ state, platform, dir = 'metis-census-output' }) {
  return join(dir, `${platform}-${state}.json`).replaceAll('\\', '/')
}

export function repoRootFromHere() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
}
