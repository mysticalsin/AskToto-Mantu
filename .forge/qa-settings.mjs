// Focused verify of the reworked Settings → AI provider picker on the packaged app.
// Uses --user-data-dir for a hermetic, fresh profile (Electron honors this switch; the APPDATA
// env override did NOT redirect userData in the earlier run).
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const EXE = 'D:/asktoto-wt/release/win-unpacked/AskToto.exe'
const OUT = 'D:/asktoto-wt/.forge/qa'
const UDD = 'D:/asktoto-wt/.forge/qa-udd-settings'
mkdirSync(OUT, { recursive: true })
try { rmSync(UDD, { recursive: true, force: true }) } catch {}

const app = await electron.launch({
  executablePath: EXE,
  args: [`--user-data-dir=${UDD}`],
  env: { ...process.env, ASKTOTO_DISABLE_CP: '1' },
  timeout: 90_000
})
const win = await app.firstWindow({ timeout: 90_000 })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(4500)

// Fresh profile → onboarding. Consent + continue, skip the tour to the main bar.
const consent = win.locator('input[type=checkbox]').first()
if (await consent.count()) {
  await consent.check().catch(() => {})
  await win.getByText('Continue without signing in').click({ timeout: 15000 }).catch(() => {})
  await win.waitForTimeout(600)
  for (let i = 0; i < 3; i++) { await win.getByRole('button', { name: /Next/ }).click({ timeout: 8000 }).catch(() => {}); await win.waitForTimeout(400) }
  // provider slide → "Decide later" so no provider is force-picked
  await win.getByText(/Decide later/).click({ timeout: 8000 }).catch(() => {})
  await win.waitForTimeout(500)
  await win.getByText('Get started').click({ timeout: 15000 }).catch(() => {})
  await win.waitForTimeout(1500)
}

// Open Settings → AI (tabs are role=tab; the label text is "AI")
await win.locator('[aria-label="Settings"]').click({ timeout: 15000 })
await win.waitForTimeout(1200)
let clicked = false
for (const loc of [win.getByRole('tab', { name: 'AI', exact: true }), win.locator('[role=tab]', { hasText: /^AI$/ }), win.getByText('AI', { exact: true })]) {
  if (await loc.count()) { await loc.first().click({ timeout: 8000 }).catch(() => {}); clicked = true; break }
}
await win.waitForTimeout(1200)

// Screenshot, then read the provider grid by its section heading + tile blurbs (aria-pressed alone
// also matches the mode-preset list on other tabs, so scope to the provider tiles).
await win.screenshot({ path: `${OUT}/SETTINGS-ai-top.png` })
const providerTiles = await win.evaluate(() => {
  const bodyText = document.body.innerText
  const heading = /Choose your AI provider/i.test(bodyText)
  // provider tiles: aria-pressed buttons whose first text line is a known provider label
  const KNOWN = /claude|anthropic|gpt|openai|grok|xai|gemini|google|kimi|deepseek|qwen|mistral|groq|nvidia|minimax|openrouter|custom/i
  const labels = [...document.querySelectorAll('button[aria-pressed]')]
    .map((b) => b.textContent.trim().split('\n')[0].slice(0, 30))
    .filter((l) => KNOWN.test(l))
  return { labels, heading }
})
console.log('tab clicked:', clicked)

// scroll down to capture the whole grid
await win.evaluate(() => {
  const sc = [...document.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== 'visible')
  if (sc) sc.scrollTop = sc.scrollHeight / 2
})
await win.waitForTimeout(500)
await win.screenshot({ path: `${OUT}/SETTINGS-ai-grid.png` })

const hasGrok = providerTiles.labels.some((l) => /grok/i.test(l))
const hasGPT = providerTiles.labels.some((l) => /gpt|openai/i.test(l))
const hasKimi = providerTiles.labels.some((l) => /kimi/i.test(l))
const hasClaude = providerTiles.labels.some((l) => /claude|anthropic/i.test(l))
const hasGemini = providerTiles.labels.some((l) => /gemini/i.test(l))

console.log(JSON.stringify({
  providerPickerHeadingVisible: providerTiles.heading,
  tileCount: providerTiles.labels.length,
  tiles: providerTiles.labels,
  hasClaude, hasGPT, hasGrok, hasKimi, hasGemini
}, null, 2))

await app.close()
try { rmSync(UDD, { recursive: true, force: true }) } catch {}
const ok = providerTiles.heading && hasGrok && hasGPT && hasKimi && hasClaude && hasGemini && providerTiles.labels.length >= 10
console.log(ok ? '\nPASS: open provider picker with all providers incl. Grok' : '\nFAIL: picker/providers incomplete')
process.exit(ok ? 0 : 1)
