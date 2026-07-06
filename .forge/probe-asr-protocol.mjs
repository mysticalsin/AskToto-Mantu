// Probe the asr-model:// protocol from inside the packaged renderer: is the fetch failure CORS?
import { _electron as electron } from 'playwright'

const app = await electron.launch({
  executablePath: 'D:/asktoto-wt/release/win-unpacked/AskToto.exe',
  env: { ...process.env, ASKTOTO_DISABLE_CP: '1' },
  timeout: 90_000,
})
const win = await app.firstWindow({ timeout: 90_000 })
await win.waitForLoadState('domcontentloaded')
const result = await win.evaluate(async () => {
  const out = {}
  for (const u of [
    'asr-model://models/Xenova/whisper-base/config.json',
    'asr-model://ort/ort-wasm-simd-threaded.jsep.wasm',
  ]) {
    try {
      const r = await fetch(u)
      out[u] = { ok: r.ok, status: r.status, type: r.type, len: (await r.arrayBuffer()).byteLength }
    } catch (e) {
      out[u] = { error: String(e) }
    }
  }
  // same probe from a same-origin Worker context (the whisper worker path)
  try {
    out.worker = await new Promise((resolve) => {
      const blob = new Blob(
        [
          `fetch('asr-model://models/Xenova/whisper-base/config.json').then(r=>r.arrayBuffer()).then(b=>postMessage({ok:true,len:b.byteLength})).catch(e=>postMessage({error:String(e)}))`,
        ],
        { type: 'text/javascript' }
      )
      const w = new Worker(URL.createObjectURL(blob))
      w.onmessage = (m) => resolve(m.data)
      setTimeout(() => resolve({ error: 'worker timeout' }), 10000)
    })
  } catch (e) {
    out.worker = { error: String(e) }
  }
  return out
})
console.log(JSON.stringify(result, null, 2))
await app.close()
