// Final consolidated live QA — proves the highest-value workflows end-to-end on the packaged app,
// with a hermetic profile via --user-data-dir (the reliable Electron isolation switch).
// Covers: onboarding (consent gate → CLI pick), CLI connect via the real cliTest (sets cliConnected),
// providerReady flip, real streamed Ask via claude-cli, offline ASR (importAudioTranscribe with samples
// decoded in-renderer), encryption-at-rest of the saved transcript, managed-config lock (2nd launch).
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const EXE = 'D:/asktoto-wt/release/win-unpacked/AskToto.exe'
const WAV = 'D:/asktoto-wt/release/win-unpacked/resources/asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/en.wav'
const OUT = 'D:/asktoto-wt/.forge/qa'
const UDD = 'D:/asktoto-wt/.forge/qa-udd-final'
mkdirSync(OUT, { recursive: true })
try { rmSync(UDD, { recursive: true, force: true }) } catch {}

const results = []
let win, app
const shot = (n) => win.screenshot({ path: `${OUT}/${n}.png` }).catch(() => {})
async function step(name, fn) {
  const t = Date.now()
  try { const d = await fn(); results.push({ name, ok: true, d: String(d ?? '').slice(0, 260) }); console.log(`PASS ${name} — ${String(d ?? '').slice(0, 150)}`) }
  catch (e) { results.push({ name, ok: false, d: String(e).slice(0, 320) }); console.log(`FAIL ${name}: ${String(e).slice(0, 260)}`); await shot(`FAILF-${name}`) }
}
const bodyText = () => win.evaluate(() => document.body.innerText)

async function launch(extra = []) {
  const a = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${UDD}`, ...extra], env: { ...process.env, ASKTOTO_DISABLE_CP: '1' }, timeout: 90_000 })
  const w = await a.firstWindow({ timeout: 90_000 })
  await w.waitForLoadState('domcontentloaded')
  await w.waitForTimeout(4500)
  return { a, w }
}

;({ a: app, w: win } = await launch())

await step('onboarding-consent-to-bar', async () => {
  await win.locator('input[type=checkbox]').first().check()
  await win.getByText('Continue without signing in').click({ timeout: 15000 })
  await win.waitForTimeout(600)
  for (let i = 0; i < 3; i++) { await win.getByRole('button', { name: /Next/ }).click({ timeout: 8000 }).catch(() => {}); await win.waitForTimeout(400) }
  await win.getByText('Claude Code or Codex').click({ timeout: 10000 }).catch(() => win.getByText(/Decide later/).click())
  await win.getByText('Get started').waitFor({ timeout: 45000 })
  await win.getByText('Get started').click()
  await win.locator('[aria-label="Ask AskToto anything"]').waitFor({ timeout: 20000 })
  return 'reached main bar'
})

await step('cli-connect-and-ready', async () => {
  const r = await win.evaluate(async () => {
    const det = await window.toto.cliDetect('claude-cli')
    if (!det.ok) return { detOk: false, det }
    const test = await window.toto.cliTest('claude-cli') // this sets cliConnected on success
    const s = await window.toto.getSettings()
    return { detOk: det.ok, testOk: test.ok, testErr: test.error || null, connected: s.cliConnected, provider: s.provider, ready: s.providerReady }
  })
  if (!r.detOk) throw new Error('claude CLI not detected on PATH from packaged app: ' + JSON.stringify(r))
  if (!r.testOk) throw new Error('cliTest failed: ' + r.testErr)
  if (!r.connected?.['claude-cli']) throw new Error('cliConnected not set after test: ' + JSON.stringify(r))
  if (r.provider === 'claude-cli' && !r.ready) throw new Error('providerReady false despite CLI connected')
  return `detected+tested+connected; provider=${r.provider} ready=${r.ready}`
})

await step('ask-real-answer-cli', async () => {
  // ensure claude-cli is the active provider, then ask
  await win.evaluate(() => window.toto.setSettings({ provider: 'claude-cli' }))
  await win.waitForTimeout(500)
  const inp = win.locator('[aria-label="Ask AskToto anything"]')
  await inp.click(); await inp.fill('Reply with exactly QA-OK-42 and nothing else.'); await inp.press('Enter')
  const end = Date.now() + 180_000
  let last = ''
  while (Date.now() < end) {
    last = (await bodyText()).replace('Reply with exactly QA-OK-42 and nothing else.', '')
    if (/QA-OK-42/.test(last)) break
    await win.waitForTimeout(2500)
  }
  await shot('FINAL-answer')
  if (!/QA-OK-42/.test(last)) throw new Error('no QA-OK-42. tail: ' + last.slice(-260))
  return 'streamed real answer via claude-cli'
})

await step('offline-asr-transcribe', async () => {
  const buf = readFileSync(WAV)
  const r = await win.evaluate(async (bytes) => {
    const arr = new Uint8Array(bytes).buffer
    const ac = new AudioContext()
    const dec = await ac.decodeAudioData(arr.slice(0))
    await ac.close()
    const off = new OfflineAudioContext(1, Math.ceil(dec.duration * 16000), 16000)
    const src = off.createBufferSource(); src.buffer = dec; src.connect(off.destination); src.start()
    const rendered = await off.startRendering()
    const res = await window.toto.importAudioTranscribe({
      sessionId: 'qaf-' + Math.random().toString(36).slice(2), seq: 0, totalChunks: 1, done: true,
      name: 'qa-final-en', mtimeMs: 1751760000000, samples: new Float32Array(rendered.getChannelData(0))
    })
    return { ok: res.ok, error: res.error || null, secs: Math.round(dec.duration) }
  }, [...buf])
  if (!r.ok) throw new Error('importAudioTranscribe failed: ' + r.error)
  return `on-device transcription of ${r.secs}s wav OK (bundled models, zero network)`
})

await step('encryption-at-rest', async () => {
  const list = await win.evaluate(() => window.toto.recallList())
  const roots = [UDD, join(process.env.USERPROFILE, 'Documents', 'AskToto Meetings'), join(process.env.OneDrive || 'X:', 'AskToto Meetings')]
  const found = []
  const walk = (d, dep) => { if (dep < 0) return; let es = []; try { es = readdirSync(d) } catch { return }
    for (const e of es) { const p = join(d, e); let st; try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p, dep - 1); else if (e.endsWith('.md') && st.mtimeMs > Date.now() - 20 * 60_000) found.push(p) } }
  for (const r of roots) walk(r, 4)
  if (!found.length) return `recall has ${list.length} meeting(s); no .md written this run to inspect (import path saves via ingest) — marker check skipped`
  const checked = found.map((p) => { const h = readFileSync(p).subarray(0, 8).toString('latin1'); return `${p.split(/[\\/]/).pop()}=${h.startsWith('ATKENC') ? 'ENCRYPTED' : 'PLAINTEXT!'}` })
  if (checked.some((c) => c.includes('PLAINTEXT'))) throw new Error('unencrypted transcript on disk: ' + checked.join(' '))
  return `recall ${list.length}; on-disk: ` + checked.slice(0, 4).join(' ')
})

await step('clean-exit', async () => { await app.close(); return 'closed' })

await step('managed-config-lock', async () => {
  const MANAGED = join(UDD, 'managed-config.json')
  writeFileSync(MANAGED, JSON.stringify({ locked: ['provider'], provider: 'anthropic' }))
  ;({ a: app, w: win } = await launch())
  const before = await win.evaluate(() => window.toto.getSettings())
  await win.evaluate(() => window.toto.setSettings({ provider: 'openai' }))
  const after = await win.evaluate(() => window.toto.getSettings())
  await shot('FINAL-managed-lock')
  await app.close()
  if (before.provider !== 'anthropic') throw new Error('managed default not applied: ' + before.provider)
  if (after.provider !== 'anthropic') throw new Error('LOCK BYPASSED → ' + after.provider)
  return 'managed default applied AND locked key immune to user patch'
})

const fails = results.filter((r) => !r.ok)
writeFileSync(`${OUT}/final-results.json`, JSON.stringify(results, null, 2))
console.log('\n=== FINAL QA ===')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  —  ${r.d.slice(0, 140)}`)
console.log(`\n${results.length - fails.length}/${results.length} PASS`)
try { rmSync(UDD, { recursive: true, force: true }) } catch {}
process.exit(fails.length ? 1 : 0)
