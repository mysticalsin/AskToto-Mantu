// Live-validate the two R1 BLOCKER fixes on the packaged app:
// (1) Custom provider tile sticks + shows the base-URL field (was silently reverting to Anthropic).
// (2) Screen capture works by default (content protection no longer blocks own capture).
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const EXE = 'D:/asktoto-wt/release/win-unpacked/AskToto.exe'
const OUT = 'D:/asktoto-wt/.forge/qa'
const UDD = 'D:/asktoto-wt/.forge/qa-udd-blockers'
mkdirSync(OUT, { recursive: true })
try { rmSync(UDD, { recursive: true, force: true }) } catch {}

const app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${UDD}`], env: { ...process.env, ASKTOTO_DISABLE_CP: '1' }, timeout: 90_000 })
const win = await app.firstWindow({ timeout: 90_000 })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(4500)
const results = []
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`) }

// Onboard to bar
await win.locator('input[type=checkbox]').first().check()
await win.getByText('Continue without signing in').click({ timeout: 15000 })
await win.waitForTimeout(500)
for (let i = 0; i < 3; i++) { await win.getByRole('button', { name: /Next/ }).click({ timeout: 8000 }).catch(() => {}); await win.waitForTimeout(350) }
await win.getByText(/Decide later/).click({ timeout: 8000 }).catch(() => {})
await win.getByText('Get started').click({ timeout: 15000 })
await win.locator('[aria-label="Ask AskToto anything"]').waitFor({ timeout: 20000 })

// BLOCKER 1: Custom provider sticks
await win.locator('[aria-label="Settings"]').click({ timeout: 15000 })
await win.waitForTimeout(1000)
await win.getByRole('tab', { name: 'AI', exact: true }).first().click({ timeout: 8000 }).catch(async () => { await win.locator('[role=tab]', { hasText: /^AI$/ }).first().click().catch(() => {}) })
await win.waitForTimeout(1000)
const customTile = win.locator('button[aria-pressed]', { hasText: /Custom/i }).first()
await customTile.scrollIntoViewIfNeeded().catch(() => {})
await customTile.click({ timeout: 8000 })
await win.waitForTimeout(1200)
const afterCustom = await win.evaluate(() => window.toto.getSettings())
const baseUrlField = await win.evaluate(() => !!document.querySelector('input[placeholder*="http" i], input[placeholder*="base" i], input[placeholder*="URL" i]'))
rec('blocker1-custom-provider-sticks', afterCustom.provider === 'custom', `provider after click = ${afterCustom.provider} (expected custom); base-URL field visible=${baseUrlField}`)

// close settings
const done = win.getByRole('button', { name: /^Done$/ })
if (await done.count()) await done.first().click().catch(() => {})
await win.waitForTimeout(800)

// BLOCKER 2: capture works with content protection default-on.
// Re-launch WITHOUT ASKTOTO_DISABLE_CP so contentProtection default (true) is active, then call capture().
await app.close()
const app2 = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${UDD}`], env: { ...process.env }, timeout: 90_000 })
const win2 = await app2.firstWindow({ timeout: 90_000 })
await win2.waitForLoadState('domcontentloaded')
await win2.waitForTimeout(4500)
const cap = await win2.evaluate(async () => {
  const s = await window.toto.getSettings()
  try {
    const shot = await window.toto.capture()
    return { contentProtection: s.contentProtection, ok: !!(shot && shot.image), imageLen: shot?.image ? String(shot.image).length : 0 }
  } catch (e) {
    return { contentProtection: s.contentProtection, ok: false, error: String(e).slice(0, 160) }
  }
})
rec('blocker2-capture-works-with-cp-on', cap.ok, `contentProtection=${cap.contentProtection}; capture ok=${cap.ok} imageLen=${cap.imageLen} ${cap.error || ''}`)
await app2.close()
try { rmSync(UDD, { recursive: true, force: true }) } catch {}

const fails = results.filter((r) => !r.ok)
console.log(`\n${results.length - fails.length}/${results.length} PASS`)
process.exit(fails.length ? 1 : 0)
