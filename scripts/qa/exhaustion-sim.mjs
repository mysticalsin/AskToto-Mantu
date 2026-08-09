import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9334'
const MOCK = 'https://127.0.0.1:8788'
const b = await chromium.connectOverCDP(CDP)
let page = null
for (let i = 0; i < 40 && !page; i++) {
  for (const c of b.contexts()) for (const p of c.pages()) {
    try { if (await p.evaluate(() => typeof window.toto !== 'undefined')) { page = p; break } } catch {}
  }
  if (!page) await new Promise((r) => setTimeout(r, 1000))
}
if (!page) { console.log('no page'); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settings = () => page.evaluate(() => window.toto.getSettings())
const patch = (p) => page.evaluate((p) => window.toto.setSettings(p), p)

const ask = (req, to = 90000) =>
  page.evaluate(({ req, to }) =>
    new Promise((res) => {
      const out = { walk: [], text: '', error: null }
      const om = window.toto.onMeta((m) => { if (m.id === req.id) out.walk.push(m.provider) })
      const od = window.toto.onDelta((d) => { if (d.id === req.id) out.text += d.text })
      const done = (e) => { out.error = e ?? null; om(); od(); odn(); oe(); res(out) }
      const odn = window.toto.onDone((d) => { if (d.id === req.id) done(null) })
      const oe = window.toto.onError((e) => { if (e.id === req.id) done(e.message) })
      window.toto.ask(req)
      setTimeout(() => done('timeout'), to)
    }), { req, to })

// Configure the custom provider pointed at the mock. Keep the ACTIVE provider valid (anthropic) so the
// https-only refine on customBaseUrl never fires — we route to custom per-ask via providerOverride.
async function pointCustomAt(scenario) {
  await page.evaluate(() => window.toto.setApiKey('custom', 'sk-mock-test-key')) // also resets its health+headroom
  await patch({
    provider: 'anthropic',
    customBaseUrl: `${MOCK}/${scenario}/v1`,
    providerModels: { ...(await settings()).providerModels, custom: 'mock-model' }
  })
}
const customReq = (over) => ({
  id: 'x-' + Math.random().toString(36).slice(2),
  mode: 'suggest',
  prompt: '',
  transcript: 'THEM: what is the renewal price?',
  history: [],
  providerOverride: 'custom',
  ...over
})
const unhealthy = async () => (await settings()).unhealthyProviders

const out = {}

// Strip any real keys + arm the on-device floor.
await page.evaluate(async () => {
  const s = await window.toto.getSettings()
  for (const k of Object.keys(s.hasKeys)) if (s.hasKeys[k]) await window.toto.clearApiKey(k)
  await window.toto.setSettings({ localLlm: { ...s.localLlm, useFor: { suggest: false, summary: false, vision: false }, fallback: true } })
})

// ── A) rate-limit → cools with reason 'rate-limit', still answers on-device ──────────────────────────
await pointCustomAt('rate-limit')
{
  const r = await ask(customReq())
  const u = await unhealthy()
  out.rateLimit = {
    walk: r.walk, servedBy: r.walk.at(-1), text: r.text.slice(0, 40), error: r.error,
    customReason: u.find((p) => p.provider === 'custom')?.reason ?? null
  }
}

// ── B) credit exhaustion → cools ~1h with reason 'quota-exhausted'; a 2nd ask SKIPS the cooling custom ─
await pointCustomAt('quota')
{
  const r1 = await ask(customReq())
  const u = await unhealthy()
  const r2 = await ask(customReq()) // custom now cooling → primary should be skipped straight to local
  out.quota = {
    walk1: r1.walk, servedBy1: r1.walk.at(-1),
    customReason: u.find((p) => p.provider === 'custom')?.reason ?? null,
    walk2: r2.walk, skippedCoolingCustom: !r2.walk.includes('custom'), servedBy2: r2.walk.at(-1)
  }
}

// ── C) usage-cap → reason 'usage-cap' with a parsed reset ─────────────────────────────────────────────
await pointCustomAt('usage-cap')
{
  const r = await ask(customReq())
  const u = await unhealthy()
  const c = u.find((p) => p.provider === 'custom')
  out.usageCap = { walk: r.walk, servedBy: r.walk.at(-1), reason: c?.reason ?? null, hasFutureReset: (c?.until ?? 0) > Date.now() }
}

// ── D) THE GUARANTEE: answer mode, sole provider out of credit → on-device ANSWER floor catches it ────
await pointCustomAt('quota')
{
  const r = await ask(customReq({ mode: 'answer', prompt: 'What is our renewal risk?', transcript: undefined }))
  out.answerFloor = { walk: r.walk, servedBy: r.walk.at(-1), text: r.text.slice(0, 40), error: r.error, floored: r.walk.at(-1) === 'local' && !r.error }
}

// ── E) budget pre-emption: a 200 with 0.01% headroom → next ask skips custom BEFORE it 429s ───────────
await pointCustomAt('low-headroom')
{
  const r1 = await ask(customReq())            // succeeds, captures the near-empty headroom header
  const r2 = await ask(customReq())            // should pre-empt custom → local, without custom erroring
  out.budgetPreempt = {
    walk1: r1.walk, served1: r1.walk.at(-1), text1: r1.text.slice(0, 30),
    walk2: r2.walk, preempted: !r2.walk.includes('custom'), served2: r2.walk.at(-1)
  }
}

// ── F) honest message when there is NO backup at all (fallback off) ───────────────────────────────────
await pointCustomAt('quota')
{
  const s = await settings()
  await patch({ localLlm: { ...s.localLlm, fallback: false } })
  const r = await ask(customReq({ mode: 'answer', prompt: 'hi', transcript: undefined }))
  await patch({ localLlm: { ...s.localLlm, fallback: true } })
  out.noBackupMessage = { error: r.error, namesTheLimit: /out of credit|credit/i.test(r.error || '') }
}

// cleanup
await page.evaluate(() => window.toto.clearApiKey('custom'))

console.log(JSON.stringify(out, null, 1))
writeFileSync('D:/tmp-metis-e2e/exhaustion.json', JSON.stringify(out, null, 1))
await b.close()
process.exit(0)
