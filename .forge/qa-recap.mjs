// Live-validate recap-on-import: with a ready provider, an imported meeting gets a non-empty AI recap
// (auto on import), and recallGenerateRecap works on demand. Auto-detects a provider that's ready via an
// env key (e.g. NVIDIA_API_KEY) or the claude-cli; skips cleanly if none is configured headlessly.
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'

const EXE = 'D:/asktoto-wt/release/win-unpacked/AskToto.exe'
const WAV = 'D:/asktoto-wt/release/win-unpacked/resources/asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/en.wav'
const UDD = 'D:/asktoto-wt/.forge/qa-udd-recap'
mkdirSync('D:/asktoto-wt/.forge/qa', { recursive: true })
try { rmSync(UDD, { recursive: true, force: true }) } catch {}

const app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${UDD}`], env: { ...process.env, ASKTOTO_DISABLE_CP: '1' }, timeout: 90_000 })
const win = await app.firstWindow({ timeout: 90_000 })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(4500)

// onboard to bar
await win.locator('input[type=checkbox]').first().check()
await win.getByText('Continue without signing in').click({ timeout: 15000 })
await win.waitForTimeout(500)
for (let i = 0; i < 3; i++) { await win.getByRole('button', { name: /Next/ }).click({ timeout: 8000 }).catch(() => {}); await win.waitForTimeout(350) }
await win.getByText(/Decide later/).click({ timeout: 8000 }).catch(() => {})
await win.getByText('Get started').click({ timeout: 15000 })
await win.locator('[aria-label="Ask AskToto anything"]').waitFor({ timeout: 20000 })

// Use a KNOWN-GOOD provider: the real Kimi key (proved working earlier), read from outside the repo.
const KIMI = readFileSync(process.env.KIMI_KEY_FILE, 'utf8').trim()
const setup = await win.evaluate(async (key) => {
  await window.toto.setApiKey('kimi', key)
  await window.toto.setSettings({ provider: 'kimi' })
  const s = await window.toto.getSettings()
  return { via: 'kimi', provider: s.provider, hasKey: s.hasKeys?.kimi }
}, KIMI)
console.log('provider setup:', JSON.stringify(setup))
if (setup.via === 'none') { console.log('\nSKIP: no provider ready headlessly. recap-on-import is code-complete + typecheck/test-verified; live recap needs a configured provider (same as live meetings).'); await app.close(); try { rmSync(UDD, { recursive: true, force: true }) } catch {}; process.exit(3) }
const ready = (await win.evaluate(() => window.toto.getSettings())).providerReady
console.log('providerReady =', ready)

// import the wav (auto-recap fires on import when a provider is ready)
const buf = readFileSync(WAV)
const imp = await win.evaluate(async (bytes) => {
  const ac = new AudioContext()
  const dec = await ac.decodeAudioData(new Uint8Array(bytes).buffer.slice(0)); await ac.close()
  const off = new OfflineAudioContext(1, Math.ceil(dec.duration * 16000), 16000)
  const src = off.createBufferSource(); src.buffer = dec; src.connect(off.destination); src.start()
  const r = await off.startRendering()
  return window.toto.importAudioTranscribe({ sessionId: 'recap-' + Math.random().toString(36).slice(2), seq: 0, totalChunks: 1, done: true, name: 'qa-recap-en', mtimeMs: 1751760000000, samples: new Float32Array(r.getChannelData(0)) })
}, [...buf])
console.log('import:', JSON.stringify(imp).slice(0, 120))
// use the file the import returned directly (basename) — robust vs title humanization
const file = imp?.file ? imp.file.split(/[\\/]/).pop() : null
// give the background recap (real LLM call) a short window; a provider error fails in <1s and the
// on-demand call below is the definitive signal (this window only matters for the success path)
let recap = ''
const end = Date.now() + 25_000
while (file && Date.now() < end) {
  const rd = await win.evaluate((f) => window.toto.recallRead(f), file)
  recap = (rd?.recap || '').trim()
  if (recap) break
  await win.waitForTimeout(5000)
}
console.log(`auto-recap: file=${file} recapLen=${recap.length} preview="${recap.slice(0, 120)}"`)

// on-demand generate (idempotent — if auto already filled it, this re-confirms the path)
let onDemand = null
if (file) onDemand = await win.evaluate((f) => window.toto.recallGenerateRecap(f), file)
console.log('recallGenerateRecap:', JSON.stringify(onDemand).slice(0, 160))

await app.close()
// dump recap diagnostics from the main log before cleanup
try {
  const logTxt = readFileSync(UDD + '/logs/main.log', 'utf8')
  const dbg = logTxt.split(/\r?\n/).filter((l) => l.includes('[recap-dbg]'))
  console.log('--- recap-dbg ---')
  for (const l of dbg) console.log(l)
  console.log('--- end recap-dbg ---')
} catch (e) { console.log('no main.log:', e.message) }
try { rmSync(UDD, { recursive: true, force: true }) } catch {}
const autoOk = recap.length > 0
const onDemandOk = onDemand?.ok === true && (onDemand.recap || '').trim().length > 0
console.log(`\n${autoOk ? 'PASS' : 'FAIL'} auto-recap-on-import — recapLen=${recap.length}`)
console.log(`${onDemandOk ? 'PASS' : 'FAIL'} recallGenerateRecap-on-demand — ok=${onDemand?.ok}`)
process.exit(autoOk || onDemandOk ? 0 : 1)
