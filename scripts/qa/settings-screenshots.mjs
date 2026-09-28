#!/usr/bin/env node
/**
 * Capture and compare packaged Settings sections on hosted CI.
 *
 * Usage:
 *   node scripts/qa/settings-screenshots.mjs capture <installed-app> <out-dir>
 *   node scripts/qa/settings-screenshots.mjs compare <before-dir> <after-dir> <report-json>
 *
 * The capture mode launches an installed Electron app with an isolated ASKTOTO_USERDATA profile and
 * DevTools enabled, opens Settings, visits every tab, and writes one PNG per tab plus manifest.json.
 * The compare mode is deliberately byte-strict: M2-0071 is a pure move, so every corresponding PNG must
 * hash identically. If a hosted runner cannot exercise a surface, it records BLOCKED_EXTERNAL with the
 * exact unblock step instead of inventing a pass.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const SETTINGS_TABS = Object.freeze([
  'Modes & Display',
  'AI',
  'Speech',
  'Calendar',
  'Meetings',
  'Brain',
  'Privacy',
  'Identity',
  'About'
])

const READY_TIMEOUT_MS = 150_000
const TAB_TIMEOUT_MS = 15_000

function usage() {
  console.error('usage: settings-screenshots.mjs capture <installed-app> <out-dir> | compare <before-dir> <after-dir> <report-json>')
  process.exit(2)
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('could not allocate a TCP port')))
        return
      }
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

function executableFor(appPath) {
  const absolute = resolve(appPath)
  if (process.platform === 'darwin' && absolute.endsWith('.app')) {
    return join(absolute, 'Contents', 'MacOS', 'Metis')
  }
  return absolute
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

async function waitForOverlayPage(browser) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith('file:') && page.url().endsWith('/renderer/index.html')) return page
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error('renderer page did not appear before timeout')
}

async function capture(appPath, outDir) {
  const out = resolve(outDir)
  mkdirSync(out, { recursive: true })
  const port = await freePort()
  const userData = mkdtempSync(join(tmpdir(), 'metis-settings-screens-'))
  const exe = executableFor(appPath)
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ASKTOTO_USERDATA: userData,
      ASKTOTO_DISABLE_CP: '1',
      METIS_DISABLE_UPDATE_CHECK: '1'
    }
  })
  let browser
  const manifest = {
    platform: process.platform,
    app: basename(appPath),
    userData: basename(userData),
    tabs: [],
    blocked: []
  }

  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: READY_TIMEOUT_MS })
    const page = await waitForOverlayPage(browser)
    await page.bringToFront()
    const settingsButton = page.getByRole('button', { name: /^Settings$/ }).first()
    await settingsButton.click({ timeout: TAB_TIMEOUT_MS })
    await page.getByText('Settings', { exact: true }).first().waitFor({ timeout: TAB_TIMEOUT_MS })

    for (const tab of SETTINGS_TABS) {
      await page.getByRole('button', { name: tab }).click({ timeout: TAB_TIMEOUT_MS })
      await page.waitForTimeout(250)
      const path = join(out, `${slug(tab)}.png`)
      await page.screenshot({ path, fullPage: true })
      manifest.tabs.push({ tab, file: basename(path), sha256: sha256(path) })
    }
  } catch (error) {
    manifest.blocked.push({
      status: 'BLOCKED_EXTERNAL',
      reason: error instanceof Error ? error.message : String(error),
      unblock: 'Run this workflow on a hosted runner with a packaged app that can reach the Settings button.'
    })
  } finally {
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    if (browser) await browser.close().catch(() => {})
    if (!child.killed) {
      child.kill()
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    }
  }

  if (manifest.blocked.length > 0) process.exitCode = 1
}

async function compare(beforeDir, afterDir, reportJson) {
  const before = resolve(beforeDir)
  const after = resolve(afterDir)
  const reportPath = resolve(reportJson)
  mkdirSync(dirname(reportPath), { recursive: true })
  const beforeFiles = (await readdir(before)).filter((name) => name.endsWith('.png')).sort()
  const rows = []
  for (const file of beforeFiles) {
    const beforePath = join(before, file)
    const afterPath = join(after, file)
    const beforeHash = sha256(beforePath)
    const afterHash = existsSync(afterPath) ? sha256(afterPath) : null
    rows.push({
      file,
      beforeSha256: beforeHash,
      afterSha256: afterHash,
      identical: beforeHash === afterHash
    })
  }
  const report = {
    status: rows.length === SETTINGS_TABS.length && rows.every((row) => row.identical) ? 'PASS' : 'FAIL',
    expectedTabs: SETTINGS_TABS,
    rows
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (report.status !== 'PASS') process.exitCode = 1
}

const [mode, a, b, c] = process.argv.slice(2)
if (mode === 'capture' && a && b && !c) {
  await capture(a, b)
} else if (mode === 'compare' && a && b && c) {
  await compare(a, b, c)
} else {
  usage()
}
