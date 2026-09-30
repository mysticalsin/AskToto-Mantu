#!/usr/bin/env node
/**
 * Packaged proof for M2-0037's reload budget (M2-0469). SIGKILLs the overlay renderer of an installed
 * packaged app 4 times within 60 s and requires exactly 3 automatic reloads, then one
 * app.render_loop_halted with the halted dialog on screen, no 4th reload, and a clean exit through the
 * dialog's Quit button (src/main/index.ts render-process-gone, src/main/lifecycle/reload-budget.ts,
 * src/main/lifecycle/render-loop-halted-dialog.ts). It needs no QA-only hook, so it runs on the
 * promotable DMG, in the candidate-scenarios lane (scripts/qa/candidate-scenarios.mjs).
 *
 * Usage:
 *   node scripts/qa/renderer-kill.mjs <installed .app | Metis-<v>.dmg> <report.json> [--times 4] [--window 60]
 *       [--sha256 <hex>]
 * A DMG is verified against --sha256 (required for a DMG) and copied into a fresh directory first.
 *
 * Exit 0 PASS · 1 FAIL · 2 PRECONDITION (not measured: wrong host, ambiguous renderer mapping, or a kill
 * cadence slow enough that the budget may have reset). The report is content-free: pids, counts, timings
 * and audit event counts; never a path, a command line or a window title.
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { listProcesses, ownedProcesses, roleCounts, survivors } from './owned-processes.mjs'
import { sha256File } from './provenance.mjs'
import { launchEnv } from './sidecar-boot-reaper.mjs'

/** The product's budget (src/main/lifecycle/reload-budget.ts): 3 reloads per 60 s, and a crash more than
 *  30 s after the last did-finish-load forgives the history. */
export const MAX_RELOADS = 3
export const BUDGET_WINDOW_MS = 60_000
export const ALIVE_RESET_MS = 30_000
/** The 4th kill is the first one the budget refuses; any other count cannot exercise the halt. */
export const KILLS = MAX_RELOADS + 1
export const AFTER_HALT_WATCH_MS = 20_000
export const CENSUS_SETTLE_MS = 5_000

const READY_TIMEOUT_MS = 150_000
const RELOAD_TIMEOUT_MS = 25_000
const QUIT_TIMEOUT_MS = 20_000
const PROBE_TIMEOUT_MS = 3_000
const POLL_MS = 250

/** A returning user's profile: onboarding done (a fresh profile's exclusive onboarding tour replaces the
 *  window on a crash instead of reloading it) and the bar layout, so the overlay is on screen, never
 *  parked, and the halted dialog has a visible parent. */
export const ONBOARDED_SETTINGS = Object.freeze({ onboardingDone: true, overlayLayout: 'bar', autoHideOverlay: false })

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/

class Precondition extends Error {}
class Failure extends Error {}

/** `ps -axo pid=,ppid=,lstart=,command=` rows; a line that does not match the fixed lstart shape is dropped. */
export function parsePs(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const match = PS_ROW.exec(line)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), started: match[3], command: match[4] })
  }
  return rows
}

/** Renderer processes below `mainPid`, any depth: the only processes whose command carries --type=renderer. */
export function rendererRows(rows, mainPid) {
  const byPpid = new Map()
  for (const row of rows) byPpid.set(row.ppid, [...(byPpid.get(row.ppid) ?? []), row])
  const found = []
  const queue = [mainPid]
  while (queue.length) {
    for (const child of byPpid.get(queue.shift()) ?? []) {
      if (/(^|\s)--type=renderer(\s|$)/.test(child.command)) found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

/**
 * The overlay renderer's pid, only when the mapping is unambiguous: exactly one page exposes window.toto,
 * CDP SystemInfo.getProcessInfo names exactly one renderer, and the process table's renderers below main
 * are exactly that pid. Anything else is a problem, never a guess.
 * @returns {{ pid: number } | { problem: string }}
 */
export function overlayRendererMapping({ totoPages, cdpRendererPids, psRendererPids }) {
  if (totoPages === 0) return { problem: 'no page exposes window.toto' }
  if (totoPages > 1) return { problem: `${totoPages} pages expose window.toto` }
  const cdp = [...new Set(cdpRendererPids)].sort((a, b) => a - b)
  const ps = [...new Set(psRendererPids)].sort((a, b) => a - b)
  if (cdp.length !== 1) return { problem: `CDP reports ${cdp.length} renderer processes` }
  if (ps.length !== cdp.length || ps[0] !== cdp[0]) {
    return { problem: `the process table's ${ps.length} renderer(s) below main do not match CDP's renderer` }
  }
  return { pid: cdp[0] }
}

/** Audit counts the verdict reads, from the app's own audit.log records. */
export function eventCounts(records) {
  const count = (predicate) => records.filter(predicate).length
  return {
    'app.renderer.ready': count((r) => r.event === 'app.renderer.ready'),
    'app.crash render-process-gone': count((r) => r.event === 'app.crash' && r.kind === 'render-process-gone'),
    'app.render_loop_halted': count((r) => r.event === 'app.render_loop_halted'),
    'app.error.reload_failed': count((r) => r.event === 'app.error.reload_failed')
  }
}

/**
 * @typedef {{ pid: number, atMs: number, sincePreviousKillMs: number | null }} Kill
 * @typedef {{ afterKill: number, pid: number, latencyMs: number }} Reload
 * @typedef {{ settleMs: number, owned: number, survivors: number, orphans: number, roles: Record<string, number> }} Census
 * @typedef {{
 *   parameters: { times: number, windowS: number },
 *   aborted: { kind: 'PRECONDITION' | 'FAIL', reason: string } | null,
 *   pids: { main: number | null, overlayRenderers: number[] },
 *   mapping: { totoPages: number, cdpRenderers: number, psRenderers: number } | null,
 *   kills: Kill[],
 *   reloads: Reload[],
 *   afterHalt: { watchMs: number, overlayRenderers: number, rendererProcesses: number, dialog: string | null, dialogMs: number | null },
 *   events: Record<string, number> | null,
 *   mainAliveThroughout: boolean,
 *   quit: { viaDialog: boolean, exitMs: number | null },
 *   census: Census | null
 * }} Observation
 */

/** A fresh observation; the harness fills it in and `verdict` judges it.
 *  @returns {Observation} */
export function emptyObservation({ times, windowS }) {
  return {
    parameters: { times, windowS },
    aborted: null,
    pids: { main: null, overlayRenderers: [] },
    mapping: null,
    kills: [],
    reloads: [],
    afterHalt: { watchMs: AFTER_HALT_WATCH_MS, overlayRenderers: 0, rendererProcesses: 0, dialog: null, dialogMs: null },
    events: null,
    mainAliveThroughout: true,
    quit: { viaDialog: false, exitMs: null },
    census: null
  }
}

/**
 * Judges an observation. A cadence that let the budget reset (a kill landing ALIVE_RESET_MS or more after
 * the previous one, which bounds the reload's time alive after its did-finish-load) or kills spanning the
 * window is a PRECONDITION: the product would then be right to reload again. Otherwise PASS needs all of:
 * `times` render-process-gone crashes, times-1 automatic reloads, one app.render_loop_halted, no overlay
 * renderer after the halt, no app.error.reload_failed, main alive throughout, the halted dialog seen
 * through System Events and quit through its Quit button, and no survivor or orphan in the census.
 * @param {Observation} observation
 * @returns {{ result: 'PASS' | 'FAIL' | 'PRECONDITION', failures: string[], preconditions: string[] }}
 */
export function verdict(observation) {
  const { times, windowS } = observation.parameters
  if (observation.aborted?.kind === 'PRECONDITION') {
    return { result: 'PRECONDITION', failures: [], preconditions: [observation.aborted.reason] }
  }
  const preconditions = []
  observation.kills.forEach((kill, index) => {
    if (index > 0 && kill.sincePreviousKillMs >= ALIVE_RESET_MS) {
      preconditions.push(`kill ${index + 1} landed ${kill.sincePreviousKillMs} ms after the previous one; the budget may have reset`)
    }
  })
  const last = observation.kills.at(-1)
  if (last && last.atMs >= windowS * 1000) preconditions.push(`the kills spanned ${last.atMs} ms, not within ${windowS} s`)
  if (preconditions.length) return { result: 'PRECONDITION', failures: [], preconditions }
  if (observation.aborted) return { result: 'FAIL', failures: [observation.aborted.reason], preconditions: [] }

  const failures = []
  const events = observation.events ?? eventCounts([])
  if (!observation.mainAliveThroughout) failures.push('the main process died during the run')
  if (observation.kills.length !== times) failures.push(`${observation.kills.length} of ${times} kills landed`)
  if (observation.reloads.length !== times - 1) {
    failures.push(`${observation.reloads.length} automatic reloads were observed, expected ${times - 1}`)
  }
  if (events['app.crash render-process-gone'] !== times) {
    failures.push(`${events['app.crash render-process-gone']} app.crash render-process-gone audits, expected ${times}`)
  }
  if (events['app.render_loop_halted'] !== 1) {
    failures.push(`${events['app.render_loop_halted']} app.render_loop_halted audits, expected 1`)
  }
  if (observation.afterHalt.overlayRenderers > 0) {
    failures.push(`an overlay renderer came back within ${observation.afterHalt.watchMs} ms of the last kill (reload storm)`)
  }
  if (events['app.error.reload_failed'] > 0) failures.push(`${events['app.error.reload_failed']} app.error.reload_failed audits`)
  if (!observation.afterHalt.dialog) failures.push('no halted dialog with Reload and Quit buttons was found through System Events')
  else if (!observation.quit.viaDialog) failures.push("the halted dialog's Quit did not end the main process")
  if (!observation.census) failures.push('the post-quit census did not run')
  else {
    if (observation.census.survivors > 0) failures.push(`${observation.census.survivors} owned processes survived the quit`)
    if (observation.census.orphans > 0) failures.push(`${observation.census.orphans} orphans remained under the install root`)
  }
  return { result: failures.length ? 'FAIL' : 'PASS', failures, preconditions: [] }
}

/** The content-free report: the observation plus its verdict.
 *  @param {Observation} observation */
export function buildReport(observation) {
  const judged = verdict(observation)
  return { schema: 1, ticket: 'M2-0469', proves: 'M2-0037', ...judged, ...observation }
}

/**
 * AppleScript that looks, in the process with this unix id, for a window or sheet that has both a Reload
 * and a Quit button (the halted dialog, render-loop-halted-dialog.ts), and either names where it found it
 * ('sheet' or 'window') or clicks its Quit button ('clicked'). Prints 'none' when there is no such dialog.
 */
export function dialogScript(pid, action) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('dialogScript needs a positive integer pid')
  const hit = (element, kind) =>
    action === 'quit' ? `click button "Quit" of ${element}\n        return "clicked"` : `return "${kind}"`
  return `tell application "System Events"
  set appProcess to first process whose unix id is ${pid}
  repeat with w in (windows of appProcess)
    repeat with s in (sheets of w)
      if (exists button "Reload" of s) and (exists button "Quit" of s) then
        ${hit('s', 'sheet')}
      end if
    end repeat
    if (exists button "Reload" of w) and (exists button "Quit" of w) then
      ${hit('w', 'window')}
    end if
  end repeat
  return "none"
end tell`
}

// --- Everything below drives the installed app; it runs only when this file is executed directly. -------

function parseArgs(argv) {
  const args = { times: KILLS, windowS: BUDGET_WINDOW_MS / 1000, sha256: null }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--times') args.times = Number(argv[++i])
    else if (arg === '--window') args.windowS = Number(argv[++i])
    else if (arg === '--sha256') args.sha256 = String(argv[++i] ?? '').trim().toLowerCase()
    else if (arg.startsWith('--')) throw new Precondition(`unknown argument ${arg}`)
    else positional.push(arg)
  }
  if (positional.length !== 2) {
    throw new Precondition('usage: renderer-kill.mjs <installed .app | .dmg> <report.json> [--times 4] [--window 60] [--sha256 <hex>]')
  }
  args.target = positional[0]
  args.report = positional[1]
  if (args.times !== KILLS) throw new Precondition(`--times must be ${KILLS}: the budget allows ${MAX_RELOADS} reloads, so kill ${KILLS} is the one that halts`)
  if (!(args.windowS > 0 && args.windowS <= BUDGET_WINDOW_MS / 1000)) {
    throw new Precondition(`--window must be above 0 and at most ${BUDGET_WINDOW_MS / 1000} s, the product's budget window`)
  }
  return args
}

function ps() {
  return parsePs(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }))
}

async function waitFor(predicate, timeoutMs, intervalMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await sleep(intervalMs)
  }
}

function withTimeout(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => undefined)])
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function readAudit(profile) {
  let text = ''
  try {
    text = readFileSync(join(profile, 'logs', 'audit.log'), 'utf8')
  } catch {
    return []
  }
  const records = []
  for (const line of text.split('\n')) {
    try {
      if (line.trim()) records.push(JSON.parse(line))
    } catch {
      /* a partial last line */
    }
  }
  return records
}

function osascript(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim()
}

function haltedDialog(pid, action) {
  try {
    const answer = osascript(dialogScript(pid, action))
    return answer === 'none' ? null : answer
  } catch {
    return null
  }
}

/** One look at the app over CDP and the process table, for overlayRendererMapping. Null when CDP is not
 *  reachable yet. */
async function probe(port, mainPid) {
  let browser
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: PROBE_TIMEOUT_MS })
    let totoPages = 0
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      const hasToto = await withTimeout(page.evaluate(() => typeof window.toto !== 'undefined').catch(() => false), PROBE_TIMEOUT_MS)
      if (hasToto) totoPages += 1
    }
    const session = await browser.newBrowserCDPSession()
    const { processInfo } = await session.send('SystemInfo.getProcessInfo')
    return {
      totoPages,
      cdpRendererPids: processInfo.filter((info) => info.type === 'renderer').map((info) => info.id),
      psRendererPids: rendererRows(ps(), mainPid).map((row) => row.pid)
    }
  } catch {
    return null
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

/** Waits for an overlay renderer other than `previousPid` whose page exposes window.toto. Returns null on
 *  timeout; throws a Precondition when the last look was reachable but ambiguous. */
async function waitForOverlayRenderer(port, mainPid, previousPid, timeoutMs, observation) {
  let lastProblem = null
  const found = await waitFor(async () => {
    const seen = await probe(port, mainPid)
    if (!seen) return undefined
    const mapping = overlayRendererMapping(seen)
    if ('problem' in mapping) {
      lastProblem = mapping.problem
      observation.mapping = { totoPages: seen.totoPages, cdpRenderers: seen.cdpRendererPids.length, psRenderers: seen.psRendererPids.length }
      return undefined
    }
    lastProblem = null
    return mapping.pid !== previousPid ? mapping.pid : undefined
  }, timeoutMs)
  if (found) return found
  if (lastProblem && lastProblem !== 'no page exposes window.toto') {
    throw new Precondition(`the overlay renderer pid is ambiguous: ${lastProblem}`)
  }
  return null
}

function installDmg(dmg, workDir) {
  const volume = join(workDir, 'volume')
  const target = join(workDir, 'install')
  mkdirSync(volume)
  mkdirSync(target)
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', volume, dmg], { stdio: 'ignore' })
  try {
    const bundle = readdirSync(volume).find((entry) => entry.endsWith('.app'))
    if (!bundle) throw new Precondition('the DMG holds no .app bundle')
    execFileSync('ditto', [join(volume, bundle), join(target, bundle)])
    return join(target, bundle)
  } finally {
    execFileSync('hdiutil', ['detach', volume], { stdio: 'ignore' })
  }
}

async function resolveApp(args, workDir) {
  if (args.target.endsWith('.dmg')) {
    if (!/^[0-9a-f]{64}$/.test(args.sha256 ?? '')) throw new Precondition('a DMG needs --sha256 <64 hex>')
    if ((await sha256File(args.target)) !== args.sha256) throw new Precondition('the DMG does not match --sha256')
    return installDmg(args.target, workDir)
  }
  if (args.target.endsWith('.app')) return args.target
  throw new Precondition('the target is neither an installed .app nor a .dmg')
}

async function run(args, observation) {
  const workDir = mkdtempSync(join(tmpdir(), 'metis-renderer-kill-'))
  const profile = join(workDir, 'profile')
  let child = null
  let installRoot = null
  let mainExited = false
  try {
    try {
      osascript('tell application "System Events" to count processes')
    } catch {
      throw new Precondition('System Events GUI scripting is unavailable; grant Accessibility to the runner (M2-0007)')
    }
    installRoot = realpathSync.native(await resolveApp(args, workDir))
    const executable = join(installRoot, 'Contents', 'MacOS', basename(installRoot, '.app'))
    const busy = ownedProcesses(listProcesses('darwin'), { mainPid: null, installRoot, platform: 'darwin' })
    if (busy.length) throw new Precondition('the install root already has resident processes')

    mkdirSync(profile, { mode: 0o700 })
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ ...ONBOARDED_SETTINGS, onboardingDoneAt: Date.now() }), { mode: 0o600 })
    const port = await freeLoopbackPort()
    child = spawn(executable, [`--remote-debugging-port=${port}`], { env: launchEnv(process.env, profile), stdio: 'ignore' })
    child.on('exit', () => {
      mainExited = true
    })
    const mainPid = child.pid
    if (!mainPid) throw new Failure('the main process did not start')
    observation.pids.main = mainPid
    const mainAlive = () => {
      if (mainExited) observation.mainAliveThroughout = false
      return !mainExited
    }

    if (!(await waitFor(() => readAudit(profile).some((r) => r.event === 'app.renderer.ready'), READY_TIMEOUT_MS))) {
      throw new Failure('the app never recorded app.renderer.ready')
    }
    let current = await waitForOverlayRenderer(port, mainPid, null, READY_TIMEOUT_MS, observation)
    if (!current) throw new Precondition('no overlay renderer exposing window.toto was found over CDP')
    observation.pids.overlayRenderers.push(current)

    let firstKillAt = null
    let lastKillAt = null
    for (let kill = 1; kill <= args.times; kill++) {
      if (!mainAlive()) break
      const row = rendererRows(ps(), mainPid).find((entry) => entry.pid === current)
      if (!row) throw new Failure(`overlay renderer ${current} vanished before kill ${kill}`)
      const killedAt = Date.now()
      process.kill(current, 'SIGKILL')
      firstKillAt ??= killedAt
      observation.kills.push({ pid: current, atMs: killedAt - firstKillAt, sincePreviousKillMs: lastKillAt === null ? null : killedAt - lastKillAt })
      lastKillAt = killedAt
      if (kill === args.times) break
      const next = await waitForOverlayRenderer(port, mainPid, current, RELOAD_TIMEOUT_MS, observation)
      if (!next) break
      observation.reloads.push({ afterKill: kill, pid: next, latencyMs: Date.now() - killedAt })
      observation.pids.overlayRenderers.push(next)
      current = next
    }

    if (observation.kills.length === args.times) {
      const baseline = new Set(rendererRows(ps(), mainPid).map((row) => row.pid))
      const newRenderers = new Set()
      const overlays = new Set()
      const watchEnd = lastKillAt + AFTER_HALT_WATCH_MS
      while (Date.now() < watchEnd && mainAlive()) {
        if (!observation.afterHalt.dialog) {
          const dialog = haltedDialog(mainPid, 'find')
          if (dialog) {
            observation.afterHalt.dialog = dialog
            observation.afterHalt.dialogMs = Date.now() - lastKillAt
          }
        }
        for (const row of rendererRows(ps(), mainPid)) if (!baseline.has(row.pid)) newRenderers.add(row.pid)
        // Any page exposing window.toto again means the overlay came back, whether or not its pid maps.
        const seen = await probe(port, mainPid)
        if (seen && seen.totoPages > 0) {
          const mapping = overlayRendererMapping(seen)
          overlays.add('pid' in mapping ? mapping.pid : `unmapped:${[...seen.cdpRendererPids].sort().join(',')}`)
        }
        await sleep(500)
      }
      observation.afterHalt.overlayRenderers = overlays.size
      observation.afterHalt.rendererProcesses = newRenderers.size
    }
    observation.events = eventCounts(readAudit(profile))
    mainAlive()

    if (observation.afterHalt.dialog && !mainExited) {
      const owned = ownedProcesses(listProcesses('darwin'), { mainPid, installRoot, platform: 'darwin' })
      const quitAt = Date.now()
      if (haltedDialog(mainPid, 'quit') === 'clicked' && (await waitFor(() => mainExited, QUIT_TIMEOUT_MS))) {
        observation.quit = { viaDialog: true, exitMs: Date.now() - quitAt }
        await sleep(CENSUS_SETTLE_MS)
        const left = survivors(owned, listProcesses('darwin'), { installRoot, platform: 'darwin' })
        observation.census = {
          settleMs: CENSUS_SETTLE_MS,
          owned: owned.length,
          survivors: left.length,
          orphans: left.filter((entry) => entry.ppid === 1).length,
          roles: roleCounts(left)
        }
      }
    }
  } catch (error) {
    observation.aborted = {
      kind: error instanceof Precondition ? 'PRECONDITION' : 'FAIL',
      reason: error instanceof Precondition || error instanceof Failure ? error.message : 'unexpected harness error'
    }
    if (!(error instanceof Precondition || error instanceof Failure)) console.error(error)
  } finally {
    if (installRoot) {
      try {
        const mainPid = child && !mainExited ? child.pid : null
        for (const entry of ownedProcesses(listProcesses('darwin'), { mainPid: mainPid ?? null, installRoot, platform: 'darwin' })) {
          try {
            process.kill(entry.pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
      } catch {
        /* best effort */
      }
      await waitFor(() => !child || mainExited, 5_000)
    }
    rmSync(workDir, { recursive: true, force: true })
  }
}

async function main(argv) {
  let args
  try {
    if (process.platform !== 'darwin') throw new Precondition('this proof runs on macOS only')
    args = parseArgs(argv)
  } catch (error) {
    console.error(`[renderer-kill] ${error.message}`)
    return 2
  }
  const observation = emptyObservation({ times: args.times, windowS: args.windowS })
  await run(args, observation)
  const report = buildReport(observation)
  mkdirSync(dirname(args.report), { recursive: true })
  writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  if (report.result !== 'PASS') console.error(`[renderer-kill] ${report.result}: ${[...report.preconditions, ...report.failures][0]}`)
  return { PASS: 0, FAIL: 1, PRECONDITION: 2 }[report.result]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)))
}
