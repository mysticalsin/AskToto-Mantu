#!/usr/bin/env node
/**
 * Compare every Settings section screenshot between two packaged Métis apps.
 *
 * This is hosted-runner QA only (D-28). It launches each installed app with a fresh onboarded profile,
 * opens the real Settings surface, walks every Settings tab, screenshots every rendered <section>, and
 * writes a content-free JSON report plus PNG artifacts. No meeting content, account ids, secrets, or local
 * user paths are recorded.
 *
 * Usage:
 *   node scripts/qa/settings-section-visual-compare.mjs <before executable> <after executable> <out dir>
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const READY_TIMEOUT_MS = 150_000
const CONNECT_TIMEOUT_MS = 30_000
const SETTINGS_TIMEOUT_MS = 30_000
const POLL_MS = 250
const VIEWPORT = Object.freeze({ width: 900, height: 820 })
const FIT_TOLERANCE_PX = 1

function usage() {
  console.error('Usage: node scripts/qa/settings-section-visual-compare.mjs <before executable> <after executable> <out dir>')
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function slug(value) {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'section'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fitsInside(inner, outer) {
  if (!inner || !outer) return false
  return (
    inner.x >= outer.x - FIT_TOLERANCE_PX
    && inner.y >= outer.y - FIT_TOLERANCE_PX
    && inner.x + inner.width <= outer.x + outer.width + FIT_TOLERANCE_PX
    && inner.y + inner.height <= outer.y + outer.height + FIT_TOLERANCE_PX
  )
}

function readAuditLog(profile) {
  try {
    return readFileSync(join(profile, 'logs', 'audit.log'), 'utf8')
  } catch {
    return ''
  }
}

function auditHas(profile, event) {
  return readAuditLog(profile).split('\n').some((line) => line.includes(`"event":"${event}"`))
}

async function freeLoopbackPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolvePort(address.port))
    })
  })
}

function seedProfile(profile) {
  const settings = {
    onboardingDone: true,
    onboardingDoneAt: 1_700_000_000_000,
    recordingConsent: true,
    overlayLayout: 'bar',
    autoHideOverlay: false,
    contentProtection: false
  }
  writeFileSync(join(profile, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
}

function sanitizeEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/_API_KEY$/i.test(key) || /TOKEN/i.test(key) || /SECRET/i.test(key)) delete env[key]
  }
  env.CI = '1'
  return env
}

async function waitForRendererReady(profile, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (auditHas(profile, 'app.renderer.ready')) return true
    if (child.exitCode !== null || child.signalCode !== null) return false
    await sleep(POLL_MS)
  }
  return false
}

async function findOverlayPage(browser) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (!page.isClosed() && page.url().startsWith('file:') && page.url().includes('/renderer/index.html')) {
          return page
        }
      }
    }
    await sleep(100)
  }
  throw new Error('overlay page not found')
}

async function settle(page) {
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve())
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await sleep(150)
}

async function openSettings(page) {
  await page.setViewportSize(VIEWPORT)
  await settle(page)
  const settingsButton = page.getByRole('button', { name: /^Settings$/ }).first()
  if (await settingsButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await settingsButton.click()
  } else {
    await page.evaluate(() => {
      const button = document.querySelector('button[aria-label="Settings"]')
      if (!(button instanceof HTMLElement)) throw new Error('Settings button not found')
      button.click()
    })
  }
  await page.getByRole('tab', { name: 'Brain' }).waitFor({ timeout: SETTINGS_TIMEOUT_MS })
  await settle(page)
}

async function captureSections(page, appOutDir) {
  await openSettings(page)
  const tabs = (await page.getByRole('tab').allTextContents()).map((label) => label.trim()).filter(Boolean)
  const sections = []

  for (const tab of tabs) {
    await page.getByRole('tab', { name: tab, exact: true }).click()
    await page.getByRole('tabpanel').waitFor({ timeout: SETTINGS_TIMEOUT_MS })
    await settle(page)

    const tabPanel = page.locator('main[role="tabpanel"]')
    const count = await tabPanel.locator('section').count()
    for (let index = 0; index < count; index += 1) {
      const section = tabPanel.locator('section').nth(index)
      await section.scrollIntoViewIfNeeded()
      await settle(page)
      const title = (await section.locator('xpath=.//div[contains(concat(" ", normalize-space(@class), " "), " font-semibold ")]').first().textContent({ timeout: 2_000 }).catch(() => null))?.trim()
        ?? `Section ${index + 1}`
      const key = `${slug(tab)}-${String(index + 1).padStart(2, '0')}-${slug(title)}`
      const file = join(appOutDir, `${key}.png`)
      const panelBox = await tabPanel.boundingBox()
      const box = await section.boundingBox()
      const buffer = await section.screenshot({ path: file, animations: 'disabled', caret: 'hide' })
      const clipped = !fitsInside(box, panelBox)
      sections.push({
        key,
        tab,
        index,
        title,
        width: box ? Math.round(box.width) : null,
        height: box ? Math.round(box.height) : null,
        viewportClipped: clipped,
        clipped,
        sha256: sha256(buffer),
        bytes: buffer.length,
        file: `${basename(appOutDir)}/${basename(file)}`
      })
    }
  }

  return sections
}

async function captureApp(label, executable, outDir) {
  if (!existsSync(executable)) throw new Error(`${label} executable does not exist`)
  const profile = mkdtempSync(join(tmpdir(), `metis-settings-visual-${label}-`))
  seedProfile(profile)
  const port = await freeLoopbackPort()
  const appOutDir = join(outDir, label)
  mkdirSync(appOutDir, { recursive: true })

  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    cwd: dirname(executable),
    env: { ...sanitizeEnv(), ASKTOTO_USERDATA: profile },
    stdio: 'ignore'
  })

  let browser = null
  try {
    const ready = await waitForRendererReady(profile, child)
    if (!ready) throw new Error(`${label} did not report app.renderer.ready`)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: CONNECT_TIMEOUT_MS })
    const page = await findOverlayPage(browser)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err instanceof Error ? err.message : String(err)))
    const sections = await captureSections(page, appOutDir)
    if (pageErrors.length > 0) throw new Error(`${label} renderer page error: ${pageErrors[0]}`)
    await page.evaluate(() => void window.toto.quit()).catch(() => undefined)
    return { label, status: 'CAPTURED', sectionCount: sections.length, sections }
  } finally {
    await browser?.close().catch(() => undefined)
    const deadline = Date.now() + 10_000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(POLL_MS)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
  }
}

function compare(before, after) {
  const rows = []
  const beforeByKey = new Map(before.sections.map((section) => [section.key, section]))
  const afterByKey = new Map(after.sections.map((section) => [section.key, section]))
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort()

  for (const key of keys) {
    const left = beforeByKey.get(key)
    const right = afterByKey.get(key)
    const failures = []
    if (!left) failures.push('missing_before')
    if (!right) failures.push('missing_after')
    if (left && right) {
      if (left.title !== right.title || left.tab !== right.tab || left.index !== right.index) failures.push('identity_changed')
      if (left.width !== right.width || left.height !== right.height) failures.push('dimensions_changed')
      if (left.sha256 !== right.sha256) failures.push('pixels_changed')
    }
    if (left?.clipped || right?.clipped) failures.push('clipped')
    rows.push({
      key,
      tab: left?.tab ?? right?.tab ?? null,
      title: left?.title ?? right?.title ?? null,
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      failures,
      before: left ? { sha256: left.sha256, bytes: left.bytes, width: left.width, height: left.height, clipped: left.clipped, file: left.file } : null,
      after: right ? { sha256: right.sha256, bytes: right.bytes, width: right.width, height: right.height, clipped: right.clipped, file: right.file } : null
    })
  }

  const failures = rows.filter((row) => row.status !== 'PASS')
  return {
    status: failures.length === 0 && before.sectionCount > 0 && before.sectionCount === after.sectionCount ? 'PASS' : 'FAIL',
    sectionCount: { before: before.sectionCount, after: after.sectionCount },
    rows
  }
}

function formatFailureSummary(report) {
  if (report.result === 'pass') {
    return `settings-section-visual-compare sections=${report.comparison.sectionCount.before}`
  }
  if (report.error) return `settings-section-visual-compare error=${report.error}`
  const rows = report.comparison?.rows?.filter((row) => row.status !== 'PASS') ?? []
  const lines = [
    `settings-section-visual-compare failures=${rows.length} sectionCount=${JSON.stringify(report.comparison?.sectionCount ?? null)}`
  ]
  for (const row of rows.slice(0, 20)) {
    lines.push([
      `- ${row.key}`,
      `failures=${row.failures.join(',')}`,
      `before=${row.before ? `${row.before.width}x${row.before.height} ${row.before.file}` : 'missing'}`,
      `after=${row.after ? `${row.after.width}x${row.after.height} ${row.after.file}` : 'missing'}`
    ].join(' '))
  }
  if (rows.length > 20) lines.push(`- ${rows.length - 20} more failing rows in settings-section-visual-compare.json`)
  return lines.join('\n')
}

async function main() {
  const [beforeExecutable, afterExecutable, outArg] = process.argv.slice(2)
  if (!beforeExecutable || !afterExecutable || !outArg) {
    usage()
    process.exit(2)
  }

  const outDir = resolve(outArg)
  mkdirSync(outDir, { recursive: true })
  const startedAt = new Date().toISOString()
  let report
  try {
    const before = await captureApp('before', resolve(beforeExecutable), outDir)
    const after = await captureApp('after', resolve(afterExecutable), outDir)
    const comparison = compare(before, after)
    report = {
      schema: 'metis.settings-section-visual-compare.v1',
      startedAt,
      finishedAt: new Date().toISOString(),
      result: comparison.status === 'PASS' ? 'pass' : 'fail',
      platform: process.platform,
      viewport: VIEWPORT,
      notes: ['ExpandableSection bodies are captured in their default collapsed state.'],
      captures: [
        { label: before.label, status: before.status, sectionCount: before.sectionCount },
        { label: after.label, status: after.status, sectionCount: after.sectionCount }
      ],
      comparison
    }
  } catch (err) {
    report = {
      schema: 'metis.settings-section-visual-compare.v1',
      startedAt,
      finishedAt: new Date().toISOString(),
      result: 'fail',
      platform: process.platform,
      error: err instanceof Error ? err.message : String(err)
    }
  }

  writeFileSync(join(outDir, 'settings-section-visual-compare.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`settings-section-visual-compare result=${report.result}`)
  if (report.result === 'pass') {
    console.log(formatFailureSummary(report))
  } else {
    console.error(formatFailureSummary(report))
  }
  process.exit(report.result === 'pass' ? 0 : 1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err)
    process.exit(1)
  })
}

export { compare, fitsInside, formatFailureSummary }
