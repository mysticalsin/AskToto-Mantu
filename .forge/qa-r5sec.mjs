// Validate R5 security fixes on the packaged app:
// (1) ASKTOTO_DISABLE_CP is IGNORED in a packaged build → contentProtection stays ON.
// (2) An encrypted transcript's FILENAME contains no readable title slug (opaque token).
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const EXE = 'D:/asktoto-wt/release/win-unpacked/AskToto.exe'
const UDD = 'D:/asktoto-wt/.forge/qa-udd-r5sec'
const WAV = 'D:/asktoto-wt/release/win-unpacked/resources/asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/en.wav'
mkdirSync('D:/asktoto-wt/.forge/qa', { recursive: true })
try { rmSync(UDD, { recursive: true, force: true }) } catch {}

const results = []
const rec = (n, ok, d) => { results.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n} — ${d}`) }

// Launch packaged WITH the env var that used to disable content protection.
const app = await electron.launch({
  executablePath: EXE,
  args: [`--user-data-dir=${UDD}`],
  env: { ...process.env, ASKTOTO_DISABLE_CP: '1' }, // must be ignored in a packaged build
  timeout: 90_000
})
const win = await app.firstWindow({ timeout: 90_000 })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(4500)

// (1) content protection stays ON despite the env var (packaged build ignores it)
const s0 = await win.evaluate(() => window.toto.getSettings())
rec('cp-env-ignored-when-packaged', s0.contentProtection === true, `contentProtection=${s0.contentProtection} (env ASKTOTO_DISABLE_CP set; must stay true)`)

// (2) enable encryption, import a distinctively-titled audio, check the saved filename has no slug.
const DISTINCT = 'topsecret-acquisition-plan'
await win.evaluate(() => window.toto.setSettings({ encryptTranscripts: true }))
const enc = (await win.evaluate(() => window.toto.getSettings())).encryptTranscripts
const buf = (await import('node:fs')).readFileSync(WAV)
const imp = await win.evaluate(async (args) => {
  const [bytes, name] = args
  const ac = new AudioContext()
  const dec = await ac.decodeAudioData(new Uint8Array(bytes).buffer.slice(0))
  await ac.close()
  const off = new OfflineAudioContext(1, Math.ceil(dec.duration * 16000), 16000)
  const src = off.createBufferSource(); src.buffer = dec; src.connect(off.destination); src.start()
  const r = await off.startRendering()
  return window.toto.importAudioTranscribe({ sessionId: 'r5-' + Math.random().toString(36).slice(2), seq: 0, totalChunks: 1, done: true, name, mtimeMs: 1751760000000, samples: new Float32Array(r.getChannelData(0)) })
}, [[...buf], DISTINCT])
await win.waitForTimeout(1500)
await app.close()

// scan the meetings folder (userData + Documents + OneDrive) for a recent .md; assert no slug leak
const roots = [UDD, join(process.env.USERPROFILE, 'Documents', 'AskToto Meetings'), join(process.env.OneDrive || 'X:', 'AskToto Meetings')]
const found = []
const walk = (d, dep) => { if (dep < 0) return; let es = []; try { es = readdirSync(d) } catch { return }
  for (const e of es) { const p = join(d, e); let st; try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, dep - 1); else if (e.endsWith('.md') && st.mtimeMs > Date.now() - 15 * 60_000) found.push(e) } }
for (const r of roots) walk(r, 4)
const slug = DISTINCT.toLowerCase()
const leaks = found.filter((fn) => fn.toLowerCase().includes(slug))
rec('encrypted-filename-no-title-slug', enc === true && imp?.ok === true && leaks.length === 0 && found.length > 0,
  `encryption=${enc} import.ok=${imp?.ok} recentFiles=[${found.join(', ')}] leakedSlug=${leaks.length}`)

try { rmSync(UDD, { recursive: true, force: true }) } catch {}
const fails = results.filter((r) => !r.ok)
console.log(`\n${results.length - fails.length}/${results.length} PASS`)
process.exit(fails.length ? 1 : 0)
