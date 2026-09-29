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
 *   ASKTOTO_USERDATA=<dir under the OS temp dir> ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9334
 * Note: --user-data-dir does NOT move app.getPath('userData') — the app appends "-dev" when unpackaged,
 * so ASKTOTO_USERDATA (honored in main/index.ts) is the only reliable isolation switch, and only a
 * directory under the OS temp dir passes assertAttachedAppIsSandboxed's check below.
 *
 * Usage:
 *   node scripts/qa/e2e-workflows.mjs                        # everything
 *   node scripts/qa/e2e-workflows.mjs --only=degrade         # one group
 *   node scripts/qa/e2e-workflows.mjs --meetings=D:\fixtures # point at a fixture meetings folder first
 *   node scripts/qa/e2e-workflows.mjs --list                 # group names
 *
 * The degradation group sets deliberately INVALID API keys and issues one request each, so real
 * endpoints return 401. That is the point: it physically reproduces "my API key stopped working".
 *
 * The provider, brain and intelligence groups live in scripts/qa/golden-flows/ (M2-0410) and receive the
 * helpers below through a shared context; the driver primitives come from scripts/qa/lib/app-driver.mjs.
 */
import { writeFileSync } from 'node:fs'
import { attach, findPage, sleep } from './lib/app-driver.mjs'
import { createBrainGroups } from './golden-flows/brain-groups.mjs'
import { createIntelligenceGroup } from './golden-flows/intelligence-group.mjs'
import { createProviderGroups } from './golden-flows/provider-groups.mjs'
// W0-HERMETIC (M2-0190) — see this file's own header: ASKTOTO_USERDATA is "the only reliable isolation
// switch" for the real app this harness drives. This asks the ATTACHED APP whether it took effect —
// checking this harness's own process.env only proves the operator's shell saw the variable, never that
// the app it launched did, since the documented launch sets it only on the spawned app process.
import { assertAttachedAppIsSandboxed } from './lib/sandbox-guard.mjs'

const CDP = process.env.METIS_CDP ?? 'http://127.0.0.1:9334'
const OUT = process.env.METIS_QA_OUT ?? 'D:\\tmp-metis-e2e\\qa-report.json'
const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').replace('--only=', '')
const meetingsFolder = (args.find((a) => a.startsWith('--meetings=')) ?? '').replace('--meetings=', '')

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

/**
 * Arm the on-device answer floor the way a user would (Settings → Local AI: enable + turn on fallback),
 * and report whether it can ACTUALLY serve on this profile. The floor gates in llm/local-routing.ts
 * (localFallbackEligibleFor / localAnswerFloorEligibleFor) require BOTH the user toggle
 * (localLlm.enabled + localLlm.fallback) AND localBaseReady(): the llama-server sidecar binary, the
 * downloaded weights, and enough RAM. Weights-on-disk is NOT enough — a dev/unpackaged build ships no
 * sidecar (resources/llama is absent), so localReady stays false even with the toggle on and the floor
 * genuinely cannot answer. The old `localModelReady` guard only tracked the weights DOWNLOAD, so it let
 * every "answered on-device" check assert against a build where the floor could never run: the harness
 * measuring the wrong thing (same defect class as MQA-255). Two additional facts these checks depend on:
 *  1. Nothing routes to local on a fully-default profile — useFor and fallback both ship OFF — so a
 *     zero-key ask correctly ERRORS ("add an API key") unless the floor is armed first. Asserting an
 *     on-device answer without arming the floor could only ever pass by accident.
 *  2. Arming is a live settings patch; callers MUST `await restore()` in a finally so a later check in
 *     the same run does not inherit an armed floor.
 * Returns { ready, restore }: gate the on-device assertions on `ready`, downgrade to { __info } when it
 * is false, and always restore.
 */
async function armLocalFloor() {
  const prev = (await settings()).localLlm
  await patch({ localLlm: { ...prev, enabled: true, fallback: true } })
  const ready = (await settings()).localReady === true
  return { ready, restore: () => patch({ localLlm: prev }) }
}

const FLOOR_UNAVAILABLE =
  'not exercised — the on-device answer floor cannot serve on this profile: even with Local AI armed (enabled + fallback), localReady is false because this build ships no llama-server sidecar (resources/llama is absent) — only the Qwen weights are provisioned. Run against a packaged build to cover the on-device floor.'

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
    if (out.models.length === 0) {
      return { __info: 'not exercised — this build ships no on-device LLM runtime; llama-server + the Qwen weights are provisioned only by predist/dist, so a dev/unpackaged build has neither to report on. Run against a packaged build.' }
    }
    // The IPC field is `downloadProgress` + `unavailableReason` (shared/ipc.ts LocalModelSummarySchema).
    // The old `m.progress` read was always undefined, so a first-run profile whose weights were still
    // `not-downloaded` (or downloading at 0%) was reported as a defect — the exact false-red the
    // paragraph above exists to prevent.
    const ready = out.models.some((m) => m.ready)
    const arriving = out.models.some(
      (m) =>
        !m.ready &&
        (m.unavailableReason === 'downloading' || m.unavailableReason === 'not-downloaded')
    )
    const ramLocked = out.models.every((m) => m.unavailableReason === 'insufficient-ram')
    if (!ready) {
      assert(
        arriving || ramLocked,
        `the on-device model is neither ready nor arriving: ${JSON.stringify(out.models.map((m) => ({ id: m.id, ready: m.ready, reason: m.unavailableReason, downloadProgress: m.downloadProgress })))}`
      )
      return {
        __info: `not exercised — first run, weights not ready yet (${out.models.map((m) => `${m.id}:${m.unavailableReason ?? 'ready'} ${Math.round((m.downloadProgress ?? 0) * 100)}%`).join(', ')}); the app is served by the configured cloud provider meanwhile`
      }
    }
    // Weights on disk ≠ Local AI enabled. localReady also requires localLlm.enabled (off by default)
    // and the llama-server sidecar, so asserting localReady here would red-line every fresh profile
    // that has finished the first-run fetch but has not flipped the Settings toggle.
    return {
      localModel: out.models.map((m) => `${m.id}:${m.ready ? 'ready' : m.unavailableReason}`),
      asrBundled: out.asr,
      localEnabled: out.settings.localLlm.enabled,
      localReady: out.settings.localReady
    }
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
    assert(on.localLlm.useFor.summary === true, 'useFor.summary did not persist')
    // localSummaryReady = localReady && useFor.summary. localReady also needs the toggle ON, the
    // sidecar binary, and the weights — a default profile has enabled:false, so the derived flag
    // staying false is the contract, not a defect.
    if (!on.localReady) {
      assert(on.localSummaryReady === false, 'localSummaryReady came on without localReady — the derived flag lied')
      await patch({ localLlm: before })
      return { __info: 'not exercised — local is not ready on this profile (Local AI off, or llama-server/weights missing), so localSummaryReady correctly stayed false; the toggle itself persisted' }
    }
    assert(on.localSummaryReady === true, 'localSummaryReady did not follow useFor.summary')
    await patch({ localLlm: before })
    const off = await settings()
    assert(off.localSummaryReady === false || before.useFor.summary, 'localSummaryReady did not reset')
    return 'derived flags track the toggle'
  })
  await check(g, 'fallback toggle drives localFallbackReady', async () => {
    const before = (await settings()).localLlm
    // Drive the toggle ON, then OFF. The shipped default is fallback:false, so the old form
    // (set false → restore `before` → assert ready===true) could never pass on a fresh profile.
    await patch({ localLlm: { ...before, fallback: true } })
    const on = await settings()
    assert(on.localLlm.fallback === true, 'fallback toggle did not persist')
    if (!on.localReady) {
      assert(on.localFallbackReady === false, 'localFallbackReady came on without localReady — the derived flag lied')
      await patch({ localLlm: before })
      return { __info: 'not exercised — local is not ready on this profile, so localFallbackReady correctly stayed false; the toggle itself persisted' }
    }
    assert(on.localFallbackReady === true, 'localFallbackReady did not follow fallback=true')
    await patch({ localLlm: { ...before, fallback: false } })
    assert((await settings()).localFallbackReady === false, 'localFallbackReady stayed true with fallback off')
    await patch({ localLlm: before })
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
    // Arm the floor first (a default profile never routes to local — see armLocalFloor). If the build
    // cannot actually run local (no sidecar), say so honestly instead of asserting an answer it can't give.
    const floor = await armLocalFloor()
    try {
      if (!floor.ready) return { __info: FLOOR_UNAVAILABLE }
      const r = await ask({
        id: uid('suggest'), mode: 'suggest', prompt: '',
        transcript: 'THEM: What does your pricing look like for a 500-seat rollout?', history: []
      })
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
      assert(!r.error, `errored: ${r.error}`)
      assert(r.providers.at(-1) === 'local', `answered by ${r.providers.at(-1)}, expected local`)
      assert(r.text.trim().length > 0, 'empty answer')
      return { walk: r.providers, ms: r.doneAt, chars: r.text.length }
    } finally {
      await floor.restore()
    }
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
    // answer is OUT of local's normal v1 scope; only the absolute floor (localAnswerFloorEligibleFor)
    // can serve it, and that too is gated on localLlm.fallback + localBaseReady. Arm it, or say why not.
    const floor = await armLocalFloor()
    try {
      if (!floor.ready) return { __info: FLOOR_UNAVAILABLE }
      const r = await ask({ id: uid('answer'), mode: 'answer', prompt: 'What is our renewal risk?', history: [] }, 180000)
      assert(!r.error || !/TIMEOUT/.test(r.error), 'answer mode HUNG instead of reaching the on-device floor')
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
      assert(!r.error, `answer mode dead-ended instead of falling to local: "${r.error}"`)
      assert(r.providers.at(-1) === 'local', `expected the on-device floor to serve it, got ${r.providers.at(-1)}`)
      assert(r.text.trim().length > 0, 'the on-device floor answered with no text at all')
      return { provider: r.providers.at(-1), chars: r.text.length, ms: r.doneAt }
    } finally {
      await floor.restore()
    }
  })
  await check(g, 'resetAskContext clears conversation state without throwing', async () => {
    await page.evaluate(() => window.toto.resetAskContext())
    return 'ok'
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
      // ASKTOTO_DISABLE_CP=1 (set on the APP for screenshot QA) makes privateViewOn() return false, so
      // capture is NOT refused. The suite process often does not inherit that env — measuring
      // process.env here missed the live app and produced a false red. Ask the app instead.
      await page.evaluate(() => window.toto.setSettings({ privateView: true }))
      await sleep(300)
      const applied = await settings()
      if (!applied.privateView) {
        return { __info: 'not exercised — the app reports Private View still off after the toggle (dev build with ASKTOTO_DISABLE_CP strips enforcement); run a packaged build without that flag to cover the refusal' }
      }
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

const GROUP_ORDER = ['boot', 'settings', 'ask', 'screen', 'cloudflare', 'degrade', 'meetings', 'brain', 'window', 'intelligence', 'accuracy', 'latency']

if (args.includes('--list')) {
  console.log(GROUP_ORDER.join('\n'))
  process.exit(0)
}

const browser = await attach(CDP)
page = await findPage(
  browser,
  (p) => p.evaluate(() => typeof window.toto !== 'undefined'),
  'no renderer page exposing window.toto after 60s — is the app running with CDP?',
  60_000,
  1_000
)

// The extracted group modules take the harness helpers as one context, built after connecting so `page`
// is live. `localModelReady` is written by the boot group, so it is exposed through a getter.
const ctx = {
  page,
  browser,
  check,
  record,
  assert,
  ask,
  settings,
  patch,
  clearAllKeys,
  uid,
  armLocalFloor,
  stubbornKeys,
  FLOOR_UNAVAILABLE,
  get localModelReady() {
    return localModelReady
  }
}

const impl = {
  boot: groupBoot,
  settings: groupSettings,
  ask: groupAsk,
  screen: groupScreen,
  window: groupWindow,
  ...createProviderGroups(ctx),
  ...createBrainGroups(ctx),
  ...createIntelligenceGroup(ctx)
}
const GROUPS = Object.fromEntries(GROUP_ORDER.map((n) => [n, impl[n]]))

// W0-HERMETIC (M2-0190) — before touching the connected app's real settings/brain on disk, ask the
// ATTACHED APP whether it is actually sandboxed (its own resolvedMeetingsFolder), not just whether this
// harness's own shell followed the documented prerequisite. Refuses to run rather than silently mutating
// a real developer profile.
try {
  await assertAttachedAppIsSandboxed(page)
} catch (e) {
  console.error(`[e2e-workflows] ${e.message}`)
  process.exit(2)
}

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
