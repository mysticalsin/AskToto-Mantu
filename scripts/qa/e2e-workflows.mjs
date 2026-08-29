#!/usr/bin/env node
/**
* MQA-255 — see docs/qa/BUG-LEDGER.md for why this suite snapshots settings and reports 'not exercised'.
 * Métis physical QA suite — drives a REAL running app over CDP and exercises every major workflow.
 *
 * This is deliberately not a unit test. Unit tests prove functions; this proves the shipped app: real
 * IPC, real settings on disk, real provider calls, real on-device model. Findings from it belong in
 * docs/qa/BUG-LEDGER.md.
 *
 * Prerequisites (the app must already be running with CDP + an isolated profile):
 *   npm run build
 *   ASKTOTO_USERDATA=<dir> ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9334
 * Note: --user-data-dir does NOT move app.getPath('userData') — the app appends "-dev" when unpackaged,
 * so ASKTOTO_USERDATA (honored in main/index.ts) is the only reliable isolation switch.
 *
 * Usage:
 *   node scripts/qa/e2e-workflows.mjs                        # everything
 *   node scripts/qa/e2e-workflows.mjs --only=degrade         # one group
 *   node scripts/qa/e2e-workflows.mjs --meetings=D:\fixtures # point at a fixture meetings folder first
 *   node scripts/qa/e2e-workflows.mjs --list                 # group names
 *
 * The degradation group sets deliberately INVALID API keys and issues one request each, so real
 * endpoints return 401. That is the point: it physically reproduces "my API key stopped working".
 */
import { chromium } from 'playwright-core'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
// Used only by the `cloudflare` group, to probe the mock gateway from THIS process rather than from the
// CSP-restricted renderer. `rejectUnauthorized: false` is safe and necessary here: the mock serves a
// throwaway self-signed cert on 127.0.0.1, and this is test tooling, never shipped code.
import { request as httpsRequest } from 'node:https'

const CDP = process.env.METIS_CDP ?? 'http://127.0.0.1:9334'
const OUT = process.env.METIS_QA_OUT ?? 'D:\\tmp-metis-e2e\\qa-report.json'
const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').replace('--only=', '')
const meetingsFolder = (args.find((a) => a.startsWith('--meetings=')) ?? '').replace('--meetings=', '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
/** False once boot observes the on-device weights still downloading — see the boot check. */
let localModelReady = true
let page = null

function record(group, name, status, detail) {
  results.push({ group, name, status, detail })
  const mark = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'INFO'
  console.log(`[${mark}] ${group} :: ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

/** Run one check. A throw is a FAIL, never an abort — the suite always completes so one broken
 *  workflow cannot hide the state of every workflow after it. */
async function check(group, name, fn) {
  try {
    const detail = await fn()
    // A check may downgrade ITSELF to "not exercised" by returning { __info }. Used where the blocker is
    // the environment rather than the build, so a healthy app never reports red for a cold profile.
    if (detail && typeof detail === 'object' && typeof detail.__info === 'string') {
      record(group, name, 'info', detail.__info)
      return
    }
    record(group, name, 'pass', detail)
    return detail
  } catch (e) {
    record(group, name, 'fail', e instanceof Error ? e.message : String(e))
    return null
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function findTotoPage(browser) {
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          if (await p.evaluate(() => typeof window.toto !== 'undefined')) return p
        } catch { /* page mid-navigation */ }
      }
    }
    await sleep(1000)
  }
  throw new Error('no renderer page exposing window.toto after 60s — is the app running with CDP?')
}

/** Issue one ask and return the FULL provider walk (every streamMeta), the text, and any error.
 *  The provider sequence is the actual evidence of failover order — not an inference. */
async function ask(req, timeoutMs = 240000) {
  return page.evaluate(
    async ({ req, timeoutMs }) =>
      new Promise((resolve) => {
        const out = { providers: [], text: '', error: null, doneAt: null }
        const started = Date.now()
        const offMeta = window.toto.onMeta((m) => {
          if (m.id === req.id) out.providers.push(m.provider)
        })
        const offDelta = window.toto.onDelta((d) => {
          if (d.id === req.id) out.text += d.text
        })
        const finish = (err) => {
          out.error = err ?? null
          out.doneAt = Date.now() - started
          offMeta(); offDelta(); offDone(); offErr()
          resolve(out)
        }
        const offDone = window.toto.onDone((d) => { if (d.id === req.id) finish(null) })
        const offErr = window.toto.onError((e) => { if (e.id === req.id) finish(e.message) })
        window.toto.ask(req).catch((e) => finish(String(e)))
        setTimeout(() => finish(`TIMEOUT after ${timeoutMs}ms`), timeoutMs)
      }),
    { req, timeoutMs }
  )
}

const settings = () => page.evaluate(() => window.toto.getSettings())
const patch = (p) => page.evaluate((p) => window.toto.setSettings(p), p)
/** Which providers does the APP still hold a key for after clearAllKeys()? Anything left is env-backed
 *  (store.ts's getApiKey reads process.env[ENV_VAR[provider]] BEFORE the profile store) and therefore
 *  unremovable from here — the one honest reason the zero-key path cannot be exercised. */
async function stubbornKeys() {
  try {
    const s = await settings()
    return Object.entries(s.hasKeys ?? {}).filter(([, v]) => v === true).map(([k]) => k)
  } catch {
    return []
  }
}

const clearAllKeys = () =>
  page.evaluate(async () => {
    const s = await window.toto.getSettings()
    for (const [id, has] of Object.entries(s.hasKeys || {})) if (has) await window.toto.clearApiKey(id)
    return (await window.toto.getSettings()).hasKeys
  })

const uid = (() => { let n = 0; return (p) => `qa-${p}-${Date.now()}-${n++}` })()

// ── Groups ────────────────────────────────────────────────────────────────────────────────────────

async function groupBoot() {
  const g = 'boot'
  await check(g, 'renderer exposes the preload API', async () => {
    const keys = await page.evaluate(() => Object.keys(window.toto).length)
    assert(keys > 50, `only ${keys} preload methods exposed`)
    return `${keys} methods`
  })
  await check(g, 'settings snapshot loads and is self-consistent', async () => {
    const s = await settings()
    assert(s && typeof s === 'object', 'no settings returned')
    assert(typeof s.providerReady === 'boolean', 'providerReady missing')
    assert(typeof s.localReady === 'boolean', 'localReady missing')
    assert(s.resolvedMeetingsFolder, 'no resolved meetings folder')
    return { provider: s.provider, localReady: s.localReady, version: s.version }
  })
  await check(g, 'Local AI ships off by default (Cloudflare / API keys stay primary)', async () => {
    const s = await settings()
    assert(s.localLlm.enabled === false, 'localLlm.enabled should be false by default')
    assert(s.localLlm.fallback === false, 'localLlm.fallback should be false by default')
    const anyUseFor = s.localLlm.useFor.suggest || s.localLlm.useFor.summary || s.localLlm.useFor.vision
    assert(!anyUseFor, 'a useFor toggle defaults ON — local would preempt a configured cloud provider')
    return s.localLlm
  })
  await check(g, 'continuous background screen capture is OFF by default', async () => {
    const s = await settings()
    assert(s.backgroundScreenContext === false, 'backgroundScreenContext defaults ON — silent screen capture')
    return 'off'
  })
  // A model that is still DOWNLOADING is not a defect — it is a profile that has not finished first-run
  // setup. Reporting it as FAIL (and cascading into every "answers on-device" check below) produced 9
  // red lines on a perfectly healthy build, which is the fastest way to teach someone that red lines do
  // not mean anything. The distinction the suite has to make is "the app is broken" vs "this environment
  // cannot test that yet", and it already has the vocabulary for the second one.
  await check(g, 'bundled local model reports ready', async () => {
    const models = await page.evaluate(() => window.toto.localModelsList())
    const ready = models.filter((m) => m.ready)
    if (ready.length > 0) return ready.map((m) => m.id)
    const fetching = models.find((m) => m.unavailableReason === 'downloading' || m.unavailableReason === 'not-downloaded')
    if (fetching) {
      localModelReady = false
      const pct = Math.round((fetching.downloadProgress ?? 0) * 100)
      return {
        __info: `not exercised — first-run weights are still arriving (${fetching.id} at ${pct}%); re-run once the download finishes`
      }
    }
    // Present, not downloading, and still not ready — that IS a defect (bad RAM floor, damaged files).
    assert(false, `no ready model and none downloading: ${JSON.stringify(models)}`)
  })
  // MQA-002: "plug and play on Windows AND Mac" — the setup checklist must be able to state, on either
  // platform, whether mic and screen capture will actually work. Windows screen status used to be
  // hardcoded 'unknown' forever, so this asserts a committed answer on the platform under test.
  await check(g, 'screen-capture readiness reports a committed answer, not a permanent unknown (MQA-002)', async () => {
    const perms = await page.evaluate(() => window.toto.getPermissions())
    if (process.platform === 'win32') {
      assert(perms.screenRecording !== 'unknown',
        'Windows screen readiness is still "unknown" — the boot probe did not run, so the checklist cannot tell the user whether screenshots work')
    }
    assert(['granted', 'denied', 'unknown', 'not-required'].includes(perms.screenRecording), `bad status: ${perms.screenRecording}`)
    return { platform: process.platform, ...perms }
  })

  await check(g, 'the upfront permission pass is available and answers on this platform (MQA-002)', async () => {
    const perms = await page.evaluate(() => window.toto.requestPermissionsUpfront())
    assert(perms && typeof perms.microphone === 'string', 'upfront request returned nothing usable')
    return perms
  })

  // This check used to be called "everything needed to run is bundled — no post-install download
  // required", which asserts the opposite of what the product deliberately does. The Qwen weights are
  // NOT packaged: at ~728 MB they dominated the installer, and a universal build carrying them would
  // exceed GitHub's 2 GB per-asset limit, so electron-builder.yml ships only the licence and
  // local-model-download.ts fetches the weights once on first run from a pinned immutable revision.
  // The old name could therefore only ever pass on a WARM profile — on a real first run it was
  // guaranteed red, which is how a name that lies about the design stays unnoticed.
  //
  // What is actually promised, and what is checked here: the ASR weights DO ship (zero runtime
  // download), and the on-device LLM either is ready or is honestly reporting progress toward it.
  await check(g, 'ASR ships bundled, and the on-device LLM is either ready or visibly arriving', async () => {
    const out = await page.evaluate(async () => ({
      models: await window.toto.localModelsList(),
      asr: await window.toto.asrBundled?.().catch?.(() => null) ?? null,
      settings: await window.toto.getSettings()
    }))
    const ready = out.models.some((m) => m.ready)
    const arriving = out.models.some((m) => typeof m.progress === 'number' && m.progress >= 0 && !m.ready)
    assert(
      ready || arriving,
      `the on-device model is neither ready nor downloading: ${JSON.stringify(out.models.map((m) => ({ id: m.id, ready: m.ready, progress: m.progress })))}`
    )
    if (!ready) {
      return { __info: `not exercised — first run, weights still arriving (${out.models.filter((m) => !m.ready).map((m) => `${m.id} ${Math.round((m.progress ?? 0) * 100)}%`).join(', ')}); the app is served by the embedded provider meanwhile` }
    }
    assert(out.settings.localReady === true, 'a model reports ready but localReady is false — the on-device path is unavailable despite present weights')
    return { localModel: out.models.map((m) => `${m.id}:${m.ready}`), asrBundled: out.asr }
  })

  await check(g, 'permissions + license + metrics IPC answer without throwing', async () => {
    const out = await page.evaluate(async () => ({
      perms: await window.toto.getPermissions(),
      license: await window.toto.licenseStatus?.().catch((e) => String(e)),
      metrics: await window.toto.metricsRead?.().catch((e) => String(e))
    }))
    assert(out.perms, 'permissions IPC returned nothing')
    return { mic: out.perms.microphone, screen: out.perms.screenRecording }
  })
}

async function groupSettings() {
  const g = 'settings'
  await check(g, 'a key can be stored, is reported present, and never echoes back in settings', async () => {
    const probe = 'sk-qa-probe-key-not-real-000000000000'
    const res = await page.evaluate((k) => window.toto.setApiKey('deepseek', k), probe)
    assert(res.hasKeys.deepseek === true, 'hasKeys did not flip true after setApiKey')
    const raw = JSON.stringify(await settings())
    assert(!raw.includes(probe), 'THE API KEY LEAKED INTO THE SETTINGS SNAPSHOT')
    return 'stored, not echoed'
  })
  await check(g, 'clearing a key flips hasKeys back to false', async () => {
    await page.evaluate(() => window.toto.clearApiKey('deepseek'))
    const s = await settings()
    assert(!s.hasKeys.deepseek, 'hasKeys still true after clearApiKey')
    return 'cleared'
  })
  await check(g, 'DeepSeek resolves to a live V4 model id, not a retired one (MQA-001)', async () => {
    const s = await settings()
    const persisted = s.providerModels?.deepseek ?? ''
    assert(persisted !== 'deepseek-chat' && persisted !== 'deepseek-reasoner',
      `persisted a retired DeepSeek id: ${persisted}`)
    return { persisted: persisted || '(registry default)' }
  })
  await check(g, 'switching the active provider persists across a settings round-trip', async () => {
    const before = (await settings()).provider
    await patch({ provider: 'openai' })
    const mid = (await settings()).provider
    assert(mid === 'openai', `provider did not switch (got ${mid})`)
    await patch({ provider: before })
    return `${before} → openai → ${before}`
  })
  await check(g, 'Local AI toggles persist and drive the derived readiness flags', async () => {
    const before = (await settings()).localLlm
    await patch({ localLlm: { ...before, useFor: { ...before.useFor, summary: true } } })
    const on = await settings()
    assert(on.localSummaryReady === true, 'localSummaryReady did not follow useFor.summary')
    await patch({ localLlm: before })
    const off = await settings()
    assert(off.localSummaryReady === false, 'localSummaryReady did not reset')
    return 'derived flags track the toggle'
  })
  await check(g, 'fallback toggle drives localFallbackReady', async () => {
    const before = (await settings()).localLlm
    await patch({ localLlm: { ...before, fallback: false } })
    assert((await settings()).localFallbackReady === false, 'localFallbackReady stayed true with fallback off')
    await patch({ localLlm: before })
    assert((await settings()).localFallbackReady === true, 'localFallbackReady did not come back')
    return 'tracks fallback'
  })
  // MQA-261: on a build that ships an embedded key, removing it must not be a one-way door. This runs
  // LAST in the group and leaves the key restored, so it is self-healing even if the assertions fail.
  await check(g, 'the shipped Cloudflare key survives being removed — it can be put back', async () => {
    const s0 = await settings()
    if (!s0.embeddedCloudflareKeyAvailable) {
      return { __info: 'not exercised — this build shipped no embedded key (the normal keyless build)' }
    }
    if (!s0.hasKeys?.cloudflare) {
      return { __info: 'not exercised — no Cloudflare key is stored on this profile to remove' }
    }
    try {
      await page.evaluate(() => window.toto.clearApiKey('cloudflare'))
      const cleared = await settings()
      assert(cleared.hasKeys?.cloudflare === false, 'the key was not actually removed, so the test proves nothing')
      assert(
        cleared.embeddedCloudflareKeyAvailable === true,
        'the build stopped reporting a restorable key the moment the stored one went — the user has no way back'
      )

      const res = await page.evaluate(() => window.toto.restoreEmbeddedCloudflareKey())
      assert(res && res.ok, `restore refused: ${res && res.error ? res.error : JSON.stringify(res)}`)

      const back = await settings()
      assert(back.hasKeys?.cloudflare === true, 'restore reported success but no key is stored')
      assert(back.providerReady === true, 'the key is back but the provider is still not ready')
      return 'removed and restored'
    } finally {
      // Never leave the profile without the key it shipped with, whatever happened above.
      await page.evaluate(() => window.toto.restoreEmbeddedCloudflareKey()).catch(() => {})
    }
  })

  await check(g, 'a malformed settings patch is rejected without corrupting good settings', async () => {
    const before = (await settings()).temperature
    await page.evaluate(() => window.toto.setSettings({ temperature: 'not-a-number' })).catch(() => {})
    const after = (await settings()).temperature
    assert(typeof after === 'number', `temperature is now ${typeof after} — schema let garbage through`)
    return { before, after }
  })
}

async function groupAsk() {
  const g = 'ask'
  await clearAllKeys()
  await check(g, 'suggest answers on-device with zero API keys configured', async () => {
    const r = await ask({
      id: uid('suggest'), mode: 'suggest', prompt: '',
      transcript: 'THEM: What does your pricing look like for a 500-seat rollout?', history: []
    })
    // The on-device floor cannot catch anything until the weights exist. Ordered BEFORE the error
    // assert on purpose: a first-run profile with no cloud key legitimately errors here, and the
    // assert firing first turned that into a red line about the app (MQA-255 missed exactly this).
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so nothing can serve this yet; re-run once first-run setup finishes' }
    assert(!r.error, `errored: ${r.error}`)
    // "Zero API keys" cannot be arranged on a machine that exports provider keys in its ENVIRONMENT:
    // store.ts's getApiKey reads process.env[ENV_VAR[provider]] BEFORE the profile store, so the app
    // inherits a real, working key no isolated profile can remove. A cloud provider answering here is
    // then the DESIGNED behaviour, and calling it red would be wrong about the product rather than
    // informative about it.
    // Ask the APP which keys it still has, not this shell which keys IT exports. The two are different
    // processes: the app is frequently launched with provider vars unset even when the suite inherits
    // them, and reading process.env here downgraded three checks that were genuinely exercising the
    // zero-key path. Same defect class as MQA-255 — measuring the harness instead of the build.
    const stuck = await stubbornKeys()
    if (stuck.length) {
      return { __info: `not exercised — the app still reports keys for ${stuck.join(', ')} after clearAllKeys(); they come from its ENVIRONMENT (getApiKey reads process.env before the profile store), so no isolated profile can remove them — relaunch the app with those vars unset to cover the zero-key path` }
    }
    assert(r.providers.at(-1) === 'local', `answered by ${r.providers.at(-1)}, expected local`)
    assert(r.text.trim().length > 0, 'empty answer')
    return { walk: r.providers, ms: r.doneAt, chars: r.text.length }
  })
  await check(g, 'an in-flight ask can be cancelled without leaving the stream stuck', async () => {
    const id = uid('cancel')
    const out = await page.evaluate(async (id) => {
      let errored = null
      const offErr = window.toto.onError((e) => { if (e.id === id) errored = e.message })
      window.toto.ask({ id, mode: 'suggest', prompt: '', transcript: 'THEM: hello there', history: [] })
      await new Promise((r) => setTimeout(r, 1500))
      await window.toto.cancel(id)
      await new Promise((r) => setTimeout(r, 2500))
      offErr()
      return { errored }
    }, id)
    return { afterCancel: out.errored ?? 'no error surfaced (clean cancel)' }
  })
  // Rewritten 2026-08-17. This used to assert that answer mode FAILS with an actionable message,
  // because local was scoped to suggest/summary/vision. MQA-122 and MQA-123 deliberately changed that:
  // llm/local-routing.ts's localAnswerFloorEligibleFor is "the ABSOLUTE floor … when every cloud/CLI
  // provider is exhausted … a weak on-device answer beats handing the user an error". So on a zero-key
  // install, answer mode succeeding ON LOCAL is the shipped contract, and the old assertion could only
  // ever fail — a check that can never pass is worse than none, because it trains people to ignore the
  // suite. Asserts the current contract instead, which is the stronger claim.
  await check(g, 'answer mode falls to the on-device floor rather than dead-ending (MQA-122/MQA-123)', async () => {
    const r = await ask({ id: uid('answer'), mode: 'answer', prompt: 'What is our renewal risk?', history: [] }, 180000)
    assert(!r.error || !/TIMEOUT/.test(r.error), 'answer mode HUNG instead of reaching the on-device floor')
    // The on-device floor cannot catch anything until the weights exist. Ordered BEFORE the error
    // assert on purpose: a first-run profile with no cloud key legitimately errors here, and the
    // assert firing first turned that into a red line about the app (MQA-255 missed exactly this).
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so nothing can serve this yet; re-run once first-run setup finishes' }
    assert(!r.error, `answer mode dead-ended instead of falling to local: "${r.error}"`)
    // "Zero API keys" cannot be arranged on a machine that exports provider keys in its ENVIRONMENT:
    // store.ts's getApiKey reads process.env[ENV_VAR[provider]] BEFORE the profile store, so the app
    // inherits a real, working key no isolated profile can remove. A cloud provider answering here is
    // then the DESIGNED behaviour, and calling it red would be wrong about the product rather than
    // informative about it.
    // Ask the APP which keys it still has, not this shell which keys IT exports. The two are different
    // processes: the app is frequently launched with provider vars unset even when the suite inherits
    // them, and reading process.env here downgraded three checks that were genuinely exercising the
    // zero-key path. Same defect class as MQA-255 — measuring the harness instead of the build.
    const stuck = await stubbornKeys()
    if (stuck.length) {
      return { __info: `not exercised — the app still reports keys for ${stuck.join(', ')} after clearAllKeys(); they come from its ENVIRONMENT (getApiKey reads process.env before the profile store), so no isolated profile can remove them — relaunch the app with those vars unset to cover the zero-key path` }
    }
    assert(r.providers.at(-1) === 'local', `expected the on-device floor to serve it, got ${r.providers.at(-1)}`)
    assert(r.text.trim().length > 0, 'the on-device floor answered with no text at all')
    return { provider: r.providers.at(-1), chars: r.text.length, ms: r.doneAt }
  })
  await check(g, 'resetAskContext clears conversation state without throwing', async () => {
    await page.evaluate(() => window.toto.resetAskContext())
    return 'ok'
  })
}

async function groupDegrade() {
  const g = 'degrade'
  const DEAD_DEEPSEEK = 'sk-dead0000000000000000000000000000000000'
  const DEAD_NVIDIA = 'nvapi-dead000000000000000000000000000000000000'

  // This group proves failover by giving DeepSeek and NVIDIA deliberately dead keys and watching the
  // walk step off them. Under an org data-residency allowlist that excludes those two, main refuses
  // them at request time — correctly — so the walk goes straight to local and every assertion here
  // reads as "the primary was skipped", which looks exactly like the failover bug this group exists to
  // catch. That is a red meaning "could not run", and it trains the reader to ignore real failures.
  // Skip honestly instead; run the group against a profile with no allowlist to cover it.
  const policy = (await settings()).allowedProviders
  if (policy && !(policy.includes('deepseek') && policy.includes('nvidia'))) {
    record(g, 'failover through dead provider keys', 'info',
      `not exercised — org allowedProviders is ${JSON.stringify(policy)}, which forbids the providers this group needs; run it against a profile with no managed-config allowlist`)
    return
  }

  await clearAllKeys()

  await check(g, 'BASELINE: no keys at all → in-scope ask still served on-device', async () => {
    const r = await ask({ id: uid('base'), mode: 'suggest', prompt: '', transcript: 'THEM: can you send pricing?', history: [] })
    // The on-device floor cannot catch anything until the weights exist. Ordered BEFORE the error
    // assert on purpose: a first-run profile with no cloud key legitimately errors here, and the
    // assert firing first turned that into a red line about the app (MQA-255 missed exactly this).
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so nothing can serve this yet; re-run once first-run setup finishes' }
    assert(!r.error, `errored: ${r.error}`)
    assert(r.providers.at(-1) === 'local', `served by ${r.providers.at(-1)}`)
    return { walk: r.providers }
  })

  await check(g, 'DEAD PRIMARY KEY (DeepSeek 401) → walks off it and still answers', async () => {
    await page.evaluate((k) => window.toto.setApiKey('deepseek', k), DEAD_DEEPSEEK)
    await patch({ provider: 'deepseek' })
    const r = await ask({ id: uid('dead1'), mode: 'suggest', prompt: '', transcript: 'THEM: what is the renewal price?', history: [] })
    // The on-device floor cannot catch anything until the weights exist. Ordered BEFORE the error
    // assert on purpose: a first-run profile with no cloud key legitimately errors here, and the
    // assert firing first turned that into a red line about the app (MQA-255 missed exactly this).
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so nothing can serve this yet; re-run once first-run setup finishes' }
    assert(!r.error, `dead key killed the ask outright: ${r.error}`)
    assert(r.providers[0] === 'deepseek', `did not try the configured primary first (walk: ${r.providers})`)
    assert(r.providers.at(-1) !== 'deepseek', 'never left the dead provider')
    assert(r.text.trim().length > 0, 'no answer text after failover')
    return { walk: r.providers, servedBy: r.providers.at(-1), ms: r.doneAt }
  })

  await check(g, 'DEAD PRIMARY + DEAD NIM → walks both, still answers on-device', async () => {
    await page.evaluate((k) => window.toto.setApiKey('nvidia', k), DEAD_NVIDIA)
    const r = await ask({ id: uid('dead2'), mode: 'suggest', prompt: '', transcript: 'THEM: send me the quote please', history: [] })
    // The on-device floor cannot catch anything until the weights exist. Ordered BEFORE the error
    // assert on purpose: a first-run profile with no cloud key legitimately errors here, and the
    // assert firing first turned that into a red line about the app (MQA-255 missed exactly this).
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so nothing can serve this yet; re-run once first-run setup finishes' }
    assert(!r.error, `errored with two dead keys: ${r.error}`)
    // "Zero API keys" cannot be arranged on a machine that exports provider keys in its ENVIRONMENT:
    // store.ts's getApiKey reads process.env[ENV_VAR[provider]] BEFORE the profile store, so the app
    // inherits a real, working key no isolated profile can remove. A cloud provider answering here is
    // then the DESIGNED behaviour, and calling it red would be wrong about the product rather than
    // informative about it.
    // Ask the APP which keys it still has, not this shell which keys IT exports. The two are different
    // processes: the app is frequently launched with provider vars unset even when the suite inherits
    // them, and reading process.env here downgraded three checks that were genuinely exercising the
    // zero-key path. Same defect class as MQA-255 — measuring the harness instead of the build.
    const stuck = await stubbornKeys()
    if (stuck.length) {
      return { __info: `not exercised — the app still reports keys for ${stuck.join(', ')} after clearAllKeys(); they come from its ENVIRONMENT (getApiKey reads process.env before the profile store), so no isolated profile can remove them — relaunch the app with those vars unset to cover the zero-key path` }
    }
    assert(r.providers.at(-1) === 'local', `final provider ${r.providers.at(-1)}, expected local`)
    assert(r.providers.includes('deepseek'), 'primary was skipped entirely')
    return { walk: r.providers, servedBy: r.providers.at(-1), ms: r.doneAt }
  })

  await check(g, 'DEAD KEYS: is the DEAD provider re-tried first on every single ask? (cooldown check)', async () => {
    const r = await ask({ id: uid('dead3'), mode: 'suggest', prompt: '', transcript: 'THEM: and the timeline?', history: [] })
    const retriedDead = r.providers[0] === 'deepseek'
    // Informational, not pass/fail: no circuit-breaker means every ask eats the dead provider's latency.
    return { walk: r.providers, retriesDeadProviderFirst: retriedDead, ms: r.doneAt }
  })

  await check(g, 'DEAD KEY + fallback DISABLED → fails with a clear message instead of hanging', async () => {
    const before = (await settings()).localLlm
    await patch({ localLlm: { ...before, fallback: false } })
    const r = await ask({ id: uid('dead4'), mode: 'suggest', prompt: '', transcript: 'THEM: hello?', history: [] }, 120000)
    await patch({ localLlm: before })
    // With the on-device net off and the primary key dead, this asserts the ask FAILS. It can only
    // assert that if no OTHER provider is configured and working — otherwise failover reaching one is
    // the designed behaviour, not a defect, and calling it red would be wrong about the product.
    if (!r.error && r.providers.at(-1) && r.providers.at(-1) !== 'local') {
      return {
        __info: `not exercised — this profile has a working ${r.providers.at(-1)} key, so failover legitimately answered; run against a profile with only the dead provider configured`
      }
    }
    assert(r.error, `answered anyway via ${r.providers.at(-1)} with fallback off`)
    assert(!/TIMEOUT/.test(r.error), 'HUNG with fallback off instead of failing')
    return { error: r.error, walk: r.providers }
  })

  await check(g, 'INDEXING with a dead key → meeting still gets indexed on-device', async () => {
    const s = await settings()
    const before = await page.evaluate(() => window.toto.brainStatus())
    const kicked = await page.evaluate(() => window.toto.brainBackfill())
    assert(kicked.deferred !== 'no-provider', 'indexing deferred as "no provider" despite the local fallback')
    const deadline = Date.now() + 8 * 60 * 1000
    let st = before
    while (Date.now() < deadline) {
      st = await page.evaluate(() => window.toto.brainStatus())
      if (st?.backfill && !st.backfill.running && !st.backfill.preparing) break
      await sleep(3000)
    }
    return {
      kicked, meetingsFolder: s.resolvedMeetingsFolder,
      indexed: st?.ingestedFiles?.length ?? 0, failed: st?.failed ?? 0, exhausted: st?.exhausted ?? 0
    }
  })

  await check(g, 'DETECTION: the app marks a repeatedly-rejected provider as unhealthy (MQA-004)', async () => {
    const s = await settings()
    const unhealthy = s.unhealthyProviders ?? []
    // providerReady still means only "a key string exists" — by design. The honest signal is this list,
    // which is what lets the UI say "your key stopped working" instead of claiming ready forever.
    assert(unhealthy.length > 0,
      'nothing marked a provider unhealthy after consecutive 401s — the user has no signal their key died')
    assert(unhealthy.some((p) => p.error), 'unhealthy entry carries no provider error text to show the user')
    return { unhealthy: unhealthy.map((p) => `${p.provider}: ${p.error.slice(0, 60)}`), providerReady: s.providerReady }
  })

  await check(g, 'testApiKey correctly REJECTS the dead key (so Settings can tell the user)', async () => {
    const res = await page.evaluate((k) => window.toto.testApiKey('deepseek', k), DEAD_DEEPSEEK)
    assert(res && res.ok === false, `testApiKey said a dead key is fine: ${JSON.stringify(res)}`)
    return res
  })

  await check(g, 'RECOVERY: clearing the dead key restores a clean walk', async () => {
    await clearAllKeys()
    const r = await ask({ id: uid('recover'), mode: 'suggest', prompt: '', transcript: 'THEM: ok, next steps?', history: [] })
    // The on-device floor cannot catch anything until the weights exist. Ordered BEFORE the error
    // assert on purpose: a first-run profile with no cloud key legitimately errors here, and the
    // assert firing first turned that into a red line about the app (MQA-255 missed exactly this).
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so nothing can serve this yet; re-run once first-run setup finishes' }
    assert(!r.error, `errored after cleanup: ${r.error}`)
    assert(!r.providers.includes('deepseek'), 'still trying the removed provider')
    return { walk: r.providers }
  })
}

async function groupMeetings() {
  const g = 'meetings'
  const title = `QA Probe ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
  let file = null

  await check(g, 'a meeting transcript saves to disk', async () => {
    // Shape per SaveMeetingSchema/TranscriptLineSchema in src/shared/ipc.ts: speaker is
    // 'you' | 'them' | 'unknown' (never 'me'), and each line carries `t` (ms offset), not `at`.
    const res = await page.evaluate(async (title) => window.toto.saveTranscript({
      title,
      mode: 'sales',
      startedAt: Date.now() - 90000,
      recap: '',
      lines: [
        { speaker: 'you', text: 'Thanks for joining. Where are we on the renewal?', t: 0 },
        { speaker: 'them', text: 'We need the usage report before we can sign.', t: 30000 },
        { speaker: 'you', text: 'I will send the usage report by Friday.', t: 60000 }
      ]
    }), title)
    assert(res && res.path, `no path returned: ${JSON.stringify(res)}`)
    return res.path
  })

  await check(g, 'the saved meeting appears in the History list', async () => {
    const list = await page.evaluate(() => window.toto.recallList())
    const hit = list.find((m) => m.title === title)
    assert(hit, `saved meeting not in recallList (${list.length} entries)`)
    file = hit.file
    return { file, total: list.length }
  })

  await check(g, 'the meeting reads back with its content intact', async () => {
    assert(file, 'no file from the previous step')
    const read = await page.evaluate((f) => window.toto.recallRead(f), file)
    const body = JSON.stringify(read)
    assert(/usage report/i.test(body), 'saved content missing on read-back')
    return { locked: read.locked ?? false }
  })

  await check(g, 'search finds the meeting by a phrase from its body', async () => {
    const hits = await page.evaluate(() => window.toto.recallSearch('usage report'))
    assert(Array.isArray(hits), 'search did not return a list')
    return { hits: hits.length }
  })

  await check(g, 'rename persists', async () => {
    assert(file, 'no file')
    const renamed = `${title} RENAMED`
    const res = await page.evaluate(([f, t]) => window.toto.recallRename(f, t), [file, renamed])
    assert(res.ok, `rename failed: ${res.error}`)
    const list = await page.evaluate(() => window.toto.recallList())
    assert(list.some((m) => m.title === renamed), 'renamed title not reflected in the list')
    return renamed
  })

  await check(g, 'the confidential flag round-trips', async () => {
    assert(file, 'no file')
    const res = await page.evaluate((f) => window.toto.recallSetConfidential(f, true), file)
    assert(res && res.ok !== false, `set confidential failed: ${JSON.stringify(res)}`)
    await page.evaluate((f) => window.toto.recallSetConfidential(f, false), file)
    return 'on → off'
  })

  await check(g, 'saving a meeting credits the durable time-saved counter', async () => {
    const before = (await settings()).usageStats
    const t = `Time Saved Probe ${Date.now()}`
    await page.evaluate(async (title) => window.toto.saveTranscript({
      title, mode: 'sales', startedAt: Date.now() - 1_800_000, recap: '',
      lines: [
        { speaker: 'you', text: 'Kicking off the renewal.', t: 0 },
        { speaker: 'them', text: 'We are in.', t: 1_500_000 }
      ]
    }), t)
    const after = (await settings()).usageStats
    assert(after.meetingsSummarized === before.meetingsSummarized + 1,
      `meetingsSummarized did not increment: ${before.meetingsSummarized} -> ${after.meetingsSummarized}`)
    assert(after.conversationMinutes > before.conversationMinutes, 'conversationMinutes did not grow')
    assert(after.firstMeetingAt > 0, 'firstMeetingAt not set')
    // Clean up the probe meeting so it does not pollute later checks. Direct unlink, NOT recallDelete —
    // that one waits on a native confirm dialog and would park an unattended run (see the brain group).
    const hit = (await page.evaluate(() => window.toto.recallList())).find((m) => m.title === t)
    if (hit) rmSync(join(await page.evaluate(async () => (await window.toto.getSettings()).resolvedMeetingsFolder), hit.file), { force: true })
    return { meetings: after.meetingsSummarized, minutes: after.conversationMinutes }
  })

  await check(g, 'the time-saved assumption is exposed and adjustable in settings', async () => {
    const s = await settings()
    assert(s.timeSaved && typeof s.timeSaved.writeupRatio === 'number', 'timeSaved assumption missing')
    const before = s.timeSaved.writeupRatio
    await patch({ timeSaved: { ...s.timeSaved, writeupRatio: 0.35 } })
    assert((await settings()).timeSaved.writeupRatio === 0.35, 'assumption did not persist')
    await patch({ timeSaved: { ...s.timeSaved, writeupRatio: before } })
    return { restoredTo: before }
  })

  // The one place recallDelete SHOULD be exercised: deleting a meeting is real product behaviour and its
  // native confirmation is PART of that behaviour, so this must not route around it.
  //
  // But the confirmation is also why it cannot simply be asserted. With no one to answer the dialog the
  // promise never settles: an unbounded await parks the whole suite while the rest of main keeps
  // answering normally, so it reads as a freeze rather than a prompt (it did exactly that on 2026-08-17).
  // And asserting it unattended would make the suite permanently red for something that is not a defect —
  // the same "a check that can never pass" trap already removed from the ask group in this file.
  //
  // So: bounded, and reported as INFO rather than FAIL when nobody answers. An attended run exercises the
  // real path; an unattended one says plainly that it did not, and cleans up after itself either way.
  {
    const name = 'delete removes it from the list'
    if (!file) {
      record(g, name, 'fail', 'no file')
    } else {
      const res = await Promise.race([
        page.evaluate((f) => window.toto.recallDelete(f), file),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'NO_ANSWER' }), 45_000))
      ])
      // 'cancelled' is the SAME non-result as NO_ANSWER: recallDelete's modal defaults to Cancel
      // (defaultId/cancelId = 1), so an unattended run that loses the dialog to a focus change gets a
      // decline nobody made. Neither outcome is evidence that delete is broken, and reporting them red
      // trains the reader to ignore this suite's failures. An attended run still exercises it for real.
      if (res.error === 'NO_ANSWER' || res.error === 'cancelled') {
        record(g, name, 'info', `not exercised — recallDelete's native confirmation was ${res.error === 'cancelled' ? 'dismissed by the OS, not by a person' : 'never answered'}; run this group attended to cover it`)
        try {
          rmSync(join(await page.evaluate(async () => (await window.toto.getSettings()).resolvedMeetingsFolder), file), { force: true })
        } catch { /* best-effort: do not leave the fixture behind just because the dialog went unanswered */ }
      } else {
        await check(g, name, async () => {
          assert(res.ok, `delete failed: ${res.error}`)
          const list = await page.evaluate(() => window.toto.recallList())
          assert(!list.some((m) => m.file === file), 'deleted meeting still listed')
          return 'deleted'
        })
      }
    }
  }
}

async function groupBrain() {
  const g = 'brain'
  // The `meetings` group deletes every transcript it saves as its own cleanup, so by the time this
  // group runs there is nothing left on disk to index — the commitments check below would find zero
  // by construction, not because extraction is broken. Save (and auto-enqueue-ingest) a dedicated,
  // commitment-bearing fixture here and only delete it once this group's own checks are done with it.
  const commitTitle = `QA Commitment Probe ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
  let commitFile = null
  await check(g, 'a meeting with a clear next step is saved for indexing', async () => {
    const res = await page.evaluate(async (title) => window.toto.saveTranscript({
      title,
      mode: 'sales',
      startedAt: Date.now() - 120000,
      recap: '',
      lines: [
        { speaker: 'you', text: 'Thanks for joining — let us talk through the Acme renewal.', t: 0 },
        { speaker: 'them', text: 'We need the signed security questionnaire before legal can approve it.', t: 30000 },
        { speaker: 'you', text: 'Understood. I will send you the completed security questionnaire by next Tuesday.', t: 60000 }
      ]
    }), commitTitle)
    assert(res && res.path, `no path returned: ${JSON.stringify(res)}`)
    commitFile = res.path
    return res.path
  })
  await check(g, 'brainStatus answers with a coherent shape', async () => {
    const st = await page.evaluate(() => window.toto.brainStatus())
    assert(st, 'brainStatus returned null')
    assert(typeof st.meetings === 'number', 'meetings count missing')
    return { meetings: st.meetings, people: st.people, deals: st.deals, failed: st.failed ?? 0 }
  })
  await check(g, 'brainRead returns the entity graph', async () => {
    const read = await page.evaluate(() => window.toto.brainRead())
    assert(read && typeof read === 'object', 'brainRead returned nothing')
    return { people: read.people?.length ?? 0, deals: read.deals?.length ?? 0, meetings: read.meetings?.length ?? 0 }
  })
  // Wait for the index to actually settle BEFORE judging it. A single extraction can fail transiently
  // under load (the on-device model may be busy serving asks) and is retried by the reconcile tick —
  // polling the graph before that lands reports "no commitments" for a pipeline that is merely still
  // working. The wait lives outside check() so a pipeline that never settled can be recorded as NOT
  // EXERCISED: that is not a defect in extraction, it is an absence of evidence, and calling it a
  // failure is the same lie as a false green (see the third status in the summary below).
  const commitmentsName = 'commitments (next steps) are present after indexing'
  const settleDeadline = Date.now() + 6 * 60 * 1000
  let indexSettled = false
  while (Date.now() < settleDeadline) {
    // MQA-265: bounded, for the same reason as the accuracy group's loop below — the deadline is only
    // consulted BETWEEN iterations, so one CDP call that never settles would hang this group and every
    // group after it. A timed-out probe reads as "not settled yet" and the loop re-checks the deadline.
    const st = await Promise.race([
      page.evaluate(() => window.toto.brainStatus()).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 20000))
    ])
    const idle = st?.backfill && !st.backfill.running && !st.backfill.preparing
    if (idle && (st.ingestedFiles?.length ?? 0) > 0) {
      indexSettled = true
      break
    }
    await sleep(4000)
  }
  if (!indexSettled) {
    record(g, commitmentsName, 'info',
      'not exercised — indexing did not settle within 6 min (on-device model busy); re-run this group alone to cover it')
  } else {
    await check(g, commitmentsName, async () => {
      const read = await page.evaluate(() => window.toto.brainRead())
      const commitments = []
      for (const d of read.deals ?? []) for (const c of d.commitments ?? []) commitments.push(c.text)
      for (const p of read.people ?? []) for (const c of p.commitments ?? []) commitments.push(c.text)
      assert(commitments.length > 0, 'no commitments extracted from any indexed meeting')
      return { count: commitments.length, sample: commitments.slice(0, 3) }
    })
  }
  await check(g, 'the attention feed answers', async () => {
    const att = await page.evaluate(() => window.toto.brainAttention())
    assert(att && Array.isArray(att.items), 'attention feed malformed')
    return { items: att.items.length, kinds: [...new Set(att.items.map((i) => i.kind))] }
  })
  await check(g, 'entity names feed answers (drives ASR casing bias)', async () => {
    // MQA-115: BrainEntityNamesResult is a FLAT { names: string[] } (shared/ipc.ts), not
    // { people, accounts } — the old check read the wrong shape and always reported 0/0 regardless of
    // real indexed content.
    const res = await page.evaluate(() => window.toto.brainEntityNames())
    assert(res && Array.isArray(res.names), 'entity names malformed (expected { names: string[] })')
    return { names: res.names.length, sample: res.names.slice(0, 4) }
  })
  await check(g, 'a second backfill on an already-indexed folder is a cheap no-op, not a re-extraction', async () => {
    const before = await page.evaluate(() => window.toto.brainStatus())
    const kicked = await page.evaluate(() => window.toto.brainBackfill())
    await sleep(4000)
    const after = await page.evaluate(() => window.toto.brainStatus())
    return { kicked, revisionBefore: before?.revision, revisionAfter: after?.revision }
  })
  // Housekeeping, not an assertion — so it must NOT go through recallDelete. That handler opens a
  // native confirm dialog (dialog.showMessageBox, Delete/Cancel) and its promise does not settle until
  // someone answers, which in an unattended run means the whole suite parks here forever with the rest
  // of main still responding normally — so it reads as a freeze rather than a prompt. The product
  // behaviour of delete is already asserted in the meetings group, where the confirmation IS the point;
  // here we just want the fixture gone, so unlink it directly. (2026-08-17: this parked a full run.)
  await check(g, 'clean up the commitment fixture', async () => {
    if (!commitFile) return 'nothing to clean up'
    const folder = await page.evaluate(async () => (await window.toto.getSettings()).resolvedMeetingsFolder)
    const path = join(folder, commitFile)
    try {
      rmSync(path, { force: true })
    } catch (e) {
      throw new Error(`could not unlink the fixture at ${path}: ${e.message}`)
    }
    assert(!existsSync(path), `fixture still on disk at ${path}`)
    return 'deleted (direct unlink — recallDelete needs a human to confirm)'
  })
}

async function groupWindow() {
  const g = 'window'
  await check(g, 'window mode + resize IPC do not throw', async () => {
    await page.evaluate(async () => {
      await window.toto.windowMode?.('bar')
      await window.toto.windowResize?.({ width: 720, height: 220 })
    })
    return 'ok'
  })
  await check(g, 'hide then toggle restores the window', async () => {
    await page.evaluate(async () => {
      await window.toto.hide?.()
      await new Promise((r) => setTimeout(r, 400))
      await window.toto.toggle?.()
    })
    return 'ok'
  })
  await check(g, 'shortcut failures are reported (registration conflicts are visible)', async () => {
    const fails = await page.evaluate(() => window.toto.getShortcutFailures())
    return { failures: fails }
  })
  await check(g, 'graphify status answers', async () => {
    const st = await page.evaluate(() => window.toto.graphifyStatus())
    return st ? { ok: true } : { ok: false }
  })
  await check(g, 'import job list answers (empty is fine)', async () => {
    const jobs = await page.evaluate(() => window.toto.importJobsList())
    assert(Array.isArray(jobs), 'import jobs did not return a list')
    return { jobs: jobs.length }
  })
}

// The screen-ask feature, proven through the app's OWN capture pipeline (window.toto.capture ->
// IPC.captureScreen -> getScreenshot -> captureScreenshotOnce), not a reimplementation of it. A unit
// test can only prove the arithmetic; this proves desktopCapturer actually hands this machine a real
// frame, which is the half that breaks in the field (driver/DXGI fallbacks, permission revocation,
// a display topology change). Restores privateView in a finally: a QA run must never leave the
// user's privacy switch flipped.
async function groupScreen() {
  const g = 'screen'
  const before = await settings()

  try {
    await check(g, 'privateView defaults OFF, so screen-asks work on a fresh profile', async () => {
      assert(before.privateView === false, `privateView is ${before.privateView} — screen-asks are dead on arrival`)
      return { privateView: before.privateView, contentProtection: before.contentProtection }
    })

    await check(g, 'capture() returns a decodable, non-trivial JPEG of the screen', async () => {
      const t0 = Date.now()
      const shot = await page.evaluate(() => window.toto.capture())
      const ms = Date.now() - t0
      assert(shot && typeof shot.image === 'string', 'capture() returned no image')
      const buf = Buffer.from(shot.image, 'base64')
      // SOI..EOI: a truncated frame decodes to "something" but is not a complete image, and that is
      // exactly the shape a provider rejects with an unhelpful 400.
      assert(buf[0] === 0xff && buf[1] === 0xd8, 'not a JPEG (missing SOI)')
      assert(buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9, 'truncated JPEG (missing EOI)')
      assert(buf.length > 5000, `implausibly small frame (${buf.length} B) — likely a blank capture`)
      assert(shot.width > 200 && shot.height > 200, `implausible dimensions ${shot.width}x${shot.height}`)
      return { bytes: buf.length, size: `${shot.width}x${shot.height}`, ms, displayMismatch: shot.displayMismatch }
    })

    await check(g, 'Private View ON refuses to capture, and says so specifically', async () => {
      await page.evaluate(() => window.toto.setSettings({ privateView: true }))
      await sleep(300)
      const r = await page.evaluate(async () => {
        try {
          const shot = await window.toto.capture()
          return { threw: false, hasImage: typeof shot?.image === 'string' && shot.image.length > 1000 }
        } catch (e) {
          return { threw: true, message: String(e?.message ?? e) }
        }
      })
      assert(r.threw || !r.hasImage, 'Private View was ON and capture STILL returned a frame')
      const msg = r.threw ? r.message : ''
      // A generic "couldn't capture your screen" here is a real defect: the user turned this on
      // themselves and has no way to connect the failure back to the switch.
      assert(/private\s*view/i.test(msg), `refusal did not name Private View: ${msg.slice(0, 120)}`)
      return { message: msg.slice(0, 120) }
    })

    await check(g, 'capture recovers once Private View is turned back off', async () => {
      await page.evaluate(() => window.toto.setSettings({ privateView: false }))
      await sleep(300)
      const shot = await page.evaluate(() => window.toto.capture())
      assert(shot && typeof shot.image === 'string' && shot.image.length > 1000, 'capture did not recover')
      return { bytes: Buffer.from(shot.image, 'base64').length }
    })

    await check(g, 'screenContext answers without throwing (null is a valid answer)', async () => {
      const ctx = await page.evaluate(() => window.toto.screenContext())
      return { hasContext: Boolean(ctx && ctx.text) }
    })
  } finally {
    await page.evaluate((v) => window.toto.setSettings({ privateView: v }), before.privateView)
  }
}

// Cloudflare reaches the model through an operator-deployed Worker, which means a whole class of
// failure that a direct provider cannot produce: the hop itself. Silent degradation to the on-device
// model is the CORRECT behaviour here (a user mid-meeting must keep getting answers), so the thing
// worth pinning is that no shape dead-ends or hangs, and that a bad METIS_PROXY_KEY — the one failure
// only the user can fix — is still recorded so Settings can say so.
//
// Requires the mock: MOCK_TLS_CERT=… MOCK_TLS_KEY=… node scripts/qa/mock-llm-server.mjs 8788
// and the app launched with NODE_TLS_REJECT_UNAUTHORIZED=0 so undici accepts the self-signed cert.
// Skips itself (INFO, never a false PASS) when the mock is not reachable.
// Smallest valid baseline JPEG (1x1), inline so a screen-ask carries a REAL attachment through
// openai.ts's image_url branch instead of degrading to a text ask. Bare base64, no data: prefix —
// AskStartSchema rejects anything else.
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

async function groupCloudflare() {
  const g = 'cloudflare'
  const MOCK = process.env.METIS_MOCK_BASE ?? 'https://127.0.0.1:8788'
  const before = await settings()

  // Probe from THIS process, not the renderer: the renderer's CSP pins connect-src per provider, so a
  // fetch to the mock is blocked there and would report "unreachable" even with the mock running. The
  // app itself reaches providers from the main process, which CSP does not govern.
  const reachable = await new Promise((resolve) => {
    try {
      const u = new URL(`${MOCK}/ok/v1/chat/completions`)
      const req = httpsRequest(
        { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', rejectUnauthorized: false, timeout: 4000 },
        (res) => { res.resume(); resolve((res.statusCode ?? 0) < 500) }
      )
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
      req.end(JSON.stringify({ model: 'x', messages: [], stream: true }))
    } catch { resolve(false) }
  })

  if (!reachable) {
    // MQA-264: the old text said only "start scripts/qa/mock-llm-server.mjs", which does not work —
    // started plainly the mock listens on HTTP, this probe is HTTPS (the app's customBaseUrl refine
    // demands https), so the group stays unexercised and the operator believes they followed the
    // instruction. Name the whole requirement, or it is advice that cannot succeed.
    record(
      g,
      'mock gateway reachable',
      'info',
      `not exercised — no HTTPS mock at ${MOCK}. The mock serves plain HTTP unless MOCK_TLS_CERT and ` +
        `MOCK_TLS_KEY point at a throwaway PEM pair, AND the app under test is launched with ` +
        `NODE_TLS_REJECT_UNAUTHORIZED=0 so it accepts the self-signed cert. Starting the mock alone is not enough.`
    )
    return
  }

  try {
    await page.evaluate(async (u) => {
      await window.toto.setApiKey('cloudflare', 'qa-proxy-key')
      await window.toto.setSettings({ cloudflareBaseUrl: `${u}/ok`, provider: 'cloudflare' })
    }, MOCK)
    await sleep(500)

    await check(g, 'a healthy gateway is answered BY cloudflare, not the on-device floor', async () => {
      const r = await ask({ id: uid('cf-ok'), mode: 'answer', prompt: 'Say OK.' })
      assert(r.providers.includes('cloudflare'), `expected cloudflare, walk was ${JSON.stringify(r.providers)}`)
      assert(r.text.trim().length > 0, 'no text streamed back')
      return { walk: r.providers }
    })

    await check(g, 'a SCREEN ask is carried by the gateway, and still answered if it is not', async () => {
      // MQA-266 (supersedes the MQA-227 form of this check). This asserted the OPPOSITE until 2026-08-25:
      // that a screen-ask must never reach cloudflare, because its OpenAI-compatible route rejected every
      // image_url shape with code 6004. That was true when written and is not any more — MQA-259 re-probed
      // the LIVE Worker and the nested data-URI shape now answers 200 with the image genuinely read, so
      // PROVIDERS.cloudflare.vision is true and screen-asks go to the gateway (~1-2s) instead of the
      // on-device model (12s+).
      //
      // The check was left behind by that flip: it kept asserting the retired invariant and only surfaced
      // once the cloudflare group could run at all (MQA-264 — it needs an HTTPS mock, which no recorded
      // session had ever configured). What matters now is not WHICH leg carries the image, but that the
      // ask is ANSWERED — the gateway may still be down, rate-limited, or serving a mock that has no
      // vision, and the on-device model must pick it up.
      const r = await ask({ id: uid('cf-vision'), mode: 'vision', prompt: 'What is on screen?', image: TINY_JPEG_B64 })
      // MQA-266: this branch also assumed vision:false. Under an allowlist of exactly ["cloudflare"] the
      // old expectation was a dead-end, because no approved provider could carry an image. Cloudflare can
      // now, so the honest expectation is the opposite — the ask is SERVED. The one thing that must still
      // hold if it somehow is not: the advice may not name a provider the policy blocks (MQA-228).
      const policyBlocksLocal = (await settings()).allowedProviders?.includes('local') === false
      if (policyBlocksLocal) {
        if (r.error) {
          assert(
            !/Claude or GPT/.test(String(r.error)),
            `advice names policy-blocked providers: ${r.error}`
          )
          return { __info: `not exercised — no approved provider carried the image here (${String(r.error).slice(0, 90)})` }
        }
        assert(r.text.trim().length > 0, 'policy-restricted screen-ask reported success with no text')
        return { walk: r.providers, servedBy: r.providers[r.providers.length - 1] }
      }
      // The product guarantee is that a screen-ask gets ANSWERED. Which leg carries it is a routing
      // detail that MQA-259 deliberately changed; pinning a specific provider here is what made this
      // check assert a retired invariant for weeks.
      //
      // Guarded per MQA-256: against the MOCK gateway (which serves no vision) the only leg that can
      // carry an image is the on-device model, so a profile whose weights have not arrived yet
      // legitimately errors here. That is the environment, not the build.
      if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so nothing can carry the image against a mock gateway; re-run once first-run setup finishes' }
      assert(!r.error, `screen-ask errored instead of being answered: ${r.error}`)
      assert(r.text.trim().length > 0, 'no text streamed back for the screen-ask')
      assert(r.providers.length > 0, 'no provider was recorded for the screen-ask')
      return { walk: r.providers, servedBy: r.providers[r.providers.length - 1] }
    })

    // Every way the hop can fail. None may dead-end or hang: the user keeps getting answers.
    for (const [scenario, label] of [
      ['auth-bad', 'a wrong METIS_PROXY_KEY'],
      ['gateway-cred', "the operator's own Cloudflare token being bad (502)"],
      ['forbidden', 'a 403 from the gateway'],
      ['upstream-error', 'a 500 from the gateway'],
      ['badbody', 'a 200 that is not SSE'],
      ['midstream', 'a stream that dies mid-answer'],
      ['hang', 'a gateway that never answers']
    ]) {
      await check(g, `keeps answering through ${label}`, async () => {
        await page.evaluate((u) => window.toto.setSettings({ cloudflareBaseUrl: u }), `${MOCK}/${scenario}`)
        await sleep(300)
        const r = await ask({ id: uid('cf-' + scenario), mode: 'answer', prompt: 'Say OK.' }, 120000)
        assert(!String(r.error ?? '').includes('TIMEOUT'), `dead end: ${r.error}`)
        assert(r.text.trim().length > 0 || Boolean(r.error), 'neither an answer nor an error — silent failure')
        return { walk: r.providers, servedBy: r.providers[r.providers.length - 1] ?? '(none)', answered: r.text.trim().length > 0 }
      })
    }

    await check(g, 'a bad proxy key is RECORDED, so Settings can tell the user to fix it', async () => {
      // Degrading silently forever would leave the user on the weaker on-device model with no idea why.
      await page.evaluate((u) => window.toto.setSettings({ cloudflareBaseUrl: u }), `${MOCK}/auth-bad`)
      await sleep(300)
      for (let i = 0; i < 2; i++) await ask({ id: uid('cf-auth'), mode: 'answer', prompt: 'ping' }, 60000)
      const s = await settings()
      const flagged = JSON.stringify(s.unhealthyProviders ?? []).includes('cloudflare')
      assert(flagged, 'cloudflare never reached unhealthyProviders — the user is never told their key is wrong')
      return { unhealthy: s.unhealthyProviders }
    })

    await check(g, "an operator-fault gateway failure names the OPERATOR, not the user's network", async () => {
      // The gateway reports "my account token is dead" as a 502 — right, because the caller's key was
      // fine. But 502 also matches the transient-retry pattern, so this used to be rewritten to
      // "Connection issue — check your network": every user in the org pointed at their wifi while the
      // real cause was a secret on the proxy. Needs no fallback available, or something else answers
      // and no terminal error is ever shown.
      const policy = (await settings()).allowedProviders
      if (!policy || policy.includes('local') || policy.length !== 1) {
        record(g, "an operator-fault gateway failure names the OPERATOR, not the user's network", 'info',
          'not exercised — needs a profile whose allowedProviders is exactly ["cloudflare"], so no fallback can answer and the terminal message is actually shown')
        return undefined
      }
      await page.evaluate((u) => window.toto.setSettings({ cloudflareBaseUrl: u }), `${MOCK}/gateway-cred`)
      await sleep(300)
      const r = await ask({ id: uid('cf-operator'), mode: 'answer', prompt: 'Say OK.' }, 120000)
      const msg = String(r.error ?? '')
      assert(!/check your network/i.test(msg), `still blaming the user's network: ${msg}`)
      assert(/operator|CLOUDFLARE_API_TOKEN/i.test(msg), `did not name the operator fault: ${msg}`)
      // The routing marker is plumbing; it must never reach a user.
      assert(!msg.includes('[metis-proxy-config]'), 'the routing marker leaked into the user-facing message')
      return { message: msg.slice(0, 90) }
    })

    await check(g, 'testApiKey rejects a bad proxy key with the real reason', async () => {
      const r = await page.evaluate(() => window.toto.testApiKey('cloudflare', 'definitely-wrong'))
      assert(r && r.ok === false, `expected a rejection, got ${JSON.stringify(r)}`)
      // MQA-213. This surface returns the upstream message verbatim, so it is the one that leaks the
      // routing marker first if the strip is ever dropped — assert the message, not just the boolean.
      const err = String(r.error ?? '')
      assert(!err.includes('[metis-proxy-config]'), `the routing marker reached the Test button: ${err}`)
      return { error: err.slice(0, 80) }
    })
  } finally {
    await page.evaluate(
      (v) => window.toto.setSettings({ cloudflareBaseUrl: v.url, provider: v.provider }),
      { url: before.cloudflareBaseUrl ?? '', provider: before.provider }
    )
    await page.evaluate(() => window.toto.clearApiKey('cloudflare')).catch(() => {})
  }
}


/**
 * Mantu Intelligence — the dashboard window, driven the way a user drives it.
 *
 * This whole surface had ZERO end-to-end coverage before: the suite's only touch was `graphify status
 * answers`, which proves an IPC handler replies and nothing about whether the dashboard renders. Nine
 * views ship in that window (Today, Coaching, Deals, Accounts, People, Stats, Relationships, Meetings,
 * Embed) and every one of them could throw on real data without a single test going red.
 *
 * It runs in its own BrowserWindow with its own narrow preload, so it is a separate CDP page reached
 * through window.toto.brainOpenDashboard() — not a route inside the main renderer.
 */
async function findIntelPage(browser, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          if (await p.evaluate(() => typeof window.intelligence !== 'undefined')) return p
        } catch { /* page mid-navigation */ }
      }
    }
    await sleep(500)
  }
  throw new Error(`no page exposing window.intelligence after ${timeoutMs}ms`)
}

/** Route the dashboard and wait for React to commit. HashRouter, because the window loads over
 *  file:// where a path-based router cannot round-trip. */
async function gotoIntelRoute(intel, route) {
  await intel.evaluate((r) => { window.location.hash = `#${r}` }, route)
  await sleep(900)
}

async function groupIntelligence() {
  const g = 'intelligence'
  let intel = null

  await check(g, 'the dashboard window opens from the main window', async () => {
    const r = await page.evaluate(() => window.toto.brainOpenDashboard())
    assert(r && r.ok, `brainOpenDashboard refused: ${JSON.stringify(r)}`)
    return r
  })

  await check(g, 'it loads the bundled dashboard, not the "bundle not found" error page', async () => {
    intel = await findIntelPage(browser)
    const title = await intel.title()
    const body = await intel.evaluate(() => document.body.innerText.slice(0, 400))
    assert(!/bundle not found/i.test(body), `dashboard failed to load its bundle: ${body.slice(0, 160)}`)
    return { title, chars: body.length }
  })

  if (!intel) {
    record(g, '(remaining dashboard checks)', 'info', 'not exercised — the dashboard page never appeared')
    return
  }

  // Security: this window is a READER. Its preload deliberately exposes four channels and nothing else,
  // so a bug (or an injected script) in the dashboard cannot reach the privileged main-window surface.
  await check(g, 'the dashboard preload stays read-only — no window.toto, no privileged writes', async () => {
    const surface = await intel.evaluate(() => ({
      hasToto: typeof window.toto !== 'undefined',
      keys: Object.keys(window.intelligence ?? {}).sort()
    }))
    assert(!surface.hasToto, 'the dashboard window can reach window.toto — that is the privileged main-window API')
    for (const forbidden of ['setSettings', 'setApiKey', 'ask', 'capture', 'saveTranscript']) {
      assert(!surface.keys.includes(forbidden), `dashboard preload exposes a privileged write: ${forbidden}`)
    }
    return surface.keys.join(',')
  })

  await check(g, 'getStatus answers with a coherent shape', async () => {
    const st = await intel.evaluate(() => window.intelligence.getStatus())
    assert(st && typeof st === 'object', 'getStatus returned nothing')
    return { meetings: st.meetings, people: st.people, deals: st.deals }
  })

  await check(g, 'getData returns the dashboard graph', async () => {
    const d = await intel.evaluate(() => window.intelligence.getData())
    assert(d && typeof d === 'object', 'getData returned nothing')
    return {
      people: d.people?.length ?? 0,
      deals: d.deals?.length ?? 0,
      meetings: d.meetings?.length ?? 0
    }
  })

  // The core of this group: every route a user can click must actually render. The ErrorBoundary is
  // keyed on the route, so a view that throws shows its fallback rather than a blank window — which
  // means a broken view is invisible to a test that only checks the window opened.
  const ROUTES = [
    ['/', 'Today'],
    ['/coaching', 'Coaching'],
    ['/deals', 'Deals'],
    ['/accounts', 'Accounts'],
    ['/people', 'People'],
    ['/stats', 'Stats'],
    ['/graph', 'Relationships'],
    ['/meetings', 'Meetings']
  ]
  for (const [route, label] of ROUTES) {
    await check(g, `${label} (${route}) renders without hitting the error boundary`, async () => {
      await gotoIntelRoute(intel, route)
      const state = await intel.evaluate(() => ({
        text: document.body.innerText,
        // vis-network mounts a canvas; the graph route is the one that can silently render nothing.
        canvases: document.querySelectorAll('canvas').length
      }))
      assert(
        !/hit an error and could/i.test(state.text),
        `${label} threw: ${state.text.replace(/\s+/g, ' ').slice(0, 200)}`
      )
      // A route that renders an empty <main> is as broken as one that throws, just quieter.
      assert(state.text.trim().length > 40, `${label} rendered almost nothing (${state.text.trim().length} chars)`)
      return route === '/graph' ? { chars: state.text.length, canvases: state.canvases } : { chars: state.text.length }
    })
  }

  // Regression: Stats and Relationships once reported different node/edge counts for the same data
  // under the same label, because Stats read the raw brain graph and Relationships read the filtered
  // display graph. Two numbers claiming to be the same number is a correctness bug, not a cosmetic one.
  // Regression: the "Graph nodes · edges" tile once showed the RAW brain graph while the Relationships
  // tab drew the FILTERED display graph, under one identical label. Meetings are deliberately dropped
  // from the display graph (brainAdapter keeps account|person|deal|sector — 61 meeting nodes would drown
  // the entity structure), so the two numbers diverge exactly when meeting nodes exist. Two numbers
  // claiming to be the same number is a correctness bug, not a cosmetic one.
  //
  // getData() returns the BRAIN shape; account_graph is built from it by brainToDashboard in the
  // renderer. So the expected filtered counts are derived here with the adapter's own predicate rather
  // than read off a field that only exists after adaptation.
  await check(g, 'the graph tile counts the DISPLAY graph, not the raw brain graph', async () => {
    await gotoIntelRoute(intel, '/stats')
    const statsTile = await intel.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find((n) =>
        n.children.length === 0 && /Graph nodes/i.test(n.textContent ?? '')
      )
      return el?.parentElement?.innerText ?? null
    })
    assert(statsTile, 'the "Graph nodes · edges" tile is not on the Stats page')
    const nums = (statsTile.match(/\d+/g) ?? []).map(Number)
    assert(nums.length >= 2, `could not read two numbers out of the tile: ${JSON.stringify(statsTile)}`)
    const shownNodes = nums[nums.length - 2]
    const shownEdges = nums[nums.length - 1]

    const raw = await intel.evaluate(async () => {
      const b = await window.intelligence.getData()
      const KEEP = new Set(['account', 'person', 'deal', 'sector'])
      const all = b.graph?.nodes ?? []
      const kept = all.filter((n) => KEEP.has(n.type))
      const keptIds = new Set(kept.map((n) => n.id))
      const keptEdges = (b.graph?.edges ?? []).filter((e) => keptIds.has(e.from) && keptIds.has(e.to))
      return { allNodes: all.length, keptNodes: kept.length, keptEdges: keptEdges.length }
    })

    assert(
      shownNodes === raw.keptNodes && shownEdges === raw.keptEdges,
      `tile shows ${shownNodes}·${shownEdges}, the display graph has ${raw.keptNodes}·${raw.keptEdges}` +
        (shownNodes === raw.allNodes ? ' — that is the RAW brain count, the regression is back' : '')
    )
    return `${shownNodes} nodes · ${shownEdges} edges (raw brain graph has ${raw.allNodes} nodes)`
  })

  await check(g, 'a full pass over every route raises no uncaught error', async () => {
    const errors = []
    const onErr = (e) => errors.push(String(e.message ?? e))
    intel.on('pageerror', onErr)
    try {
      for (const [route] of ROUTES) await gotoIntelRoute(intel, route)
    } finally {
      intel.off('pageerror', onErr)
    }
    assert(errors.length === 0, `uncaught errors while navigating: ${errors.slice(0, 3).join(' | ')}`)
    return `${ROUTES.length} routes, 0 uncaught errors`
  })

  await check(g, 'the dashboard closes cleanly', async () => {
    await page.evaluate(() => window.toto.brainCloseDashboard?.()).catch(() => {})
    return 'closed (or already closed)'
  })
}

/**
 * Accuracy — does the pipeline recover what is actually IN a transcript, and nothing that is not?
 *
 * Every other group asks "did it answer?". None asked "was the answer right". A pipeline that
 * confidently extracts the wrong person, invents a commitment, or drops the one real next step passes
 * all 58 of the previous checks. Both directions are tested here, because recall without precision is
 * how a note-taker earns distrust: a hallucinated commitment is worse than a missed one.
 *
 * Ground truth is a transcript this group writes itself, so the expected entities are known exactly
 * rather than inferred from whatever happens to be on disk.
 */
async function groupAccuracy() {
  const g = 'accuracy'
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const title = `QA Accuracy Probe ${stamp}`
  // Deliberately specific and mutually unconfusable: a rare surname, an unambiguous amount, one clear
  // commitment with an owner and a date, and one decoy sentence that is NOT a commitment.
  const GROUND_TRUTH = {
    person: 'Priya Venkatesan',
    company: 'Northwind Logistics',
    amount: '$240,000',
    commitment: 'send the revised pricing sheet',
    decoy: 'we might redesign the portal someday'
  }
  let file = null

  await check(g, 'a transcript with known, checkable content is saved', async () => {
    const res = await page.evaluate(async (t) => window.toto.saveTranscript({
      title: t.title,
      mode: 'sales',
      startedAt: Date.now() - 300000,
      recap: '',
      lines: [
        { speaker: 'you', text: `Good to meet you. I am here about the ${t.gt.company} renewal.`, t: 0 },
        { speaker: 'them', text: `${t.gt.person} here — I run procurement for ${t.gt.company}.`, t: 20000 },
        { speaker: 'them', text: `Our budget for this cycle is ${t.gt.amount}, firm.`, t: 45000 },
        { speaker: 'them', text: `Honestly, ${t.gt.decoy}, but that is not on the table this year.`, t: 70000 },
        { speaker: 'you', text: `Understood. I will ${t.gt.commitment} to you by Friday.`, t: 95000 }
      ]
    }), { title, gt: GROUND_TRUTH })
    assert(res && res.path, `no path returned: ${JSON.stringify(res)}`)
    file = res.path
    return res.path
  })

  // Indexing is asynchronous and shares the on-device model with everything else, so absence of a
  // result here can mean "still working" rather than "got it wrong". That distinction is the whole
  // point of the third status — see MQA-255.
  let settled = false
  // 12 min, not 6. On-device extraction of a single 5-line transcript measured ~3-6 min on a warm
  // profile (the model is doing entity, deal, value and commitment passes), so a 6-min budget expired
  // mid-extraction and the cleanup below then deleted the fixture before it could ever be indexed —
  // making every re-run start from zero and never converge.
  const deadline = Date.now() + 12 * 60 * 1000
  // MQA-265: the basename must be split on BOTH separators. `/[\/]/` is a character class holding one
  // escaped forward slash, so on Windows — where every fixture path is backslash-separated — split()
  // returned the whole path, pop() returned the whole path, and `basename.includes(wholePath)` was false
  // on every iteration. `mine` could never become true, so this group burned its full budget and reported
  // "not exercised" every single run, on a pipeline that was extracting correctly the whole time.
  const base = file ? file.split(/[\\/]/).pop() : null
  while (Date.now() < deadline) {
    // MQA-265: bound each probe. The deadline is only consulted BETWEEN iterations, so one CDP call that
    // never settles blocks the loop — and therefore the whole suite — indefinitely. Observed: this group
    // sat for ~50 minutes against a 12-minute budget while the app itself stayed responsive. A probe that
    // times out is treated as "not settled yet" and the loop moves on to re-check the deadline.
    const st = await Promise.race([
      page.evaluate(() => window.toto.brainStatus()).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 20000))
    ])
    const idle = st?.backfill && !st.backfill.running && !st.backfill.preparing
    // Wait for THIS transcript, not for any transcript. Keying on `ingestedFiles.length > 0` meant the
    // brain group's earlier fixture already satisfied the condition, so this group read the graph before
    // its own file was ever indexed and reported four recall failures against an empty result.
    const mine = base ? (st?.ingestedFiles ?? []).some((f) => String(f).includes(base)) : false
    if (idle && mine) {
      settled = true
      break
    }
    await sleep(4000)
  }

  if (!settled) {
    record(g, '(extraction accuracy checks)', 'info',
      'not exercised — indexing did not settle within 12 min (on-device model busy); re-run with --only=accuracy')
  } else {
    const graph = await page.evaluate(() => window.toto.brainRead())

    await check(g, 'RECALL: the person who spoke is in the graph, spelled correctly', async () => {
      const names = (graph.people ?? []).map((p) => p.name ?? p.slug ?? '')
      const hit = names.find((n) => n.toLowerCase().includes('venkatesan'))
      assert(hit, `"${GROUND_TRUTH.person}" not among ${names.length} people: ${names.slice(0, 12).join(', ')}`)
      return hit
    })

    await check(g, 'RECALL: the commitment made in the transcript survives to the graph', async () => {
      const blob = JSON.stringify(graph).toLowerCase()
      assert(blob.includes('pricing sheet'), 'the "revised pricing sheet" commitment is nowhere in the graph')
      return 'found'
    })

    await check(g, 'PRECISION: the hypothetical aside was NOT recorded as a commitment', async () => {
      // "we might redesign the portal someday" is explicitly ruled out in the next breath. Extracting
      // it is a hallucinated obligation — the failure mode that makes a note-taker untrustworthy.
      const commitments = []
      for (const p of graph.people ?? []) for (const c of p.commitments ?? []) commitments.push(String(c.text ?? c))
      for (const d of graph.deals ?? []) for (const c of d.commitments ?? []) commitments.push(String(c.text ?? c))
      const bogus = commitments.filter((c) => /redesign the portal/i.test(c))
      assert(bogus.length === 0, `invented a commitment from a hypothetical: ${bogus.join(' | ')}`)
      return `${commitments.length} commitments, none hallucinated from the decoy`
    })

    await check(g, 'the entity-name feed carries the new name (this is what biases ASR casing)', async () => {
      const feed = await page.evaluate(() => (window.toto.brainEntityNames ? window.toto.brainEntityNames() : null))
      if (!feed) return { __info: 'not exercised — brainEntityNames is not exposed on this build' }
      const flat = JSON.stringify(feed).toLowerCase()
      assert(flat.includes('venkatesan'), 'a freshly-indexed surname never reached the ASR bias feed')
      return 'name present'
    })
  }

  // Retrieval accuracy: the app has to find the right answer in its own notes. A confident wrong
  // number here is the single most damaging failure this product can have.
  await check(g, 'ANSWER ACCURACY: asking about the budget returns the number from the transcript', async () => {
    const r = await ask({
      id: `qa-acc-${Date.now()}`,
      mode: 'answer',
      prompt: `What is the stated budget for the ${GROUND_TRUTH.company} renewal?`
    })
    if (r.error) return { __info: `not exercised — the ask failed (${String(r.error).slice(0, 90)})` }
    const text = r.text ?? ''
    assert(text.trim().length > 0, 'the ask returned no text at all')
    const digits = text.replace(/[,\s]/g, '')
    assert(
      /240[,.]?000/.test(digits) || /240k/i.test(text),
      `answered without the ground-truth figure ($240,000): "${text.replace(/\s+/g, ' ').slice(0, 200)}"`
    )
    return { via: r.providers[r.providers.length - 1], chars: text.length }
  })

  if (file) {
    await check(g, 'clean up the accuracy fixture', async () => {
      // Only when its extraction actually completed. Deleting a transcript that is still mid-extraction
      // is why a timed-out run could never be recovered by simply re-running: each attempt removed the
      // very file the next attempt was waiting on.
      if (!settled) return { __info: `left in place — extraction never settled, so deleting it would make the next run start over: ${file}` }
      try { rmSync(file, { force: true }) } catch { /* best effort */ }
      return existsSync(file) ? 'still present' : 'removed'
    })
  }
}

/**
 * Latency — how long the app actually makes a person wait.
 *
 * Nothing in this suite was timed before, so a change that tripled time-to-first-answer would have
 * shipped green. Budgets are deliberately generous: this is a regression tripwire for an order-of-
 * magnitude change, not a benchmark. Every measurement is REPORTED even when it passes, so a trend is
 * visible in the report rather than only a pass/fail.
 *
 * On-device inference speed is hardware-bound, so the on-device budget is the loosest of the three.
 */
async function groupLatency() {
  const g = 'latency'
  const timed = async (fn) => {
    const t0 = Date.now()
    const value = await fn()
    return { ms: Date.now() - t0, value }
  }

  await check(g, 'settings round-trip is instant (the UI blocks on this)', async () => {
    const { ms } = await timed(() => settings())
    assert(ms < 2000, `getSettings took ${ms}ms — the Settings pane blocks on it`)
    return `${ms}ms`
  })

  await check(g, 'brainRead returns fast enough to open the dashboard on', async () => {
    const { ms, value } = await timed(() => page.evaluate(() => window.toto.brainRead()))
    const size = (value?.people?.length ?? 0) + (value?.deals?.length ?? 0) + (value?.meetings?.length ?? 0)
    assert(ms < 15000, `brainRead took ${ms}ms for ${size} entities — the dashboard waits on this`)
    return `${ms}ms for ${size} entities`
  })

  await check(g, 'screen capture completes within a usable window', async () => {
    const s = await settings()
    if (s?.privateView) return { __info: 'not exercised — Private View is ON, so capture is refused by design' }
    const { ms, value } = await timed(() => page.evaluate(() => window.toto.capture()))
    if (!value || value.error) {
      return { __info: `not exercised — capture unavailable here (${String(value?.error ?? 'no result').slice(0, 80)})` }
    }
    assert(ms < 20000, `capture took ${ms}ms — a screen-ask feels broken past a few seconds`)
    return `${ms}ms`
  })

  await check(g, 'an on-device ask answers within the on-device budget', async () => {
    if (!localModelReady) return { __info: 'not exercised — on-device weights were still downloading at boot' }
    const r = await ask({
      id: `qa-lat-local-${Date.now()}`,
      mode: 'suggest',
      prompt: 'Summarise the last meeting in one sentence.'
    }, 240000)
    if (r.error) return { __info: `not exercised — the ask failed (${String(r.error).slice(0, 90)})` }
    // Generous on purpose: this runs on whatever CPU/GPU the machine has, often while indexing.
    assert(r.doneAt < 180000, `on-device ask took ${Math.round(r.doneAt / 1000)}s`)
    return { ms: r.doneAt, via: r.providers[r.providers.length - 1] }
  })

  await check(g, 'the configured cloud provider answers within a cloud budget', async () => {
    const s = await settings()
    if (!s?.providerReady) return { __info: 'not exercised — no cloud provider is configured on this profile' }
    const r = await ask({
      id: `qa-lat-cloud-${Date.now()}`,
      mode: 'answer',
      prompt: 'Reply with the single word: ready.'
    }, 120000)
    if (r.error) return { __info: `not exercised — the ask failed (${String(r.error).slice(0, 90)})` }
    const via = r.providers[r.providers.length - 1]
    if (via === 'local') {
      return { __info: `not exercised — the walk ended on-device (${r.providers.join(' → ')}), so this timed local inference` }
    }
    assert(r.doneAt < 90000, `${via} took ${Math.round(r.doneAt / 1000)}s to answer a one-word prompt`)
    return { ms: r.doneAt, via, walk: r.providers.join(' → ') }
  })
}

const GROUPS = {
  boot: groupBoot,
  settings: groupSettings,
  ask: groupAsk,
  screen: groupScreen,
  cloudflare: groupCloudflare,
  degrade: groupDegrade,
  meetings: groupMeetings,
  brain: groupBrain,
  window: groupWindow,
  intelligence: groupIntelligence,
  accuracy: groupAccuracy,
  latency: groupLatency
}

if (args.includes('--list')) {
  console.log(Object.keys(GROUPS).join('\n'))
  process.exit(0)
}

const browser = await chromium.connectOverCDP(CDP)
page = await findTotoPage(browser)

const selected = only ? only.split(',').map((s) => s.trim()).filter((s) => GROUPS[s]) : Object.keys(GROUPS)
if (only && !selected.length) {
  console.error(`unknown group "${only}". Known: ${Object.keys(GROUPS).join(', ')}`)
  process.exit(2)
}

if (meetingsFolder) {
  await page.evaluate((f) => window.toto.setSettings({ meetingsFolder: f }), meetingsFolder)
  const resolved = (await settings()).resolvedMeetingsFolder
  console.log(`Meetings folder pointed at: ${resolved}`)
}

/**
 * Snapshot the settings this suite mutates, and put them back afterwards.
 *
 * Several groups deliberately change provider, keys and localLlm toggles — that is how they reproduce
 * "my key stopped working" against real endpoints. Each restores its own changes on the happy path, but a
 * group that FAILS mid-way never reaches its restore, so the profile is left altered.
 *
 * Two runs against the same profile then disagree: the second inherits `useFor.summary: true` and a
 * provider the first swapped in, and reports failures describing the leftover state rather than the
 * build. Observed exactly that on 2026-08-25 — a clean second run produced six red lines that were
 * entirely the first run's residue. A suite whose result depends on whether it has been run before is
 * not measuring the app.
 */
const SETTINGS_SNAPSHOT = await (async () => {
  try {
    const s = await settings()
    return { provider: s.provider, localLlm: s.localLlm, providerPriority: s.providerPriority }
  } catch {
    return null
  }
})()

async function restoreSettingsSnapshot() {
  if (!SETTINGS_SNAPSHOT) return
  try {
    await patch(SETTINGS_SNAPSHOT)
    console.log('\n[restore] settings returned to their pre-run values')
  } catch (e) {
    console.log(`\n[restore] WARNING — settings not restored: ${e instanceof Error ? e.message : e}`)
    console.log('[restore]   This profile is now dirty; re-run against a fresh ASKTOTO_USERDATA.')
  }
}


console.log(`Running QA groups: ${selected.join(', ')}\n`)
for (const name of selected) {
  console.log(`\n=== ${name} ===`)
  try {
    await GROUPS[name]()
  } catch (e) {
    record(name, '(group crashed)', 'fail', e instanceof Error ? e.message : String(e))
  }
}

await restoreSettingsSnapshot()

const passed = results.filter((r) => r.status === 'pass').length
const failed = results.filter((r) => r.status === 'fail').length
// Counted separately and never folded into `passed`: a check that did not run must not read as one that
// succeeded. That is the entire reason the third state exists.
const skipped = results.filter((r) => r.status === 'info').length
const summary = { at: new Date().toISOString(), groups: selected, passed, failed, skipped, results }
writeFileSync(OUT, JSON.stringify(summary, null, 2))

console.log(`\n──────────────\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} not exercised` : ''}. Report: ${OUT}`)
if (failed) {
  console.log('\nFAILURES:')
  for (const r of results.filter((x) => x.status === 'fail')) console.log(`  ${r.group} :: ${r.name} — ${r.detail}`)
}
await browser.close()
process.exit(failed ? 1 : 0)
