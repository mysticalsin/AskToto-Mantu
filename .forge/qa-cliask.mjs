// Isolate the CLI-Ask question: connect claude-cli, set it active, POLL until providerReady flips,
// then ask and wait for the real answer. Distinguishes a harness timing gap from a real gate bug.
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const EXE = 'D:/asktoto-wt/release/win-unpacked/AskToto.exe'
const OUT = 'D:/asktoto-wt/.forge/qa'
const UDD = 'D:/asktoto-wt/.forge/qa-udd-cliask'
mkdirSync(OUT, { recursive: true })
try { rmSync(UDD, { recursive: true, force: true }) } catch {}

const app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${UDD}`], env: { ...process.env, ASKTOTO_DISABLE_CP: '1' }, timeout: 90_000 })
const win = await app.firstWindow({ timeout: 90_000 })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(4500)

// Onboard to the bar quickly (consent + continue + skip tour + decide later + finish)
await win.locator('input[type=checkbox]').first().check()
await win.getByText('Continue without signing in').click({ timeout: 15000 })
await win.waitForTimeout(500)
for (let i = 0; i < 3; i++) { await win.getByRole('button', { name: /Next/ }).click({ timeout: 8000 }).catch(() => {}); await win.waitForTimeout(350) }
await win.getByText(/Decide later/).click({ timeout: 8000 }).catch(() => {})
await win.getByText('Get started').click({ timeout: 15000 })
await win.locator('[aria-label="Ask AskToto anything"]').waitFor({ timeout: 20000 })

// Connect claude-cli via real cliTest, set active, POLL providerReady.
const connect = await win.evaluate(async () => {
  const det = await window.toto.cliDetect('claude-cli')
  const test = det.ok ? await window.toto.cliTest('claude-cli') : { ok: false }
  await window.toto.setSettings({ provider: 'claude-cli' })
  // poll main-derived providerReady
  let ready = false, tries = 0, s
  while (!ready && tries++ < 40) { s = await window.toto.getSettings(); ready = s.providerReady; if (!ready) await new Promise((r) => setTimeout(r, 250)) }
  return { detOk: det.ok, testOk: test.ok, provider: s.provider, ready, connected: s.cliConnected }
})
console.log('connect:', JSON.stringify(connect))
if (!connect.ready) { console.log('\nRESULT: providerReady never flipped after CLI connect + activate → real gate bug'); await app.close(); process.exit(2) }

// Let React re-render off the settings change, then ask.
await win.waitForTimeout(1500)
const inp = win.locator('[aria-label="Ask AskToto anything"]')
await inp.click(); await inp.fill('Reply with exactly QA-OK-42 and nothing else.'); await inp.press('Enter')
const end = Date.now() + 180_000
let last = ''
while (Date.now() < end) {
  last = (await win.evaluate(() => document.body.innerText)).replace('Reply with exactly QA-OK-42 and nothing else.', '')
  if (/QA-OK-42/.test(last)) break
  if (/finish steps|Dust CLI above|Connect an AI provider/i.test(last)) { await win.waitForTimeout(1500); continue }
  await win.waitForTimeout(2500)
}
await win.screenshot({ path: `${OUT}/CLIASK-answer.png` })
await app.close()
try { rmSync(UDD, { recursive: true, force: true }) } catch {}
if (/QA-OK-42/.test(last)) { console.log('\nRESULT: PASS — CLI Ask works end-to-end once providerReady is true. Earlier fail was harness timing.'); process.exit(0) }
console.log('\nRESULT: FAIL — providerReady true but Ask still blocked. Tail: ' + last.slice(-300)); process.exit(1)
