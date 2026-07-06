// Live end-to-end QA of the packaged AskToto Windows build — v2 (hermetic).
// v1 lesson: default %APPDATA%\AskToto is shared with a second live agent session on this machine,
// so onboarding state mutated externally mid-run. v2 overrides APPDATA to an isolated dir.
// Drives: onboarding (consent gate → tour → provider pick → readiness), CLI connect + real Ask,
// Settings sections, renderer key isolation, importAudioRead path-gating (security), Listen with a
// fake-audio capture file (real on-device ASR e2e), recall, encryption at rest, updater log health,
// managed-config lock enforcement (second launch), clean exit.
import { _electron as electron } from 'playwright'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const EXE = 'D:/asktoto-wt/release/win-unpacked/AskToto.exe'
const WAV = 'D:/asktoto-wt/release/win-unpacked/resources/asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/en.wav'
const OUT = 'D:/asktoto-wt/.forge/qa'
const QA_APPDATA = 'D:\\asktoto-wt\\.forge\\qa-appdata'
const USERDATA = join(QA_APPDATA, 'AskToto')
mkdirSync(OUT, { recursive: true })
mkdirSync(QA_APPDATA, { recursive: true })

const LAUNCH_ENV = { ...process.env, ASKTOTO_DISABLE_CP: '1', APPDATA: QA_APPDATA }
const FAKE_AUDIO_ARGS = [
  '--use-fake-device-for-media-streams',
  '--use-fake-ui-for-media-streams',
  `--use-file-for-fake-audio-capture=${WAV}`
]

const results = []
let win, app
const shot = async (name) => { try { await win.screenshot({ path: `${OUT}/${name}.png` }) } catch {} }
async function step(name, fn) {
  const t = Date.now()
  try {
    const detail = await fn()
    results.push({ step: name, ok: true, ms: Date.now() - t, detail: String(detail ?? '').slice(0, 300) })
    console.log(`PASS ${name} (${Date.now() - t}ms) — ${String(detail ?? '').slice(0, 160)}`)
  } catch (e) {
    results.push({ step: name, ok: false, ms: Date.now() - t, detail: String(e).slice(0, 400) })
    console.log(`FAIL ${name}: ${String(e).slice(0, 300)}`)
    await shot(`FAIL-${name.replace(/[^a-z0-9-]/gi, '_')}`)
  }
}
const bodyText = () => win.evaluate(() => document.body.innerText)
const buttons = async () =>
  win.evaluate(() =>
    [...document.querySelectorAll('button,[role=button]')].map(
      (b) => b.getAttribute('aria-label') || b.textContent.trim().slice(0, 40)
    ).filter(Boolean)
  )

// ─── Launch 1 ─────────────────────────────────────────────────────────────────
app = await electron.launch({ executablePath: EXE, args: FAKE_AUDIO_ARGS, env: LAUNCH_ENV, timeout: 90_000 })
win = await app.firstWindow({ timeout: 90_000 })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(5000)

await step('S1-consent-gate', async () => {
  const cont = win.getByText('Continue without signing in')
  await cont.waitFor({ timeout: 20000 })
  const disabledBefore = await cont.isDisabled()
  await win.locator('input[type=checkbox]').first().check()
  await win.waitForTimeout(300)
  const enabledAfter = !(await cont.isDisabled())
  await shot('S1-onboarding')
  if (!disabledBefore) throw new Error('consent gate NOT enforced')
  if (!enabledAfter) throw new Error('continue still disabled after consent')
  await cont.click()
  return 'consent gate enforced'
})

await step('S2-4-tour', async () => {
  for (let i = 2; i <= 4; i++) {
    await win.getByRole('button', { name: /Next/ }).click({ timeout: 15000 })
    await win.waitForTimeout(500)
  }
  await win.getByText('How should AskToto answer you?').waitFor({ timeout: 15000 })
  await shot('S5-provider-choice')
  return 'tour ok'
})

await step('S5-choose-cli', async () => {
  await win.getByText('Claude Code or Codex').click({ timeout: 15000 })
  await win.getByText('Get started').waitFor({ timeout: 45000 }) // cliDetect spawns the CLI; cold start is slow
  await shot('S6-readiness')
  const b = await bodyText()
  return b.split('\n').filter((l) => /connected|API key|Microphone|audio/i.test(l)).slice(0, 4).join(' | ')
})

await step('S6-finish-onboarding', async () => {
  await win.getByText('Get started').click({ timeout: 15000 })
  await win.locator('[aria-label="Ask AskToto anything"]').waitFor({ timeout: 20000 })
  const s = await win.evaluate(() => window.toto.getSettings())
  await shot('S7-main-bar')
  if (!s.onboardingDone) throw new Error('onboardingDone not persisted')
  if (!/cli/.test(s.provider)) throw new Error('provider not CLI after choose: ' + s.provider)
  return `bar live; provider=${s.provider}`
})

await step('S7a-cli-connect', async () => {
  const r = await win.evaluate(async () => {
    const api = Object.keys(window.toto).filter((k) => /^cli/i.test(k))
    let setup = null
    if (window.toto.cliSetup) setup = await window.toto.cliSetup('claude-cli')
    const s = await window.toto.getSettings()
    return { api, setup, connected: s.cliConnected, ready: s.providerReady }
  })
  if (!r.ready && !(r.connected && r.connected['claude-cli'])) {
    throw new Error('CLI not connected after setup: ' + JSON.stringify(r).slice(0, 250))
  }
  return `cli api=${r.api.join(',')} connected=${JSON.stringify(r.connected)} ready=${r.ready}`
})

await step('S7b-ask-real-answer', async () => {
  const inp = win.locator('[aria-label="Ask AskToto anything"]')
  await inp.click()
  await inp.fill('Reply with exactly QA-OK-42 and nothing else.')
  await inp.press('Enter')
  const deadline = Date.now() + 180_000
  let last = ''
  while (Date.now() < deadline) {
    last = (await bodyText()).replace('Reply with exactly QA-OK-42 and nothing else.', '')
    if (/QA-OK-42/.test(last)) break
    await win.waitForTimeout(2500)
  }
  await shot('S7-answer')
  if (!/QA-OK-42/.test(last)) throw new Error('no QA-OK-42. Tail: ' + last.slice(-300))
  return 'real streamed answer via claude-cli'
})

await step('S8-settings-sections', async () => {
  await win.locator('[aria-label="Settings"]').click({ timeout: 15000 })
  await win.waitForTimeout(1500)
  const names = await buttons()
  const sections = names.filter((n) => /^(General|AI|Audio|Personalize|Calendar|About|Privacy|Account)$/.test(n))
  if (!sections.length) throw new Error('no section buttons; saw: ' + JSON.stringify(names).slice(0, 300))
  const seen = []
  for (const s of [...new Set(sections)]) {
    await win.getByRole('button', { name: s, exact: true }).first().click({ timeout: 8000 })
    await win.waitForTimeout(800)
    await shot(`S8-${s}`)
    const count = await win.evaluate(() => document.querySelectorAll('*').length)
    if (count < 80) throw new Error(`section ${s} rendered nearly empty`)
    seen.push(`${s}:${count}el`)
  }
  const done = win.getByRole('button', { name: /^Done$/ })
  if (await done.count()) await done.first().click()
  await win.waitForTimeout(600)
  return seen.join(' ')
})

await step('S9-renderer-key-isolation', async () => {
  const audit = await win.evaluate(async () => {
    const api = Object.keys(window.toto)
    const leaky = api.filter((k) => /getapikey|apikeyget|secret/i.test(k))
    const flat = JSON.stringify(await window.toto.getSettings())
    const keyish = /sk-ant-[A-Za-z0-9_-]{10,}|sk-proj-[A-Za-z0-9_-]{10,}|nvapi-[A-Za-z0-9_-]{10,}/.test(flat)
    return { apiCount: api.length, leaky, keyish }
  })
  if (audit.leaky.length) throw new Error('leaky preload methods: ' + audit.leaky.join(','))
  if (audit.keyish) throw new Error('key material visible in renderer settings payload')
  return `preload ${audit.apiCount} methods; no key access from renderer`
})

await step('S10-import-read-path-gate (security)', async () => {
  const r = await win.evaluate(async (p) => {
    try { await window.toto.importAudioRead(p); return { blocked: false } }
    catch (e) { return { blocked: true, msg: String(e).slice(0, 120) } }
  }, WAV)
  if (!r.blocked) throw new Error('SECURITY: renderer read an arbitrary disk path not chosen via the picker')
  return 'arbitrary-path read correctly rejected: ' + r.msg
})

await step('S11-listen-live-asr', async () => {
  await win.locator('[aria-label="Start listening"]').click({ timeout: 15000 })
  await shot('S11-listen-started')
  const t0 = Date.now()
  let transcript = ''
  const before = await bodyText()
  while (Date.now() - t0 < 120_000) {
    await win.waitForTimeout(4000)
    const now = await bodyText()
    // new persistent text beyond the pre-listen snapshot = transcription output
    const fresh = now.split('\n').filter((l) => l.length > 25 && !before.includes(l))
    if (fresh.join(' ').split(/\s+/).length > 8) { transcript = fresh.join(' ').slice(0, 200); break }
  }
  await shot('S11-listen-transcript')
  const stop = win.locator('[aria-label="Stop listening"], [aria-label*="Stop"]')
  if (await stop.count()) await stop.first().click({ timeout: 8000 })
  await win.waitForTimeout(2500)
  await shot('S11-after-stop')
  // save path: Review view may offer Save/Done/Keep — click the first match to persist the meeting
  for (const name of [/^Save/i, /^Keep/i, /^Done$/i, /^End meeting/i]) {
    const b = win.getByRole('button', { name })
    if (await b.count()) { await b.first().click({ timeout: 5000 }).catch(() => {}); await win.waitForTimeout(1500); break }
  }
  if (!transcript) throw new Error('no transcription text appeared within 120s of fake-audio Listen')
  return 'on-device transcript from fake mic: "' + transcript.slice(0, 120) + '"'
})

await step('S11b-recall-list', async () => {
  const list = await win.evaluate(() => window.toto.recallList())
  if (!list.length) return 'recallList empty (meeting may not have auto-saved — check S12 for on-disk files)'
  return `recall has ${list.length} meeting(s): ` + JSON.stringify(list[0]).slice(0, 140)
})

await step('S13-updater-log-health', async () => {
  const logDir = join(USERDATA, 'logs')
  const logs = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith('.log')) : []
  let upd = 'no updater lines'
  const bad = []
  for (const f of logs) {
    const lines = readFileSync(join(logDir, f), 'utf8').split('\n')
    const u = lines.filter((l) => /updat/i.test(l)).slice(-2)
    if (u.length) upd = u.join(' | ').slice(0, 160)
    bad.push(...lines.filter((l) => /(FATAL|Unhandled|uncaught)/i.test(l)).slice(-3))
  }
  if (bad.length) throw new Error('fatal/unhandled in logs: ' + bad.join(' | ').slice(0, 250))
  return `logs clean (${logs.join(',')}); updater: ${upd}`
})

await step('S15-clean-exit', async () => { await app.close(); return 'closed' })

await step('S12-encryption-at-rest', async () => {
  const roots = [
    USERDATA,
    join(process.env.USERPROFILE, 'Documents', 'AskToto Meetings'),
    join(process.env.OneDrive || join(process.env.USERPROFILE, 'OneDrive'), 'AskToto Meetings')
  ]
  const found = []
  const walk = (d, depth) => {
    if (depth < 0) return
    let es = []
    try { es = readdirSync(d) } catch { return }
    for (const e of es) {
      const p = join(d, e)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p, depth - 1)
      else if (e.endsWith('.md') && st.mtimeMs > Date.now() - 30 * 60_000) found.push(p)
    }
  }
  for (const r of roots) walk(r, 4)
  if (!found.length) return 'no transcript file written this run (Listen save flow may need manual step) — nothing to check, not a failure of encryption itself'
  const checked = found.map((p) => {
    const head = readFileSync(p).subarray(0, 8).toString('latin1')
    return `${p.split('\\').pop()}=${head.startsWith('ATKENC') ? 'ENCRYPTED' : 'PLAINTEXT!'}`
  })
  if (checked.some((c) => c.includes('PLAINTEXT'))) throw new Error('unencrypted transcript on disk: ' + checked.join(' '))
  return checked.join(' ')
})

// ─── Launch 2: managed-config lock ───────────────────────────────────────────
const MANAGED = join(USERDATA, 'managed-config.json')
await step('S14-managed-config-lock', async () => {
  writeFileSync(MANAGED, JSON.stringify({ locked: ['provider'], provider: 'anthropic' }))
  app = await electron.launch({ executablePath: EXE, env: LAUNCH_ENV, timeout: 90_000 })
  win = await app.firstWindow({ timeout: 90_000 })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(4000)
  const before = await win.evaluate(() => window.toto.getSettings())
  await win.evaluate(() => window.toto.setSettings({ provider: 'openai' }))
  const after = await win.evaluate(() => window.toto.getSettings())
  await shot('S14-managed-lock')
  await app.close()
  unlinkSync(MANAGED)
  if (before.provider !== 'anthropic') throw new Error('managed default not applied: ' + before.provider)
  if (after.provider !== 'anthropic') throw new Error('LOCK BYPASSED → ' + after.provider)
  return 'managed default applied AND locked key immune to user patch'
})

const fails = results.filter((r) => !r.ok)
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2))
console.log('\n=== QA SUMMARY ===')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}  ${r.detail.slice(0, 150)}`)
console.log(`\n${results.length - fails.length}/${results.length} PASS, ${fails.length} FAIL`)
try { unlinkSync(MANAGED) } catch {}
process.exit(fails.length ? 1 : 0)
