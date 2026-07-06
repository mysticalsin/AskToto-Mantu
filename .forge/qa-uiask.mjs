// Definitive UI-driven Ask test: activate a provider by CLICKING its tile in the real picker
// (so React state + providerReady update exactly as for a user), then Ask through the Bar and wait
// for a real streamed answer. Picks whichever API provider already has a key in the machine env.
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const EXE = 'D:/asktoto-wt/release/win-unpacked/AskToto.exe'
const OUT = 'D:/asktoto-wt/.forge/qa'
const UDD = 'D:/asktoto-wt/.forge/qa-udd-uiask'
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

// Which API provider already has a usable key in the machine env?
const s0 = await win.evaluate(() => window.toto.getSettings())
const keyed = Object.entries(s0.hasKeys || {}).filter(([id, v]) => v && !['dust', 'claude-cli', 'codex-cli'].includes(id)).map(([id]) => id)
console.log('providers with a key present:', JSON.stringify(keyed), 'envKeys:', JSON.stringify(s0.envKeys))
if (!keyed.length) { console.log('RESULT: SKIP — no API key in env to drive a UI Ask (CLI-only machine). Ask pipeline unproven via this path.'); await app.close(); process.exit(3) }

// Map provider id → its visible tile label prefix
const LABEL = { anthropic: 'Claude', openai: 'GPT', grok: 'Grok', gemini: 'Gemini', kimi: 'Kimi', deepseek: 'DeepSeek', qwen: 'Qwen', groq: 'Groq', mistral: 'Mistral', nvidia: 'NVIDIA', minimax: 'MiniMax', openrouter: 'OpenRouter', custom: 'Custom' }
const target = keyed[0]
const label = LABEL[target] || target

// Open Settings → AI, click the target provider tile (real React patch)
await win.locator('[aria-label="Settings"]').click({ timeout: 15000 })
await win.waitForTimeout(1000)
await win.getByRole('tab', { name: 'AI', exact: true }).first().click({ timeout: 8000 }).catch(async () => { await win.locator('[role=tab]', { hasText: /^AI$/ }).first().click().catch(() => {}) })
await win.waitForTimeout(1000)
// scroll the picker into view and click the tile whose text starts with the label
const tile = win.locator('button[aria-pressed]', { hasText: new RegExp(label, 'i') }).first()
await tile.scrollIntoViewIfNeeded().catch(() => {})
await tile.click({ timeout: 8000 })
await win.waitForTimeout(800)
await win.screenshot({ path: `${OUT}/UIASK-picked.png` })

// Close settings (Done), confirm active provider + readiness via React-backed settings
const done = win.getByRole('button', { name: /^Done$/ })
if (await done.count()) await done.first().click().catch(() => {})
await win.waitForTimeout(1200)
const s1 = await win.evaluate(() => window.toto.getSettings())
console.log(`picked ${target} (${label}); provider=${s1.provider} ready=${s1.providerReady}`)

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
await win.screenshot({ path: `${OUT}/UIASK-answer.png` })
await app.close()
try { rmSync(UDD, { recursive: true, force: true }) } catch {}
if (/QA-OK-42/.test(last)) { console.log(`\nRESULT: PASS — UI-driven Ask via ${target} returned a real streamed answer.`); process.exit(0) }
console.log('\nRESULT: FAIL — provider=' + target + '. Tail: ' + last.slice(-260)); process.exit(1)
