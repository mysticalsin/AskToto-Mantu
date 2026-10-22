// WP14 sandbox acceptance — CPU/RSS sampling of the app process tree. Ownership, classification and the one-core CPU
// formula come from scripts/qa/census (structural ownership: main, its descendants, residents of the install root; never by
// process name). The per-sample resource read is a single `ps` call; the census footprint reader (vmmap per pid, several
// seconds each) is opt-in because it would dominate a 30 s cadence.
import { spawnSync } from 'node:child_process'
import { classifyProcess, ownedProcessPopulation, sampleOwnedProcesses } from '../census/lib.mjs'

/** `ps` TIME: [dd-][hh:]mm:ss[.cc] to seconds. NaN when unparseable. */
export function parsePsTime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(text).trim())
  if (!match) return Number.NaN
  const [, days = '0', hours = '0', minutes, seconds] = match
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

/**
 * Rows of `ps -o pid=,rss=,time=,command=`. The command is kept only so classifyProcess can name the Chromium role;
 * it is never written to a report.
 * @param {string} output
 * @returns {Map<number, { rssBytes: number, cpuSeconds: number, command: string }>}
 */
export function parsePsResourceRows(output) {
  const rows = new Map()
  for (const line of String(output).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    rows.set(Number(match[1]), {
      rssBytes: Number(match[2]) * 1024,
      cpuSeconds: parsePsTime(match[3]),
      command: match[4]
    })
  }
  return rows
}

function runPs(pids) {
  const result = spawnSync('/bin/ps', ['-o', 'pid=,rss=,time=,command=', '-p', pids.join(',')], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 5_000
  })
  return result.stdout ?? ''
}

/**
 * The global hold-chord helper (macOS `metis-mac-helper watch-modifiers`, the Windows `metis-keywatch.exe`). It is the one
 * process voice actions keeps alive while idle, so the voice-actions acceptance judges its CPU on its own (va-idle-cost).
 * A sampler-only kind: census classification (classifyProcess) is left as it is.
 */
export function isChordHelperCommand(command) {
  const text = String(command ?? '')
  return /metis-mac-helper(\.exe)?\s+watch-modifiers(\s|$)/.test(text) || /metis-keywatch(\.exe)?(\s|$)/.test(text)
}

/**
 * One sample of the owned process tree. `mainAlive` is false when the main pid is no longer in the process table.
 * @param {{ mainPid: number, installRoot: string, platform?: string, table?: unknown[], ps?: (pids: number[]) => string,
 *   footprint?: boolean, nowMs?: number }} args
 */
export function sampleTree({
  mainPid,
  installRoot,
  platform = process.platform,
  table = undefined,
  ps = runPs,
  footprint = false,
  nowMs = Date.now()
}) {
  const owned = ownedProcessPopulation({ mainPid, installRoot, platform, ...(table ? { table } : {}) })
  const mainAlive = owned.some((entry) => entry.pid === mainPid)
  const rows = parsePsResourceRows(owned.length ? ps(owned.map((entry) => entry.pid)) : '')
  const footprints =
    footprint && owned.length
      ? new Map(sampleOwnedProcesses(owned, platform).map((entry) => [entry.pid, entry.physFootprintBytes ?? null]))
      : null
  const processes = owned.map((entry) => {
    const row = rows.get(entry.pid)
    return {
      pid: entry.pid,
      startedMs: entry.startedMs,
      kind:
        entry.pid === mainPid
          ? 'main'
          : isChordHelperCommand(row?.command)
            ? 'chord-helper'
            : classifyProcess({ ...entry, commandLine: row?.command ?? '' }),
      rssBytes: row?.rssBytes ?? null,
      cpuSeconds: row?.cpuSeconds ?? null,
      ...(footprints ? { physFootprintBytes: footprints.get(entry.pid) ?? null } : {})
    }
  })
  return { wallMs: nowMs, mainAlive, processes }
}

/** Total RSS of a sample, or null when any process lacks an RSS reading (an incomplete sample is never summed). */
export function totalRss(sample) {
  let total = 0
  for (const process of sample.processes ?? []) {
    if (!Number.isFinite(process.rssBytes)) return null
    total += process.rssBytes
  }
  return total
}

/** Per-kind process counts of a sample. */
export function countByKind(sample) {
  const counts = {}
  for (const process of sample.processes ?? []) counts[process.kind] = (counts[process.kind] ?? 0) + 1
  return counts
}
