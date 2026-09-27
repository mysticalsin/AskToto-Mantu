#!/usr/bin/env node
/**
 * Process-ownership primitive for the packaged smoke lanes (M2-0007). Also usable by M2-0009's resource
 * census and the hard-kill suites (M2-0028/0029).
 *
 * Ownership is structural, never by name: a process is owned when it is the main process, a transitive
 * descendant of main, or when its executable resolves inside the canonical install root. Identity is
 * always `(pid, startedMs)`, never a bare pid — pids are reused and, on Windows, parent ids can be
 * stale, so a descendant walk only follows a child whose start time is at or after its parent's. Nothing
 * here is ever selected or killed by process name (`Metis*`, `llama-server`, `powershell`,
 * `chrome_crashpad_handler`): a same-named process outside the install root and not a descendant of main
 * is never owned.
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** @typedef {{ pid: number, ppid: number, startedMs: number, exe: string | null, role: string }} ProcessEntry */

const DARWIN_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/

function parseDarwinTable(output) {
  /** @type {ProcessEntry[]} */
  const entries = []
  for (const row of output.split('\n')) {
    if (!row.trim()) continue
    const match = DARWIN_ROW.exec(row)
    if (!match) continue
    const [, pidText, ppidText, , month, day, time, year, exe] = match
    // Built in this order (never the row's own "Day Mon DD HH:MM:SS YYYY") because Date.parse is
    // reliable on "Mon DD YYYY HH:MM:SS" across engines; never guess a start time it cannot parse.
    const startedMs = Date.parse(`${month} ${day} ${year} ${time}`)
    if (Number.isNaN(startedMs)) continue
    entries.push({
      pid: Number(pidText),
      ppid: Number(ppidText),
      startedMs,
      exe,
      role: path.posix.basename(exe)
    })
  }
  return entries
}

function parseWin32Table(output) {
  let parsed
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : parsed === null || parsed === undefined ? [] : [parsed]
  /** @type {ProcessEntry[]} */
  const entries = []
  for (const row of rows) {
    if (!row || typeof row.pid !== 'number' || typeof row.ppid !== 'number') continue
    const exe = typeof row.exe === 'string' && row.exe !== '' ? row.exe : null
    const startedMs = typeof row.started === 'number' ? row.started : 0
    let role = exe !== null ? path.win32.basename(exe) : 'unknown'
    // The role names the Chromium process kind when present. The command line itself is dropped right
    // after this: it must never leave this function, let alone reach the report (INV-9).
    if (typeof row.cmd === 'string') {
      const type = /--type=(\S+)/.exec(row.cmd)
      if (type) role += ` (${type[1]})`
    }
    entries.push({ pid: row.pid, ppid: row.ppid, startedMs, exe, role })
  }
  return entries
}

/** @returns {ProcessEntry[]} */
export function parseProcessTable(platform, output) {
  if (platform === 'darwin') return parseDarwinTable(output)
  if (platform === 'win32') return parseWin32Table(output)
  throw new Error(`parseProcessTable: unsupported platform ${platform}`)
}

const WIN32_POWERSHELL_QUERY = `[Console]::OutputEncoding = [Text.Encoding]::UTF8;
Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{
  pid = $_.ProcessId; ppid = $_.ParentProcessId;
  started = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 };
  exe = $_.ExecutablePath; cmd = $_.CommandLine } } | ConvertTo-Json -Compress`

/** @returns {ProcessEntry[]} */
export function listProcesses(platform) {
  if (platform === 'darwin') {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='], {
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8'
    })
    return parseProcessTable('darwin', output)
  }
  if (platform === 'win32') {
    // Resolve powershell by absolute path, the same resolution as scripts/check-packaged-launch.mjs:
    // Node's spawn/execFileSync search PATH only, with no System32 fallback.
    const powershell = path.win32.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', WIN32_POWERSHELL_QUERY], {
      encoding: 'utf8'
    })
    return parseProcessTable('win32', output)
  }
  throw new Error(`listProcesses: unsupported platform ${platform}`)
}

function pathModuleFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

/** True iff `candidate` resolves strictly below `root` — the root itself never counts as inside. */
export function isInside(root, candidate, platform) {
  const p = pathModuleFor(platform)
  const a = platform === 'win32' ? root.toLowerCase() : root
  const b = platform === 'win32' ? candidate.toLowerCase() : candidate
  const rel = p.relative(a, b)
  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel)
}

function entryKey(entry) {
  return `${entry.pid}:${entry.startedMs}`
}

/**
 * Main plus its transitive descendants (a child only counts once its recorded start time is at or after
 * its parent's — INV-6's defence against stale Windows parent ids and pid reuse), unioned with every
 * root resident. With `mainPid: null` the result is root residents only, the INV-7 precondition.
 */
export function ownedProcesses(table, { mainPid, installRoot, platform }) {
  const owned = new Map()

  if (mainPid !== null) {
    const main = table.find((entry) => entry.pid === mainPid)
    if (main) {
      const byPpid = new Map()
      for (const entry of table) {
        const children = byPpid.get(entry.ppid)
        if (children) children.push(entry)
        else byPpid.set(entry.ppid, [entry])
      }
      owned.set(entryKey(main), main)
      const queue = [main]
      while (queue.length > 0) {
        const parent = queue.shift()
        for (const child of byPpid.get(parent.pid) ?? []) {
          if (child.startedMs < parent.startedMs) continue
          const key = entryKey(child)
          if (owned.has(key)) continue
          owned.set(key, child)
          queue.push(child)
        }
      }
    }
  }

  for (const entry of table) {
    if (entry.exe !== null && isInside(installRoot, entry.exe, platform)) {
      owned.set(entryKey(entry), entry)
    }
  }

  return [...owned.values()]
}

/** Entries of `table` that are still one of `owned` (by identity) or still resident under the root. */
export function survivors(owned, table, { installRoot, platform }) {
  const ownedKeys = new Set(owned.map(entryKey))
  return table.filter(
    (entry) => ownedKeys.has(entryKey(entry)) || (entry.exe !== null && isInside(installRoot, entry.exe, platform))
  )
}

/** `{ [role]: count }`, keys sorted, for the content-free report (INV-9). */
export function roleCounts(entries) {
  const counts = {}
  for (const entry of entries) counts[entry.role] = (counts[entry.role] ?? 0) + 1
  return Object.fromEntries(Object.keys(counts).sort().map((role) => [role, counts[role]]))
}
