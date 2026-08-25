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
  await check(g, 'Local AI ships enabled, non-preempting, with fallback armed', async () => {
    const s = await settings()
    assert(s.localLlm.enabled === true, 'localLlm.enabled is not true by default')
    assert(s.localLlm.fallback === true, 'localLlm.fallback is not true by default')
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

  await check(g, 'everything needed to run is bundled — no post-install download required', async () => {
    const out = await page.evaluate(async () => ({
      models: await window.toto.localModelsList(),
      asr: await window.toto.asrBundled?.().catch?.(() => null) ?? null,
      settings: await window.toto.getSettings()
    }))
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so this request can only be served by a cloud provider; re-run once first-run setup finishes' }
    assert(out.models.some((m) => m.ready), 'bundled local LLM not ready')
    assert(out.settings.localReady === true, 'localReady false — on-device path unavailable out of the box')
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
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so this request can only be served by a cloud provider; re-run once first-run setup finishes' }
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
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so this request can only be served by a cloud provider; re-run once first-run setup finishes' }
    assert((await settings()).localFallbackReady === true, 'localFallbackReady did not come back')
    return 'tracks fallback'
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
    assert(!r.error, `errored: ${r.error}`)
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so this request can only be served by a cloud provider; re-run once first-run setup finishes' }
    // "Zero API keys" cannot be arranged on a machine that exports provider keys in its ENVIRONMENT:
    // store.ts's getApiKey reads process.env[ENV_VAR[provider]] BEFORE the profile store, so the app
    // inherits a real, working key no isolated profile can remove. A cloud provider answering here is
    // then the DESIGNED behaviour, and calling it red would be wrong about the product rather than
    // informative about it.
    const envKeys = Object.keys(process.env).filter((k) => /^[A-Z0-9]+_API_KEY$/.test(k))
    if (envKeys.length) {
      return { __info: `not exercised — this shell exports ${envKeys.join(', ')}, which the app reads ahead of the profile store; run with those unset to cover the zero-key path` }
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
    assert(!r.error, `answer mode dead-ended instead of falling to local: "${r.error}"`)
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so this request can only be served by a cloud provider; re-run once first-run setup finishes' }
    // "Zero API keys" cannot be arranged on a machine that exports provider keys in its ENVIRONMENT:
    // store.ts's getApiKey reads process.env[ENV_VAR[provider]] BEFORE the profile store, so the app
    // inherits a real, working key no isolated profile can remove. A cloud provider answering here is
    // then the DESIGNED behaviour, and calling it red would be wrong about the product rather than
    // informative about it.
    const envKeys = Object.keys(process.env).filter((k) => /^[A-Z0-9]+_API_KEY$/.test(k))
    if (envKeys.length) {
      return { __info: `not exercised — this shell exports ${envKeys.join(', ')}, which the app reads ahead of the profile store; run with those unset to cover the zero-key path` }
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
    assert(!r.error, `errored: ${r.error}`)
    assert(r.providers.at(-1) === 'local', `served by ${r.providers.at(-1)}`)
    return { walk: r.providers }
  })

  await check(g, 'DEAD PRIMARY KEY (DeepSeek 401) → walks off it and still answers', async () => {
    await page.evaluate((k) => window.toto.setApiKey('deepseek', k), DEAD_DEEPSEEK)
    await patch({ provider: 'deepseek' })
    const r = await ask({ id: uid('dead1'), mode: 'suggest', prompt: '', transcript: 'THEM: what is the renewal price?', history: [] })
    assert(!r.error, `dead key killed the ask outright: ${r.error}`)
    assert(r.providers[0] === 'deepseek', `did not try the configured primary first (walk: ${r.providers})`)
    assert(r.providers.at(-1) !== 'deepseek', 'never left the dead provider')
    assert(r.text.trim().length > 0, 'no answer text after failover')
    return { walk: r.providers, servedBy: r.providers.at(-1), ms: r.doneAt }
  })

  await check(g, 'DEAD PRIMARY + DEAD NIM → walks both, still answers on-device', async () => {
    await page.evaluate((k) => window.toto.setApiKey('nvidia', k), DEAD_NVIDIA)
    const r = await ask({ id: uid('dead2'), mode: 'suggest', prompt: '', transcript: 'THEM: send me the quote please', history: [] })
    assert(!r.error, `errored with two dead keys: ${r.error}`)
    if (!localModelReady) return { __info: 'not exercised — the on-device weights are still downloading, so this request can only be served by a cloud provider; re-run once first-run setup finishes' }
    // "Zero API keys" cannot be arranged on a machine that exports provider keys in its ENVIRONMENT:
    // store.ts's getApiKey reads process.env[ENV_VAR[provider]] BEFORE the profile store, so the app
    // inherits a real, working key no isolated profile can remove. A cloud provider answering here is
    // then the DESIGNED behaviour, and calling it red would be wrong about the product rather than
    // informative about it.
    const envKeys = Object.keys(process.env).filter((k) => /^[A-Z0-9]+_API_KEY$/.test(k))
    if (envKeys.length) {
      return { __info: `not exercised — this shell exports ${envKeys.join(', ')}, which the app reads ahead of the profile store; run with those unset to cover the zero-key path` }
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
    const st = await page.evaluate(() => window.toto.brainStatus())
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
    record(g, 'mock gateway reachable', 'info', `not exercised — no mock at ${MOCK}; start scripts/qa/mock-llm-server.mjs to cover this group`)
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

    await check(g, 'a SCREEN ask goes on-device, never to a gateway that cannot carry an image', async () => {
      // MQA-227 (supersedes MQA-212). Cloudflare's OpenAI-compatible endpoint rejects every image_url
      // shape with code 6004 — a transport limit, not a model one — so PROVIDERS.cloudflare.vision is
      // false and a screen-ask must route to the on-device model. Asserting the WALK, because the old
      // check read `visionReady`, which localFallbackReady satisfies on its own: it could not fail.
      const r = await ask({ id: uid('cf-vision'), mode: 'vision', prompt: 'What is on screen?', image: TINY_JPEG_B64 })
      assert(
        !r.providers.includes('cloudflare'),
        `a screen-ask reached cloudflare, which cannot accept an image: ${JSON.stringify(r.providers)}`
      )
      // Under an org allowlist that excludes 'local' (e.g. exactly ["cloudflare"]), NO provider may carry
      // an image, so the honest outcome is a dead-end with advice that does not name a policy-blocked
      // provider (MQA-228) — not a walk onto the on-device model the policy forbids.
      const policyBlocksLocal = (await settings()).allowedProviders?.includes('local') === false
      if (policyBlocksLocal) {
        assert(r.providers.length === 0, `policy excludes every vision route, yet the walk was ${JSON.stringify(r.providers)}`)
        assert(Boolean(r.error), 'no error surfaced for a screen-ask no approved provider can serve')
        assert(
          !/Claude or GPT/.test(String(r.error)),
          `advice names policy-blocked providers: ${r.error}`
        )
        return { walk: r.providers, error: r.error }
      }
      assert(
        r.providers.includes('local'),
        `screen-ask did not reach the on-device model, walk was ${JSON.stringify(r.providers)}`
      )
      assert(r.text.trim().length > 0, 'no text streamed back for the screen-ask')
      return { walk: r.providers }
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

const GROUPS = {
  boot: groupBoot,
  settings: groupSettings,
  ask: groupAsk,
  screen: groupScreen,
  cloudflare: groupCloudflare,
  degrade: groupDegrade,
  meetings: groupMeetings,
  brain: groupBrain,
  window: groupWindow
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
