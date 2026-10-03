#!/usr/bin/env node
/**
 * Screenshot every design-capture state in the real Electron renderer, in light/dark, 1x/2x and reduced
 * motion, each at the viewport the page lists for it, and write manifest.json (state id, viewport, sha256,
 * commit) beside the images.
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
import { assertPngSize, buildManifest, captureFileName, captureMatrix, captureStates } from './capture-manifest.mjs'
import { detectedFailureKinds } from './capture-audit.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const html = resolve(root, 'out', 'renderer', 'design-capture.html')
const outDir = resolve(process.argv[2] || join(root, 'out-design-capture'))
const commit = process.env.GITHUB_SHA || 'unknown'
// Each listed state brings its own viewport from the page; the QA negative control is not listed and keeps
// the placeholder states' size.
const NEGATIVE_CONTROL_VIEWPORT = { width: 960, height: 640 }
const READY_TIMEOUT_MS = 15_000
const auditScript = join(here, 'capture-audit.mjs')
const NEGATIVE_CONTROL_STATE = 'audit-negative-control'
const NEGATIVE_CONTROL_ROW = { theme: 'light', scale: 1, motion: 'reduce' }

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
  const states = captureStates(await page.evaluate(() => window.__DESIGN_CAPTURE__.states))

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    ...NEGATIVE_CONTROL_VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false
  })

  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: NEGATIVE_CONTROL_ROW.motion })
    await page.goto(`${pageUrl}?state=${encodeURIComponent(NEGATIVE_CONTROL_STATE)}`)
    await page.waitForSelector('html[data-capture-ready="1"]', { timeout: READY_TIMEOUT_MS })
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
    for (const { id: state, viewport } of states) {
      const file = captureFileName(state, row)
      const path = join(outDir, file)
      try {
        // Set before navigating, so layout, media queries and the audit all see this state's viewport.
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          ...viewport,
          deviceScaleFactor: row.scale,
          mobile: false
        })
        await page.goto(`${pageUrl}?state=${encodeURIComponent(state)}`)
        await page.waitForSelector('html[data-capture-ready="1"]', { timeout: READY_TIMEOUT_MS })
        let audit
        try {
          audit = await collectAudit(page)
        } catch (error) {
          audit = auditErrorResult('collector', errorMessage(error))
          failures.push(`${file}: collector failed: ${errorMessage(error)}`)
        }
        await page.screenshot({ path })
        const bytes = readFileSync(path)
        assertPngSize(bytes, viewport, row.scale, file)
        shots.push({ state, viewport, ...row, file, bytes, audit })
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
