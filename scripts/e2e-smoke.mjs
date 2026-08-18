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

  // 2) Onboarding (fresh profile shows it). Drive it the way a user does, to completion.
  //
  // Rewritten 2026-08-17. The previous version hard-coded an older wizard — a consent checkbox on the
  // FIRST scene, then "Continue without signing in", then Next/Decide later/Get started — and failed 6
  // of 10 steps against the shipped flow, which is: Begin → Set me up → Continue → [pick a mode AND tick
  // the recording-consent box] → Start → provider choice → readiness → the bar. Verified by driving a
  // real fresh profile: onboardingDone flips true and the ask input appears.
  //
  // Two things made the old script wrong in ways worth not repeating:
  //   - the consent checkbox moved to the LAST scene, where it gates `Start` (`disabled={!consent}` in
  //     OnboardingExperience.tsx) — it is a legal affirmation, not a formality, so the driver must tick
  //     it rather than route around it;
  //   - Playwright's actionability checks time out on this window (it renders hidden from screen share),
  //     so `.click()`/`.check()` never fire. Dispatch through the DOM instead; React's handlers run fine.
  // Rather than re-encode a scene list that will drift again, this walks generically: satisfy any gate
  // (an unchecked checkbox), then click the last enabled non-destructive control, until the bar appears.
  if (/on-device AI copilot|Your on-device|on-device meeting copilot/i.test(body)) {
    ok('onboarding shown on first run')
    const advance = () =>
      win.evaluate(() => {
        // React tracks input state internally, so a bare `.checked = true` is invisible to it — go
        // through the native setter and dispatch, the standard workaround.
        for (const cb of document.querySelectorAll('input[type=checkbox]')) {
          if (!cb.checked) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set
            setter.call(cb, true)
            cb.dispatchEvent(new Event('click', { bubbles: true }))
            cb.dispatchEvent(new Event('change', { bubbles: true }))
            return 'consent'
          }
        }
        const skip = /quit|reset|^back$|cancel|sign in with microsoft|skip the tour/i
        const enabled = [...document.querySelectorAll('button')].filter(
          (b) => (b.textContent || '').trim() && !skip.test(b.textContent) && !b.disabled
        )
        if (!enabled.length) return null
        const el = enabled[enabled.length - 1] // the primary control sits last in each scene
        const label = el.textContent.trim().slice(0, 40)
        el.click()
        return label
      })
    let finished = false
    const trail = []
    for (let i = 0; i < 20 && !finished; i++) {
      finished = await win.evaluate(async () => (await window.toto.getSettings()).onboardingDone === true)
      if (finished) break
      const did = await advance()
      if (!did) break
      trail.push(did)
      await win.waitForTimeout(900)
    }
    if (finished) ok(`completed the onboarding walk (${trail.length} actions: ${trail.join(' → ')})`)
    else fail('completed onboarding walk', new Error(`stuck after: ${trail.join(' → ') || '(no actionable control)'}`))
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
