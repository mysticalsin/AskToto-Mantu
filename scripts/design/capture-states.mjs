#!/usr/bin/env node
/**
 * Screenshot every design-capture state in the real Electron renderer, in light/dark, 1x/2x and reduced
 * motion, and write manifest.json (state id, sha256, commit) beside the images.
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
import { assertPngSize, buildManifest, captureFileName, captureMatrix } from './capture-manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const html = resolve(root, 'out', 'renderer', 'design-capture.html')
const outDir = resolve(process.argv[2] || join(root, 'out-design-capture'))
const commit = process.env.GITHUB_SHA || 'unknown'
const VIEWPORT = { width: 960, height: 640 }
const READY_TIMEOUT_MS = 15_000

if (!existsSync(html)) {
  throw new Error(`Missing ${html}: build the renderer with METIS_DESIGN_CAPTURE=1 first`)
}
mkdirSync(outDir, { recursive: true })

const pageUrl = pathToFileURL(html).href
const app = await electron.launch({
  args: [join(here, 'capture-main.cjs')],
  env: { ...process.env, METIS_DESIGN_CAPTURE_URL: pageUrl }
})

try {
  const page = await app.firstWindow()
  await page.waitForSelector('html[data-capture-ready]', { timeout: READY_TIMEOUT_MS })
  const states = await page.evaluate(() => window.__DESIGN_CAPTURE__.states)
  if (!Array.isArray(states) || states.length === 0) throw new Error('The page listed no design states')

  const cdp = await page.context().newCDPSession(page)
  const shots = []
  for (const row of captureMatrix()) {
    await page.emulateMedia({ colorScheme: row.theme, reducedMotion: row.motion })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...VIEWPORT,
      deviceScaleFactor: row.scale,
      mobile: false
    })
    for (const state of states) {
      await page.goto(`${pageUrl}?state=${encodeURIComponent(state)}`)
      await page.waitForSelector('html[data-capture-ready="1"]', { timeout: READY_TIMEOUT_MS })
      const file = captureFileName(state, row)
      const path = join(outDir, file)
      await page.screenshot({ path })
      const bytes = readFileSync(path)
      assertPngSize(bytes, VIEWPORT, row.scale, file)
      shots.push({ state, ...row, file, bytes })
      console.log(`wrote ${file}`)
    }
  }

  const manifest = buildManifest({ commit, platform: process.platform, shots })
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`wrote manifest.json (${manifest.entries.length} entries, commit ${commit})`)
} finally {
  await app.close()
}
