#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises'

export const PARKED_BOUNDS = { width: 8, height: 2 }
export const PARK_CHECK_INTERVAL_MS = 60_000
export const PARK_BOUNDS_SIGNAL = 'renderer window.screenX/screenY/outerWidth/outerHeight'

export class ParkPreconditionError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ParkPreconditionError'
    this.details = details
    this.exitCode = 2
  }
}

export function isParkedBounds(bounds) {
  return bounds?.width === PARKED_BOUNDS.width && bounds?.height === PARKED_BOUNDS.height
}

export function parkVerdict(bounds, observedAtMs = Date.now()) {
  return {
    observedAt: new Date(observedAtMs).toISOString(),
    bounds,
    parked: isParkedBounds(bounds)
  }
}

export async function evaluatedOverlayBounds(page) {
  const raw = await page.evaluate(() => ({
    left: window.screenX,
    top: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight
  }))
  return {
    left: Number.isFinite(raw?.left) ? raw.left : null,
    top: Number.isFinite(raw?.top) ? raw.top : null,
    width: Number.isFinite(raw?.width) ? raw.width : null,
    height: Number.isFinite(raw?.height) ? raw.height : null
  }
}

export function summarizeParkChecks(checks) {
  const total = checks.length
  const parked = checks.filter((check) => check.parked).length
  return {
    checks: total,
    parked,
    notParked: total - parked,
    parkedCoverage: total === 0 ? 0 : parked / total
  }
}

async function findOverlayPage(browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      try {
        if (await page.evaluate(() => typeof window.toto !== 'undefined')) return page
      } catch {
        // The renderer can still be navigating during launch.
      }
    }
  }
  return null
}

async function overlayPage(browser, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = await findOverlayPage(browser)
    if (page) return page
    await sleep(500)
  }
  throw new Error('no overlay renderer exposing window.toto')
}

export async function createCdpParkChecker(cdpUrl) {
  if (!cdpUrl) throw new Error('parked-idle requires a Chromium DevTools endpoint')
  const { chromium } = await import('playwright')
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 30_000 })
  const page = await overlayPage(browser)
  return {
    async check(now = Date.now()) {
      return parkVerdict(await evaluatedOverlayBounds(page), now)
    },
    async close() {
      await browser.close().catch(() => {})
    }
  }
}

export async function monitorParkedIdle({
  seconds,
  checkPark,
  intervalMs = PARK_CHECK_INTERVAL_MS,
  now = Date.now,
  sleep: sleepFn = sleep
}) {
  if (typeof checkPark !== 'function') throw new Error('checkPark is required')
  const started = now()
  const end = started + seconds * 1000
  const checks = []
  let next = started
  while (true) {
    const at = now()
    if (at >= next || checks.length === 0 || at >= end) {
      const check = await checkPark(at)
      checks.push(check)
      if (checks.length === 1 && !check.parked) {
        throw new ParkPreconditionError('parked-idle precondition failed: overlay window is not parked', {
          observedBounds: check.bounds,
          checks
        })
      }
      next += intervalMs
    }
    if (at >= end) break
    await sleepFn(Math.max(0, Math.min(next, end) - now()))
  }
  return {
    boundsSignal: PARK_BOUNDS_SIGNAL,
    expectedBounds: PARKED_BOUNDS,
    checks,
    summary: summarizeParkChecks(checks)
  }
}
