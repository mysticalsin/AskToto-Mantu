// Real API-key Ask, end-to-end through the UI: pick Kimi in the picker, paste a real key, Save,
// wait for readiness, Ask, expect the exact reply. The key is read from a file OUTSIDE the repo
// (path in KIMI_KEY_FILE) so this script never contains a secret. The app stores the key encrypted
// via safeStorage; we delete the profile after.
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'

const EXE = 'D:/asktoto-wt/release/win-unpacked/AskToto.exe'
const OUT = 'D:/asktoto-wt/.forge/qa'
const UDD = 'D:/asktoto-wt/.forge/qa-udd-kimi'
const KEY = readFileSync(process.env.KIMI_KEY_FILE, 'utf8').trim()
mkdirSync(OUT, { recursive: true })
try { rmSync(UDD, { recursive: true, force: true }) } catch {}

const app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${UDD}`], env: { ...process.env, ASKTOTO_DISABLE_CP: '1' }, timeout: 90_000 })
const win = await app.firstWindow({ timeout: 90_000 })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(4500)

// Onboard to the bar
await win.locator('input[type=checkbox]').first().check()
await win.getByText('Continue without signing in').click({ timeout: 15000 })
await win.waitForTimeout(500)
for (let i = 0; i < 3; i++) { await win.getByRole('button', { name: /Next/ }).click({ timeout: 8000 }).catch(() => {}); await win.waitForTimeout(350) }
await win.getByText(/Decide later/).click({ timeout: 8000 }).catch(() => {})
await win.getByText('Get started').click({ timeout: 15000 })
await win.locator('[aria-label="Ask AskToto anything"]').waitFor({ timeout: 20000 })

// Settings → AI → click the Kimi tile (real React patch), paste key, Save
await win.locator('[aria-label="Settings"]').click({ timeout: 15000 })
await win.waitForTimeout(1000)
await win.getByRole('tab', { name: 'AI', exact: true }).first().click({ timeout: 8000 }).catch(async () => { await win.locator('[role=tab]', { hasText: /^AI$/ }).first().click().catch(() => {}) })
await win.waitForTimeout(1000)
const tile = win.locator('button[aria-pressed]', { hasText: /Kimi/i }).first()
await tile.scrollIntoViewIfNeeded().catch(() => {})
await tile.click({ timeout: 8000 })
await win.waitForTimeout(700)
const keyInput = win.locator('input[type=password]').first()
await keyInput.waitFor({ timeout: 8000 })
await keyInput.fill(KEY)
await win.getByRole('button', { name: /^Save$/ }).first().click({ timeout: 8000 })
await win.waitForTimeout(1500)
await win.screenshot({ path: `${OUT}/KIMI-saved.png` })

// Poll readiness (auto-detect should set provider=kimi; key saved → providerReady)
let s = {}, ready = false, tries = 0
while (!ready && tries++ < 40) { s = await win.evaluate(() => window.toto.getSettings()); ready = s.providerReady && /kimi/.test(s.provider); if (!ready) await win.waitForTimeout(300) }
console.log(`after save: provider=${s.provider} ready=${s.providerReady} hasKimiKey=${s.hasKeys?.kimi}`)

const done = win.getByRole('button', { name: /^Done$/ })
if (await done.count()) await done.first().click().catch(() => {})
await win.waitForTimeout(1200)

// Ask through the Bar
const inp = win.locator('[aria-label="Ask AskToto anything"]')
await inp.click(); await inp.fill('Reply with exactly QA-OK-42 and nothing else.'); await inp.press('Enter')
const end = Date.now() + 150_000
let last = ''
while (Date.now() < end) {
  last = (await win.evaluate(() => document.body.innerText)).replace('Reply with exactly QA-OK-42 and nothing else.', '')
  if (/QA-OK-42/.test(last)) break
  await win.waitForTimeout(2500)
}
await win.screenshot({ path: `${OUT}/KIMI-answer.png` })
await app.close()
try { rmSync(UDD, { recursive: true, force: true }) } catch {}   // wipes the encrypted key with the profile
if (/QA-OK-42/.test(last)) { console.log('\nRESULT: PASS — real Kimi API key, picked in UI, answered end-to-end.'); process.exit(0) }
console.log('\nRESULT: FAIL — provider=' + s.provider + ' ready=' + s.providerReady + '. Tail: ' + last.slice(-260)); process.exit(1)
