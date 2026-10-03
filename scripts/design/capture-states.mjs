#!/usr/bin/env node
/**
 * Screenshot every design-capture state in the real Electron renderer, in light/dark, 1x/2x and reduced
 * motion, and write manifest.json (state id, sha256, commit and audit results) beside the images.
 *
 * Needs a renderer built with METIS_DESIGN_CAPTURE=1 (out/renderer/design-capture.html). CI-only: the
 * design-capture workflow runs it and uploads the output directory as an artifact.
 *
 * Usage: node scripts/design/capture-states.mjs [outdir]   (default: out-design-capture, git-ignored)
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assertPngSize,
  buildManifest,
  captureDeviceMetrics,
  captureFileName,
  captureMatrix,
  captureScreenshotRequest
} from './capture-manifest.mjs'
import { detectedFailureKinds } from './capture-audit.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const html = resolve(root, 'out', 'renderer', 'design-capture.html')
const outDir = resolve(process.argv[2] || join(root, 'out-design-capture'))
const commit = process.env.GITHUB_SHA || 'unknown'
const VIEWPORT = { width: 960, height: 640 }
const READY_TIMEOUT_MS = 15_000
const auditScript = join(here, 'capture-audit.mjs')
const NEGATIVE_CONTROL_STATE = 'audit-negative-control'

if (!existsSync(html)) {
  throw new Error(`Missing ${html}: build the renderer with METIS_DESIGN_CAPTURE=1 first`)
}
mkdirSync(outDir, { recursive: true })

const pageUrl = pathToFileURL(html).href
const shots = []
const failures = []
const negativeControl = { detected: false, kinds: [] }
let manifest
let app

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function auditErrorResult(kind, reason) {
  return {
    pass: false,
    text: { checked: 0, failures: [] },
    nonText: { checked: 0, failures: [] },
    clipping: { checked: 0, failures: [] },
    unverifiable: [{ kind, reason }]
  }
}

async function installAuditCollector(page) {
  await page.addScriptTag({ path: auditScript, type: 'module' })
  const installed = await page.evaluate(() => typeof window.__DESIGN_CAPTURE_AUDIT__?.collect === 'function')
  if (!installed) throw new Error('design capture audit collector was not installed')
}

async function collectAudit(page) {
  await installAuditCollector(page)
  return page.evaluate(() => window.__DESIGN_CAPTURE_AUDIT__.collect())
}

async function waitForStateReady(page, state) {
  await page.waitForSelector(`html[data-capture-ready="1"][data-capture-state="${state}"]`, {
    timeout: READY_TIMEOUT_MS
  })
}

function writeManifest() {
  manifest = buildManifest({ commit, platform: process.platform, shots, negativeControl })
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`wrote manifest.json (${manifest.entries.length} entries, commit ${commit})`)
}

app = await electron.launch({
  args: [join(here, 'capture-main.cjs')],
  bypassCSP: true,
  env: { ...process.env, METIS_DESIGN_CAPTURE_URL: pageUrl }
})

try {
  const page = await app.firstWindow()
  await page.waitForSelector('html[data-capture-ready]', { timeout: READY_TIMEOUT_MS })
  const states = await page.evaluate(() => window.__DESIGN_CAPTURE__.states)
  if (!Array.isArray(states) || states.length === 0) throw new Error('The page listed no design states')

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', captureDeviceMetrics(VIEWPORT, 1))

  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.goto(`${pageUrl}?state=${encodeURIComponent(NEGATIVE_CONTROL_STATE)}`)
    await waitForStateReady(page, NEGATIVE_CONTROL_STATE)
    let audit
    try {
      audit = await collectAudit(page)
    } catch (error) {
      audit = auditErrorResult('negative-control-collector', errorMessage(error))
      failures.push(`negative control (${theme}) collector failed: ${errorMessage(error)}`)
    }
    const kinds = detectedFailureKinds(audit)
    if (!['clipping', 'nonText', 'text'].every((kind) => kinds.includes(kind))) {
      failures.push(`negative control (${theme}) missed audit kinds: ${kinds.join(', ') || 'none'}`)
    }
    negativeControl.kinds = [...new Set([...negativeControl.kinds, ...kinds])].sort()
  }
  negativeControl.detected = ['clipping', 'nonText', 'text'].every((kind) => negativeControl.kinds.includes(kind))

  for (const row of captureMatrix()) {
    await page.emulateMedia({ colorScheme: row.theme, reducedMotion: row.motion })
    await cdp.send('Emulation.setDeviceMetricsOverride', captureDeviceMetrics(VIEWPORT, row.scale))
    for (const state of states) {
      const file = captureFileName(state, row)
      const path = join(outDir, file)
      try {
        await page.goto(`${pageUrl}?state=${encodeURIComponent(state)}`)
        await waitForStateReady(page, state)
        let audit
        try {
          audit = await collectAudit(page)
        } catch (error) {
          audit = auditErrorResult('collector', errorMessage(error))
          failures.push(`${file}: collector failed: ${errorMessage(error)}`)
        }
        const screenshot = await cdp.send('Page.captureScreenshot', captureScreenshotRequest(VIEWPORT, row.scale))
        writeFileSync(path, Buffer.from(screenshot.data, 'base64'))
        const bytes = readFileSync(path)
        assertPngSize(bytes, VIEWPORT, row.scale, file)
        shots.push({ state, ...row, file, bytes, audit })
        console.log(`wrote ${file}`)
      } catch (error) {
        failures.push(`${file}: ${errorMessage(error)}`)
      }
    }
  }
} catch (error) {
  failures.push(errorMessage(error))
} finally {
  writeManifest()
  await app.close()
}

if (manifest.entries.some((entry) => !entry.audit.pass)) {
  failures.push(
    `design capture audit failed with ${manifest.audit.failures} failure(s) and ${manifest.audit.unverifiable} unverifiable row(s)`
  )
}
if (failures.length > 0) throw new Error(failures.join('\n'))
