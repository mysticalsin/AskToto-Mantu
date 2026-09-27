#!/usr/bin/env node
/**
 * Packaged proof for M2-0026: onFatal's "Relaunch Métis" and an external SIGTERM must each route through
 * one stopAll() (src/main/lifecycle/exit-paths.ts) before the process ends. Runs against a real
 * QA-identity build, on the QA account, by the QA runner — never on the owner's Mac, and never against the
 * shipping identity: without the compiled-in SIGUSR2 hook (src/main/qa-identity.ts), the signal's default
 * disposition kills main outright, with no fatal dialog and no relaunch.
 *
 * Usage:
 *   node scripts/qa/fault-fatal-relaunch.mjs --zip <Metis-QA-<v>.zip> --sha256 <hex> [--port 9334] [--out <evidence.json>]
 *
 * Exit 0 PASS · 1 FAIL (a survivor, a stray, no relaunch, no dialog) · 2 PRECONDITION (not run: wrong
 * host/identity/state).
 *
 * The evidence this writes is content-free: process classes and pids only, never a path, a command line or
 * a user name.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const QA_BUNDLE_ID = 'com.mantu.asktoto.qa'
const MAIN_PID_TIMEOUT_MS = 30_000
const LLAMA_SERVER_TIMEOUT_MS = 120_000
const RELAUNCH_CLICK_TIMEOUT_MS = 15_000
const RELAUNCH_CLICK_INTERVAL_MS = 500
const OLD_MAIN_EXIT_TIMEOUT_MS = 15_000
const SIGTERM_EXIT_TIMEOUT_MS = 20_000
const POST_EXIT_SETTLE_MS = 10_000

/**
 * @typedef {{ pid: number, ppid: number, started: string, command: string }} PsRow
 */

/** One row of `ps -axo pid=,ppid=,lstart=,command=` under LC_ALL=C. lstart has a fixed shape, which anchors
 *  the split between the start time and a command that may contain spaces. */
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/

/**
 * Parse `ps -axo pid=,ppid=,lstart=,command=` output into rows. A line that does not match the fixed
 * lstart shape is dropped rather than misread.
 * @param {string} text
 * @returns {PsRow[]}
 */
export function parsePs(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const match = line.match(PS_ROW)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), started: match[3], command: match[4] })
  }
  return rows
}

/**
 * Every process below `rootPid`, any depth, root excluded.
 * @param {PsRow[]} processes
 * @param {number} rootPid
 * @returns {PsRow[]}
 */
export function descendantsOf(processes, rootPid) {
  /** @type {Map<number, PsRow[]>} */
  const byPpid = new Map()
  for (const proc of processes) {
    const siblings = byPpid.get(proc.ppid) ?? []
    siblings.push(proc)
    byPpid.set(proc.ppid, siblings)
  }
  /** @type {PsRow[]} */
  const found = []
  const queue = [rootPid]
  while (queue.length) {
    const pid = queue.shift()
    for (const child of byPpid.get(pid) ?? []) {
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

/**
 * Entries of `before` still alive in `now`: same pid AND the same start time, so a reused pid never
 * counts as a survivor.
 * @param {PsRow[]} before
 * @param {PsRow[]} now
 * @returns {PsRow[]}
 */
export function survivors(before, now) {
  const alive = new Set(now.map((proc) => `${proc.pid}\u0000${proc.started}`))
  return before.filter((proc) => alive.has(`${proc.pid}\u0000${proc.started}`))
}

/**
 * A content-free class for one process's command line — never the command itself.
 * @param {string} command
 * @param {string} bundle
 * @returns {string}
 */
export function classify(command, bundle) {
  if (command.includes(`${bundle}/Contents/Resources/llama/`)) return 'llama-server'
  if (command.includes(`${bundle}/Contents/Resources/mac-helper/`)) return 'mac-helper'
  if (command.includes(`${bundle}/Contents/Resources/ffmpeg/`)) return 'ffmpeg'
  if (command.startsWith('/usr/bin/fm serve')) return 'fm-serve'
  if (command.includes('--utility-sub-type=node.mojom.NodeService')) return 'utility-process'
  if (command.includes(`${bundle}/`) && command.includes('--type=')) return 'electron-helper'
  if (command.includes(`${bundle}/Contents/MacOS/`)) return 'main'
  return 'other'
}

/**
 * Owned processes reparented to launchd (ppid 1): orphans from the bundle or fm serve. Never the
 * relaunched main itself (class 'main'), and never an unrelated system process (class 'other').
 * @param {PsRow[]} now
 * @param {string} bundle
 * @returns {PsRow[]}
 */
export function strays(now, bundle) {
  return now.filter((proc) => {
    if (proc.ppid !== 1) return false
    const cls = classify(proc.command, bundle)
    return cls !== 'main' && cls !== 'other'
  })
}

// --- Everything below runs only when this script is executed directly (`main()`), never on import. -----

class Precondition extends Error {}
class Failure extends Error {}

function parseArgs(argv) {
  const args = { port: 9334 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--zip') args.zip = argv[++i]
    else if (arg === '--sha256') args.sha256 = argv[++i]
    else if (arg === '--port') args.port = Number(argv[++i])
    else if (arg === '--out') args.out = argv[++i]
    else throw new Precondition(`Unknown argument: ${arg}`)
  }
  if (!args.zip || !args.sha256) {
    throw new Precondition(
      'Usage: node scripts/qa/fault-fatal-relaunch.mjs --zip <Metis-QA-<v>.zip> --sha256 <hex> [--port 9334] [--out <evidence.json>]'
    )
  }
  return args
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function ps() {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' }
  })
  return parsePs(output)
}

async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await sleep(intervalMs)
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The bundle's own main process: no `--type=`, class 'main', started no earlier than `afterStarted`
 *  (string `ps` lstart comparison — later starts sort later lexically for a fixed-width format sharing a
 *  year, which the QA harness's own single run always does). */
function findMainPid(bundle, afterStarted) {
  const candidates = ps().filter((proc) => classify(proc.command, bundle) === 'main')
  const newer = afterStarted ? candidates.filter((proc) => proc.started > afterStarted) : candidates
  newer.sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0))
  return newer[0]
}

function countByClass(processes, bundle) {
  const counts = {}
  for (const proc of processes) {
    const cls = classify(proc.command, bundle)
    if (cls === 'other') continue
    counts[cls] = (counts[cls] ?? 0) + 1
  }
  return counts
}

async function findTotoPage(browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      try {
        if (await page.evaluate(() => typeof window.toto !== 'undefined')) return page
      } catch {
        /* not the toto page, or it navigated mid-check */
      }
    }
  }
  return null
}

async function prewarmAndWaitForLlamaServer(port, mainPid, bundle) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  try {
    const page = await waitFor(() => findTotoPage(browser), MAIN_PID_TIMEOUT_MS, 500)
    if (!page) throw new Precondition('No page exposing window.toto was found over CDP.')
    await page.evaluate(() => window.toto.localPrewarm('M2-0026 fault proof'))
  } finally {
    await browser.close()
  }
  const descendants = await waitFor(
    () => {
      const found = descendantsOf(ps(), mainPid).filter((proc) => classify(proc.command, bundle) === 'llama-server')
      return found.length ? found : undefined
    },
    LLAMA_SERVER_TIMEOUT_MS,
    500
  )
  return Boolean(descendants)
}

async function clickRelaunchButton(mainPid) {
  const script = `tell application "System Events" to click button "Relaunch Métis" of window 1 of (first process whose unix id is ${mainPid})`
  const deadline = Date.now() + RELAUNCH_CLICK_TIMEOUT_MS
  for (;;) {
    try {
      execFileSync('osascript', ['-e', script], { stdio: 'ignore' })
      return
    } catch (error) {
      if (Date.now() > deadline) throw new Failure(`no fatal dialog: ${error.message}`)
    }
    await sleep(RELAUNCH_CLICK_INTERVAL_MS)
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Precondition('This proof runs on macOS only.')

  const args = parseArgs(process.argv.slice(2))
  const zipSha256 = await sha256File(args.zip)
  if (zipSha256 !== args.sha256) {
    throw new Precondition(`Zip sha256 mismatch: expected ${args.sha256}, got ${zipSha256}`)
  }

  const extractDir = mkdtempSync(join(tmpdir(), 'metis-qa-fault-proof-'))
  try {
    execFileSync('ditto', ['-x', '-k', args.zip, extractDir])
    const appName = readdirSync(extractDir).find((entry) => entry.endsWith('.app'))
    if (!appName) throw new Precondition('The zip contains no .app bundle.')
    const bundle = join(extractDir, appName)

    const bundleId = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(bundle, 'Contents', 'Info.plist')], {
      encoding: 'utf8'
    }).trim()
    if (bundleId !== QA_BUNDLE_ID) {
      throw new Precondition(`Refusing to fault a non-QA identity (${bundleId}). SIGUSR2 has no hook to catch it.`)
    }
    const version = execFileSync(
      'plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', join(bundle, 'Contents', 'Info.plist')],
      { encoding: 'utf8' }
    ).trim()

    if (ps().some((proc) => classify(proc.command, bundle) === 'main')) {
      throw new Precondition('A "Metis QA" main process is already running. Quit it before running this proof.')
    }

    try {
      execFileSync('osascript', ['-e', 'tell application "System Events" to count processes'], { stdio: 'ignore' })
    } catch {
      throw new Precondition('System Events GUI scripting is unavailable — grant Accessibility to the runner (M2-0007).')
    }

    const phases = []

    // --- Phase 1: onFatal relaunch ---------------------------------------------------------------------
    execFileSync('open', ['-n', '-a', bundle, '--args', `--remote-debugging-port=${args.port}`])
    const launched = await waitFor(() => findMainPid(bundle), MAIN_PID_TIMEOUT_MS, 500)
    if (!launched) throw new Failure('The QA build never reached a main process within 30s.')
    const oldMain = launched

    const gotLlama = await prewarmAndWaitForLlamaServer(args.port, oldMain.pid, bundle)
    if (!gotLlama) {
      throw new Precondition('No llama-server appeared within 120s — seed the profile with the local model (M2-0007).')
    }

    const before = descendantsOf(ps(), oldMain.pid)
    const faultedAt = Date.now()
    process.kill(oldMain.pid, 'SIGUSR2')
    await clickRelaunchButton(oldMain.pid)

    await waitFor(() => !isAlive(oldMain.pid), OLD_MAIN_EXIT_TIMEOUT_MS, 250)
    const oldMainExitMs = Date.now() - faultedAt
    await sleep(POST_EXIT_SETTLE_MS)

    const censusAfterRelaunch = ps()
    const relaunched = findMainPid(bundle, oldMain.started)
    if (!relaunched) throw new Failure('no relaunch: no newer main process appeared after the fatal fault.')

    phases.push({
      path: 'onFatal-relaunch',
      owned: countByClass(before, bundle),
      oldMainExitMs,
      survivors: survivors(before, censusAfterRelaunch).map((proc) => ({ pid: proc.pid, class: classify(proc.command, bundle) })),
      strays: strays(censusAfterRelaunch, bundle).map((proc) => ({ pid: proc.pid, class: classify(proc.command, bundle) })),
      relaunched: true
    })

    // --- Phase 2: SIGTERM -> will-quit, on the relaunched instance -------------------------------------
    let llamaServer = false
    try {
      llamaServer = await prewarmAndWaitForLlamaServer(args.port, relaunched.pid, bundle)
    } catch {
      llamaServer = false
    }
    const beforeSigterm = descendantsOf(ps(), relaunched.pid)
    process.kill(relaunched.pid, 'SIGTERM')
    await waitFor(() => !isAlive(relaunched.pid), SIGTERM_EXIT_TIMEOUT_MS, 250)
    await sleep(POST_EXIT_SETTLE_MS)
    const censusAfterSigterm = ps()

    phases.push({
      path: 'sigterm-will-quit',
      owned: countByClass(beforeSigterm, bundle),
      llamaServer,
      survivors: survivors(beforeSigterm, censusAfterSigterm).map((proc) => ({ pid: proc.pid, class: classify(proc.command, bundle) })),
      strays: strays(censusAfterSigterm, bundle).map((proc) => ({ pid: proc.pid, class: classify(proc.command, bundle) }))
    })

    const failed = phases.some((phase) => phase.survivors.length || phase.strays.length)
    const evidence = {
      ticket: 'M2-0026',
      candidate: { zipSha256, bundleId, version },
      phases,
      result: failed ? 'FAIL' : 'PASS'
    }
    if (args.out) writeFileSync(args.out, JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence, null, 2))
    if (failed) throw new Failure('a survivor or stray was found after teardown; see the evidence above')
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
    process.exit(0)
  } catch (error) {
    console.error(`[fault-fatal-relaunch] ${error.message}`)
    process.exit(error instanceof Precondition ? 2 : 1)
  }
}
