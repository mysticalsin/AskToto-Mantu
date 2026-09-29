/**
 * Provider-facing QA groups of the physical suite (M2-0410): `cloudflare`, `degrade`, `latency`.
 * Moved out of e2e-workflows.mjs verbatim; the harness helpers arrive through `ctx`.
 */
// Used only by the `cloudflare` group, to probe the mock gateway from THIS process rather than from the
// CSP-restricted renderer. `rejectUnauthorized: false` is safe and necessary here: the mock serves a
// throwaway self-signed cert on 127.0.0.1, and this is test tooling, never shipped code.
import { request as httpsRequest } from 'node:https'
import { sleep } from '../lib/app-driver.mjs'

export function createProviderGroups(ctx) {
const { page, check, record, assert, ask, settings, patch, clearAllKeys, uid, armLocalFloor, stubbornKeys, FLOOR_UNAVAILABLE } = ctx

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
    // With zero keys, ONLY the armed on-device floor can serve this — arm it, or report the build can't.
    const floor = await armLocalFloor()
    try {
      if (!floor.ready) return { __info: FLOOR_UNAVAILABLE }
      const r = await ask({ id: uid('base'), mode: 'suggest', prompt: '', transcript: 'THEM: can you send pricing?', history: [] })
      assert(!r.error, `errored: ${r.error}`)
      assert(r.providers.at(-1) === 'local', `served by ${r.providers.at(-1)}`)
      return { walk: r.providers }
    } finally {
      await floor.restore()
    }
  })

  await check(g, 'DEAD PRIMARY KEY (DeepSeek 401) → walks off it and still answers', async () => {
    await page.evaluate((k) => window.toto.setApiKey('deepseek', k), DEAD_DEEPSEEK)
    await patch({ provider: 'deepseek' })
    // The walk can only "still answer" if there is a live route to land on. With only a dead cloud key,
    // that route is the armed on-device floor — arm it, or report the build has no floor to walk to.
    const floor = await armLocalFloor()
    try {
      if (!floor.ready) return { __info: FLOOR_UNAVAILABLE }
      const r = await ask({ id: uid('dead1'), mode: 'suggest', prompt: '', transcript: 'THEM: what is the renewal price?', history: [] })
      assert(!r.error, `dead key killed the ask outright: ${r.error}`)
      assert(r.providers[0] === 'deepseek', `did not try the configured primary first (walk: ${r.providers})`)
      assert(r.providers.at(-1) !== 'deepseek', 'never left the dead provider')
      assert(r.text.trim().length > 0, 'no answer text after failover')
      return { walk: r.providers, servedBy: r.providers.at(-1), ms: r.doneAt }
    } finally {
      await floor.restore()
    }
  })

  await check(g, 'DEAD PRIMARY + DEAD NIM → walks both, still answers on-device', async () => {
    await page.evaluate((k) => window.toto.setApiKey('nvidia', k), DEAD_NVIDIA)
    const floor = await armLocalFloor()
    try {
      if (!floor.ready) return { __info: FLOOR_UNAVAILABLE }
      const r = await ask({ id: uid('dead2'), mode: 'suggest', prompt: '', transcript: 'THEM: send me the quote please', history: [] })
      // "Zero API keys" cannot be arranged on a machine that exports provider keys in its ENVIRONMENT:
      // store.ts's getApiKey reads process.env[ENV_VAR[provider]] BEFORE the profile store, so the app
      // inherits a real, working key no isolated profile can remove. A cloud provider answering here is
      // then the DESIGNED behaviour, and calling it red would be wrong about the product rather than
      // informative about it.
      // Ask the APP which keys it still has, not this shell which keys IT exports. The two are different
      // processes: the app is frequently launched with provider vars unset even when the suite inherits
      // them, and reading process.env here downgraded three checks that were genuinely exercising the
      // zero-key path. Same defect class as MQA-255 — measuring the harness instead of the build.
      const stuck = (await stubbornKeys()).filter((p) => p !== 'deepseek' && p !== 'nvidia')
      if (stuck.length) {
        return { __info: `not exercised — the app still reports keys for ${stuck.join(', ')} after clearAllKeys(); they come from its ENVIRONMENT (getApiKey reads process.env before the profile store), so no isolated profile can remove them — relaunch the app with those vars unset to cover the zero-key path` }
      }
      assert(!r.error, `errored with two dead keys: ${r.error}`)
      assert(r.providers.at(-1) === 'local', `final provider ${r.providers.at(-1)}, expected local`)
      assert(r.providers.includes('deepseek'), 'primary was skipped entirely')
      return { walk: r.providers, servedBy: r.providers.at(-1), ms: r.doneAt }
    } finally {
      await floor.restore()
    }
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
    // Cleared every key, so again only the armed on-device floor can answer — arm it, or report no floor.
    const floor = await armLocalFloor()
    try {
      if (!floor.ready) return { __info: FLOOR_UNAVAILABLE }
      const r = await ask({ id: uid('recover'), mode: 'suggest', prompt: '', transcript: 'THEM: ok, next steps?', history: [] })
      assert(!r.error, `errored after cleanup: ${r.error}`)
      assert(!r.providers.includes('deepseek'), 'still trying the removed provider')
      return { walk: r.providers }
    } finally {
      await floor.restore()
    }
  })
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
      const { localModelReady } = ctx
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
    // Arm the floor so this actually times on-device inference rather than an unarmed no-provider error.
    const floor = await armLocalFloor()
    try {
      if (!floor.ready) return { __info: FLOOR_UNAVAILABLE }
      const r = await ask({
        id: `qa-lat-local-${Date.now()}`,
        mode: 'suggest',
        prompt: 'Summarise the last meeting in one sentence.'
      }, 240000)
      if (r.error) return { __info: `not exercised — the ask failed (${String(r.error).slice(0, 90)})` }
      // Generous on purpose: this runs on whatever CPU/GPU the machine has, often while indexing.
      assert(r.doneAt < 180000, `on-device ask took ${Math.round(r.doneAt / 1000)}s`)
      return { ms: r.doneAt, via: r.providers[r.providers.length - 1] }
    } finally {
      await floor.restore()
    }
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

return { cloudflare: groupCloudflare, degrade: groupDegrade, latency: groupLatency }
}
