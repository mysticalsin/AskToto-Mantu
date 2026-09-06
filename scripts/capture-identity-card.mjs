#!/usr/bin/env node
/**
 * Screenshot the Métis member pass harness (front, back, tilt).
 * Usage: node scripts/capture-identity-card.mjs [outdir]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const html = pathToFileURL(resolve(here, 'identity-card-harness.html')).href
const out = resolve(process.argv[2] || '/opt/cursor/artifacts')
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage']
})
const page = await browser.newPage({ viewport: { width: 440, height: 900 }, deviceScaleFactor: 2 })
await page.goto(html, { waitUntil: 'networkidle' })

async function shot(name, clickId) {
  if (clickId) await page.click(`#${clickId}`)
  await page.waitForTimeout(220)
  const path = resolve(out, name)
  await page.screenshot({ path, fullPage: true })
  console.log(`wrote ${path}`)
}

await shot('identity_card_front.png', 'front')
await shot('identity_card_back.png', 'back')
await shot('identity_card_tilt.png', 'tilt')
await page.click('#front')
await page.click('#activate')
await page.waitForTimeout(160)
const surface = resolve(out, 'identity_settings_surface.png')
await page.screenshot({ path: surface, fullPage: true })
console.log(`wrote ${surface}`)
await browser.close()
