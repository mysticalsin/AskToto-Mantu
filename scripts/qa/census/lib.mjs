import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
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

/** Measured on demand, outside the release-gate set above: parked-idle is the Hide/Island rest with the pointer
 *  away from the reveal zone (ADR-018, M2-0039), launched from a profile whose layout parks. */
export const SUPPLEMENTARY_STATES = ['parked-idle']
const PARKING_LAYOUTS = ['hide', 'island']

export const ATTRIBUTABLE_PROCESS_KINDS = [
  'main',
  'renderer',
  'gpu',
  'parakeet-utility',
  'whisper-utility',
  'speaker-utility',
  'llama-server',
  'fm-serve',
  'sidecar-supervisor',
  'crashpad'
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
const PROVE_LOCAL_TTFT_COMMAND = 'node scripts/prove-local-ttft.mjs'
const ACCOUNTING_BOUNDARY =
  'main pid descendants whose start time is not older than their parent, plus processes whose executable resolves below the installed app root'
const ACCOUNTING_CONTRACT =
  'Electron helper attribution on macOS is the structural ownership rule above; OS-level app-accounting parity is not assumed by this tool.'

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

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

function portableEvidencePath(path, cwd = process.cwd()) {
  const text = String(path ?? '').trim()
  if (!text) throw new Error('evidence artifact path is required')
  if (text.includes('\\')) throw new Error(`evidence artifact path must be POSIX-style: ${text}`)
  const normalized = isAbsolute(text) ? relative(cwd, text).replaceAll('\\', '/') : text
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../') || normalized.startsWith('/')) {
    throw new Error(`evidence artifact must be inside the working directory: ${text}`)
  }
  if (normalized.split('/').some((part) => part === '' || part === '.')) {
    throw new Error(`evidence artifact path must not contain empty or "." segments: ${text}`)
  }
  return normalized
}

function readEvidenceArtifact(path, cwd = process.cwd()) {
  const portablePath = portableEvidencePath(path, cwd)
  const absolute = resolve(cwd, portablePath)
  if (!existsSync(absolute)) throw new Error(`evidence artifact does not exist: ${portablePath}`)
  return { path: portablePath, absolute, text: readFileSync(absolute, 'utf8') }
}

export function classifyProcess(entry) {
  const role = baseRole(entry)
  const cmd = commandText(entry)
  if (role.includes('crashpad')) return 'crashpad'
  // The supervise wrapper carries its sidecar's path in argv; it must not be counted as that sidecar.
  if (/^metis-mac-helper(\.exe)?$/.test(role) && /metis-mac-helper(\.exe)?\s+supervise(\s|$)/.test(cmd)) {
    return 'sidecar-supervisor'
  }
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

export function parseProveLocalTtftOutput(text) {
  const output = String(text ?? '')
  if (!output.includes('prove-local-ttft: Métis Local warm-suggest TTFT proof')) {
    throw new Error('TTFT artifact is not output from scripts/prove-local-ttft.mjs')
  }
  if (/\[prove-local-ttft\]\s+FAIL|FAILED:/i.test(output)) {
    throw new Error('TTFT artifact records a failed scripts/prove-local-ttft.mjs run')
  }
  const match = /^warm TTFT:\s*(\d+)\s*ms\s*$/im.exec(output)
  if (!match) throw new Error('TTFT artifact is missing "warm TTFT: <n> ms"')
  const warmTtftMs = Number(match[1])
  if (!Number.isFinite(warmTtftMs) || warmTtftMs <= 0) {
    throw new Error('TTFT artifact warm TTFT must be a positive number')
  }
  return warmTtftMs
}

/** Classifies a saved prove-local-ttft run without throwing on a failed proof: a slow hosted runner is a
 *  measured PASS/FAIL/TIMEOUT to record, not a reason to drop the census. */
export function parseProveLocalTtftOutcome(text) {
  const output = String(text ?? '')
  if (!output.includes('prove-local-ttft: Métis Local warm-suggest TTFT proof')) {
    throw new Error('TTFT artifact is not output from scripts/prove-local-ttft.mjs')
  }
  const timeout = /prewarm timed out after (\d+)ms \(limit (\d+)ms\)/.exec(output)
  if (timeout) return { outcome: 'TIMEOUT', prewarmElapsedMs: Number(timeout[1]), prewarmTimeoutMs: Number(timeout[2]) }
  const warm = /^warm TTFT:\s*(\d+)\s*ms\s*$/im.exec(output)
  if (/\[prove-local-ttft\]\s+FAIL|FAILED:/i.test(output)) {
    const health = /healthy on \S+ after (\d+)ms/.exec(output)
    const prewarm = /prewarm \(cold prefill\):\s*(\d+)\s*ms/.exec(output)
    return {
      outcome: 'FAIL',
      ...(health ? { healthMs: Number(health[1]) } : {}),
      ...(prewarm ? { prewarmColdPrefillMs: Number(prewarm[1]) } : {}),
      ...(warm ? { warmTtftMs: Number(warm[1]) } : {})
    }
  }
  // A run cut off before any verdict (no warm TTFT, no FAIL line) is still a measured non-PASS outcome.
  if (!warm) return { outcome: 'INCOMPLETE' }
  return { outcome: 'PASS', warmTtftMs: parseProveLocalTtftOutput(output) }
}

export function proveLocalTtftEvidenceFromArtifact(path, { cwd = process.cwd() } = {}) {
  const artifact = readEvidenceArtifact(path, cwd)
  return {
    recorded: true,
    command: PROVE_LOCAL_TTFT_COMMAND,
    ...parseProveLocalTtftOutcome(artifact.text),
    artifact: {
      path: artifact.path,
      sha256: sha256Text(artifact.text)
    }
  }
}

export function windowsWorkingSetEvidenceFromArtifact(path, { cwd = process.cwd() } = {}) {
  const artifact = readEvidenceArtifact(path, cwd)
  let parsed
  try {
    parsed = JSON.parse(artifact.text)
  } catch {
    throw new Error('Windows working-set artifact must be JSON')
  }
  if (parsed?.platform !== 'win32') throw new Error('Windows working-set artifact must have platform "win32"')
  const samples = Array.isArray(parsed?.samples) ? parsed.samples : []
  const hasWorkingSet = samples.some((sample) =>
    (sample.processes ?? []).some((process) => Number.isFinite(process.workingSetBytes) && process.workingSetBytes > 0)
  )
  if (!hasWorkingSet) throw new Error('Windows working-set artifact has no positive workingSetBytes sample')
  return {
    measured: true,
    metric: 'Win32_Process.WorkingSetSize',
    lane: 'windows-qa',
    artifact: {
      path: artifact.path,
      sha256: sha256Text(artifact.text)
    }
  }
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
  if (!STATES.includes(state) && !SUPPLEMENTARY_STATES.includes(state)) {
    throw new Error(`state must be one of: ${[...STATES, ...SUPPLEMENTARY_STATES].join(', ')}`)
  }
  return state
}

/** A parked-idle census of a Bar-layout profile would measure a window that never parks, so refuse it. */
export function validateProfileForState(state, settings) {
  if (validateState(state) !== 'parked-idle') return
  if (!PARKING_LAYOUTS.includes(settings?.overlayLayout)) {
    throw new Error(
      `parked-idle needs a profile whose overlayLayout parks (${PARKING_LAYOUTS.join(' or ')}); build one with profile.mjs --overlay-layout hide`
    )
  }
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
    evidenceLevel: 'MEASURED',
    productVersion: report.productVersion,
    platform: report.platform,
    state: report.state,
    seconds: report.seconds,
    intervalMs: report.intervalMs,
    accountingBoundary: report.accountingBoundary,
    accountingContract: report.accountingContract,
    cpuFormula: ONE_CORE_CPU_FORMULA,
    attributableProcessKinds: ATTRIBUTABLE_PROCESS_KINDS,
    mainPid: report.mainPid,
    installRootKind: report.installRootKind,
    profileKind: report.profileKind,
    stateCoverage: report.stateCoverage,
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

export function rendererScenarioProbeSource(scenario) {
  if (!REQUIRED_TRACE_SCENARIOS.includes(scenario)) throw new Error(`unknown trace scenario: ${scenario}`)
  return `(() => {
    const visibleBox = (el) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return null;
      return { width: Math.round(rect.width), height: Math.round(rect.height), tag: el.tagName.toLowerCase(), className: String(el.className || '') };
    };
    if (${JSON.stringify(scenario)} === 'parked-bar-orb') {
      const orb = document.querySelector('[data-bar-pill-orb]');
      const box = visibleBox(orb);
      const canvas = orb?.querySelector('canvas');
      return { ok: Boolean(box && canvas), box, attributes: orb ? { state: orb.getAttribute('data-orb-state'), visible: orb.getAttribute('data-orb-visible'), backing: orb.getAttribute('data-orb-backing') } : null };
    }
    if (${JSON.stringify(scenario)} === 'backdrop-filter') {
      for (const el of document.querySelectorAll('body *')) {
        const box = visibleBox(el);
        if (!box) continue;
        const style = getComputedStyle(el);
        const filter = style.backdropFilter || style.webkitBackdropFilter || '';
        if (filter && filter !== 'none') return { ok: true, box, filter };
      }
      return { ok: false, filter: null };
    }
    const canvas = document.querySelector('[data-orb-style="obsidian"] canvas, .obsidian-orb canvas, .obsidian-orb__canvas');
    const box = visibleBox(canvas);
    const host = canvas?.closest('[data-orb-style="obsidian"], .obsidian-orb');
    return { ok: Boolean(box && host), box, hostClassName: host ? String(host.className || '') : null };
  })()`
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

function windowsWorkingSetEvidenceFromSamples(platform, samples) {
  if (platform !== 'win32') {
    return {
      measured: false,
      metric: 'Win32_Process.WorkingSetSize',
      lane: 'windows-qa'
    }
  }
  const measured = samples.some((sample) =>
    (sample.processes ?? []).some((process) => Number.isFinite(process.workingSetBytes) && process.workingSetBytes > 0)
  )
  return {
    measured,
    metric: 'Win32_Process.WorkingSetSize',
    lane: 'windows-qa'
  }
}

export function stateCoverageForRun(measuredState) {
  validateState(measuredState)
  const supplementary = SUPPLEMENTARY_STATES.includes(measuredState) ? [{ state: measuredState, status: 'MEASURED' }] : []
  const gated = STATES.map((state) => {
    if (state === measuredState) return { state, status: 'MEASURED' }
    if (stateRequiresAttachPrecondition(state)) {
      return {
        state,
        status: 'BLOCKED_EXTERNAL',
        unblockStep: `Start the packaged app on the representative QA profile, establish ${state}, then rerun with --main-pid, --install-root, and --precondition-evidence.`
      }
    }
    return { state, status: 'SUPPORTED_NOT_RUN', unblockStep: `Run node scripts/qa/census/run.mjs --state ${state} --seconds 300.` }
  })
  return [...gated, ...supplementary]
}

export function validateCensusIdentity(samples, mainPid) {
  const identities = observedProcessIdentities(samples)
  const hasMain = identities.some((process) => process.pid === mainPid && process.kind === 'main')
  if (!hasMain) {
    throw new Error('invalid census: main process identity was not observed')
  }
  return identities
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

  const now = options.now ?? Date.now
  const sleepFn = options.sleep ?? sleep
  const listProcessesFn = options.listProcesses ?? listProcesses
  const sampleOwnedProcessesFn = options.sampleOwnedProcesses ?? sampleOwnedProcesses
  const started = now()
  const end = started + seconds * 1000
  const samples = []
  while (true) {
    const table = listProcessesFn(platform)
    const owned = ownedProcessPopulation({ mainPid: options.mainPid, installRoot: options.installRoot, platform, table })
    const processes = sampleOwnedProcessesFn(owned, platform)
    const sampledAt = now()
    samples.push({ tMs: sampledAt - started, processes })
    if (sampledAt >= end) break
    await sleepFn(Math.min(intervalMs, Math.max(1, end - sampledAt)))
  }

  const processIdentities = validateCensusIdentity(samples, options.mainPid)
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
    accountingBoundary: ACCOUNTING_BOUNDARY,
    accountingContract: ACCOUNTING_CONTRACT,
    stateCoverage: options.stateCoverage ?? stateCoverageForRun(state),
    processIdentities,
    samples,
    summary: summarize(samples, Math.max(seconds, (samples.at(-1)?.tMs ?? 0) / 1000)),
    statePrecondition,
    rendererTrace: options.rendererTrace ?? { captured: false, scenarios: [] },
    proveLocalTtft: options.proveLocalTtft ?? { recorded: false, command: PROVE_LOCAL_TTFT_COMMAND },
    windowsWorkingSet: options.windowsWorkingSet ?? windowsWorkingSetEvidenceFromSamples(platform, samples)
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
