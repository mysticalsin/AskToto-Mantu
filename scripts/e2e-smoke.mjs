// Physical end-to-end smoke test: launches the REAL built Electron app (real main + preload + IPC)
// in an isolated temp profile and drives it like a user — boot, onboarding, idle bar, minimize/expand,
// open panels — asserting each step and screenshotting. Run: node scripts/e2e-smoke.mjs
// Requires a prior `npm run build` (uses out/main/index.js).
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOT_DIR = process.env.E2E_SHOT_DIR || '/tmp'
const steps = []
let win, app
const ok = (name) => { steps.push({ name, ok: true }); console.log(`  ✓ ${name}`) }
const fail = (name, e) => { steps.push({ name, ok: false, err: String(e && e.message || e) }); console.log(`  ✗ ${name} — ${e && e.message || e}`) }
const shot = async (n) => { try { await win.screenshot({ path: join(SHOT_DIR, `e2e-${n}.png`) }) } catch {} }
const txt = async () => { try { return (await win.locator('body').innerText()).replace(/\s+/g, ' ').trim() } catch { return '' } }

const userDataDir = mkdtempSync(join(tmpdir(), 'metis-e2e-'))

try {
  console.log('Launching built app with isolated profile:', userDataDir)
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 30000
  })
  win = await app.firstWindow({ timeout: 30000 })
  ok('app launched + first window')
  await win.waitForLoadState('domcontentloaded').catch(() => {})

  // 1) Boot must not sit on the loader forever. Within 15s we should see either onboarding or the bar,
  //    never a stuck "Starting Métis…".
  await win.waitForFunction(
    () => { const t = document.body.innerText; return t && !/Starting Métis…/.test(t) && t.trim().length > 0 },
    { timeout: 15000 }
  ).then(() => ok('boot cleared the loading strip')).catch((e) => fail('boot cleared the loading strip (stuck loader?)', e))
  await shot('01-boot')
  let body = await txt()
  console.log('   after boot:', body.slice(0, 120))

  // 2) Onboarding (fresh profile shows it). Complete it: consent → continue → walk → Get started.
  if (/on-device AI copilot|Your on-device/i.test(body)) {
    ok('onboarding shown on first run')
    // consent checkbox
    const consent = win.locator('input[type=checkbox]').first()
    await consent.check({ timeout: 5000 }).then(() => ok('consent checkbox checked')).catch((e) => fail('check consent', e))
    // Continue without signing in
    const cont = win.locator('button', { hasText: /Continue without signing in/i }).first()
    await cont.click({ timeout: 5000 }).then(() => ok('clicked Continue (step1→2)')).catch((e) => fail('click Continue', e))
    await win.waitForTimeout(400)
    // Walk steps 2→6: click whichever advancing control is present, priority Get started > Decide later > Next.
    let finished = false
    for (let i = 0; i < 8 && !finished; i++) {
      const getStarted = win.locator('button:has-text("Get started")').first()
      const decideLater = win.locator('button:has-text("Decide later")').first()
      const next = win.locator('button:has-text("Next")').first()
      if (await getStarted.count()) {
        await getStarted.click({ timeout: 4000 }).then(() => { finished = true; ok('clicked Get started (finish)') }).catch((e) => fail('click Get started', e))
      } else if (await decideLater.count()) {
        await decideLater.click({ timeout: 4000 }).catch(() => {}); await win.waitForTimeout(400)
      } else if (await next.count()) {
        await next.click({ timeout: 4000 }).catch(() => {}); await win.waitForTimeout(400)
      } else { break }
    }
    if (!finished) fail('completed onboarding walk', new Error('never reached Get started'))
    await win.waitForTimeout(600)
    await shot('02-post-onboarding')
    body = await txt()
  } else {
    ok('no onboarding (profile already onboarded) — proceeding')
  }

  // 3) Idle bar must render — the ask input (its prompt is a placeholder, not innerText) + the toolbar.
  await win.waitForSelector('input[placeholder*="Ask anything"], input[placeholder*="Ask a follow-up"]', { timeout: 12000 })
    .then(() => ok('idle bar rendered (ask input present)')).catch((e) => fail('idle bar rendered', e))
  await win.locator('button:has-text("History")').first().count()
    .then((n) => n > 0 ? ok('toolbar rendered (History control)') : fail('toolbar rendered', new Error('no History control')))
    .catch((e) => fail('toolbar rendered', e))
  await shot('03-idle')

  // 4) Minimize → the window must actually shrink to the small pill.
  const before = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const minBtn = win.locator('button[aria-label="Minimize to a small pill"], button[title="Minimize to a small pill"]').first()
  if (await minBtn.count()) {
    await minBtn.click({ timeout: 4000 })
    await win.waitForTimeout(1200)
    const after = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    console.log(`   window ${before.w}x${before.h} → ${after.w}x${after.h}`)
    if (after.w < before.w && after.w <= 260) ok(`minimize shrank the window (${before.w}→${after.w}px wide)`)
    else fail('minimize shrank the window', new Error(`width ${before.w}→${after.w} (expected ≤260)`))
    await shot('04-minimized')
    // 5) Expand back via the Métis mark
    const expand = win.locator('button[aria-label="Expand Métis"], button[title="Expand Métis"]').first()
    if (await expand.count()) {
      await expand.click({ timeout: 4000 })
      await win.waitForTimeout(1000)
      const back = await win.evaluate(() => ({ w: window.innerWidth }))
      if (back.w > after.w) ok(`expand restored the bar (${after.w}→${back.w}px)`)
      else fail('expand restored the bar', new Error(`width stayed ${back.w}`))
      await shot('05-expanded')
    } else fail('find expand button', new Error('no Expand Métis button'))
  } else fail('find minimize button', new Error('no "Minimize to a small pill" button'))

  // 6) Renderer console errors (excluding known dev/ASR noise).
  const errs = []
  win.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
  await win.waitForTimeout(500)
  const realErrs = errs.filter((e) => !/asr-model|whisper|transformers|CORS|content-length|Failed to fetch/i.test(e))
  if (realErrs.length === 0) ok('no unexpected renderer console errors')
  else fail('renderer console errors', new Error(realErrs.slice(0, 3).join(' | ')))
} catch (e) {
  fail('fatal', e)
} finally {
  try { await app?.close() } catch {}
  const passed = steps.filter((s) => s.ok).length
  const failed = steps.filter((s) => !s.ok)
  console.log(`\n==== E2E: ${passed}/${steps.length} passed ====`)
  if (failed.length) { console.log('FAILURES:'); failed.forEach((f) => console.log(`  ✗ ${f.name} — ${f.err}`)) }
  process.exit(failed.length ? 1 : 0)
}
