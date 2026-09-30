#!/usr/bin/env node
/**
 * Packaged-app reveal latency (ADR-018, M2-0039): launches the installed app on a Hide right-edge profile, moves
 * the real pointer from rest into the reveal band, and times how long the window takes to leave its parked band.
 * Writes a content-free JSON report; exit 0 PASS, 1 FAIL, 3 BLOCKED_EXTERNAL (the runner cannot move the pointer).
 *
 * node scripts/qa/census/reveal-latency.mjs --app <Metis.app|Metis.exe> --profile <hide profile> --output <json>
 *   [--trials 20] [--settle-ms 15000]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { freeLoopbackPort, resolveInstallTarget, resolveProductVersion, stripSecretEnv, writeJson } from './lib.mjs'
import { movePointer, stationaryMove } from './pointer.mjs'
import {
  APPROACH_SERIES,
  CURSOR_WATCH_IDLE_INTERVAL_MS,
  PARKED_MAX_WIDTH_PX,
  approachPlan,
  isParkedBounds,
  readRevealLatencyArgs,
  revealLatencyBlockedReport,
  revealLatencyExitCode,
  revealLatencyFailedReport,
  revealLatencyReport,
  summarizeRevealSeries,
  validateRevealProfile
} from './reveal-latency-lib.mjs'

const REPARK_TIMEOUT_MS = 10_000
const REVEAL_TIMEOUT_MS = 3_000
/** After re-parking the pointer rests this long first, so the watch is back at its idle cadence when the approach starts. */
const REST_BEFORE_APPROACH_MS = 1_000

const windowBounds = () => ({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight })

async function findParkedOverlay(browser, deadline) {
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          if (!(await page.evaluate(() => typeof window.toto !== 'undefined'))) continue
          const bounds = await page.evaluate(windowBounds)
          if (isParkedBounds(bounds)) return { page, bounds }
        } catch {
          // Pages navigate while the app boots.
        }
      }
    }
    await sleep(500)
  }
  return null
}

async function waitForParked(page, parked, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bounds = await page.evaluate(windowBounds)
    if (bounds.x === parked.x && bounds.y === parked.y && bounds.width === parked.width && bounds.height === parked.height) return true
    await sleep(50)
  }
  return false
}

/** Arms an in-page probe that stamps the wall clock the first time the window grows out of its parked band. */
function armRevealProbe(page) {
  return page.evaluate((maxParkedWidth) => {
    const probe = { revealAt: null }
    window.__metisRevealProbe = probe
    const id = setInterval(() => {
      if (window.outerWidth > maxParkedWidth) {
        probe.revealAt = Date.now()
        clearInterval(id)
      }
    }, 1)
    setTimeout(() => clearInterval(id), 30_000)
  }, PARKED_MAX_WIDTH_PX)
}

async function readRevealAt(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const revealAt = await page.evaluate(() => window.__metisRevealProbe?.revealAt ?? null)
    if (revealAt !== null) return revealAt
    await sleep(25)
  }
  return null
}

async function measure({ page, parked, trials }) {
  const plan = approachPlan(parked)
  const series = []
  for (const { name, speedPxPerMs, gated } of APPROACH_SERIES) {
    const samples = []
    for (let i = 0; i < trials; i += 1) {
      await movePointer(plan.away)
      if (!(await waitForParked(page, parked, REPARK_TIMEOUT_MS))) {
        throw new Error(`the overlay did not re-park within ${REPARK_TIMEOUT_MS} ms with the pointer away`)
      }
      // A random phase against the idle tick, so the samples cover every point of its period.
      await sleep(REST_BEFORE_APPROACH_MS + Math.random() * CURSOR_WATCH_IDLE_INTERVAL_MS)
      await armRevealProbe(page)
      const moved = await movePointer(plan.approach(speedPxPerMs))
      samples.push({ entryAt: moved.entryAt, revealAt: await readRevealAt(page, REVEAL_TIMEOUT_MS) })
    }
    const summary = summarizeRevealSeries(samples)
    series.push({ name, speedPxPerMs, gated, ...summary })
    console.log(`[reveal-latency] ${name} ${speedPxPerMs} px/ms: net p95 ${summary.netP95Ms} ms, misses ${summary.misses}, ${summary.status}`)
  }
  await movePointer(plan.away)
  return series
}

async function quitApp(page, child) {
  if (!child) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  await page?.evaluate(() => window.toto.quit()).catch(() => {})
  const timedOut = await Promise.race([exited.then(() => false), sleep(15_000).then(() => true)])
  if (timedOut && child.exitCode === null) child.kill()
}

async function measureRevealLatency(args) {
  const platform = process.platform
  validateRevealProfile(JSON.parse(readFileSync(join(args.profile, 'settings.json'), 'utf8')))
  const target = resolveInstallTarget(args.app, platform)
  const productVersion = resolveProductVersion({ installRoot: target.installRoot, executable: target.executable, platform })

  // Prove the runner can move the pointer before launching anything: otherwise nothing here is a measurement.
  try {
    await movePointer(stationaryMove({ x: 400, y: 400 }))
  } catch (error) {
    return revealLatencyBlockedReport({ platform, productVersion, reason: error?.message ?? String(error) })
  }

  const port = await freeLoopbackPort()
  const env = stripSecretEnv({ ...process.env, ASKTOTO_USERDATA: args.profile })
  const child = spawn(target.executable, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
  child.once('error', () => {}) // a launch failure surfaces as "never parked" in the report
  let browser = null
  let page = null
  try {
    await sleep(args.settleMs)
    const { chromium } = await import('playwright')
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 })
    const found = await findParkedOverlay(browser, Date.now() + 30_000)
    if (!found) {
      return revealLatencyFailedReport({ platform, productVersion, reason: 'the Hide overlay never parked in its right-edge band' })
    }
    page = found.page
    const series = await measure({ page, parked: found.bounds, trials: args.trials })
    return revealLatencyReport({ platform, productVersion, parked: found.bounds, series })
  } catch (error) {
    return revealLatencyFailedReport({ platform, productVersion, reason: error?.message ?? String(error) })
  } finally {
    await quitApp(page, child)
    await browser?.close().catch(() => {})
  }
}

async function main() {
  const args = readRevealLatencyArgs(process.argv.slice(2))
  const report = await measureRevealLatency(args)
  writeJson(args.output, report)
  console.log(`[reveal-latency] ${report.status}${report.reason ? `: ${report.reason}` : ''}`)
  process.exitCode = revealLatencyExitCode(report)
}

main().catch((error) => {
  console.error(`[reveal-latency] ${error?.message ?? error}`)
  process.exitCode = 1
})
