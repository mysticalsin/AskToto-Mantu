# Métis Bug Ledger

The durable registry of defects found in QA. One row per defect, one id per defect, forever.

**This file is mechanically enforced by `npm run check:bugs` (`scripts/check-bug-ledger.mjs`).** The gate
fails the build if an entry marked `FIXED` does not name a regression test that exists *and* literally
contains its `MQA-###` id. That is the whole point: a fixed bug that regresses must break a test whose
name leads straight back to the row explaining what went wrong the first time. A prose bug list rots;
this one cannot.

## How to use it

1. **Found a defect?** Claim the next id, add a row with status `OPEN`, and write a `### MQA-###` detail
   section below with the concrete repro (inputs/state → wrong result) and both-sides citations
   (intended behavior quoted from a comment/doc/test, actual behavior at `file:line`).
2. **Fixing it?** Write the regression test *first* — it must fail before the fix and pass after — and
   put the bug id in the test's name or a comment beside it. Then flip the row to `FIXED` and name the
   test file in the Regression test column.
3. **Not fixing it?** `WONTFIX` (deliberate) or `ACCEPTED` (known, tracked in
   `docs/asktoto-hardening-backlog.md`) with the reason in the detail section. Never delete a row —
   deleting loses the memory this ledger exists to hold. Reusing an id is likewise forbidden.

Severity: `critical` = data loss / security / crash on a common path · `high` = core workflow broken or
silently wrong · `medium` = degraded or confusing in a real scenario · `low` = edge case.

## Ledger

| ID | Title | Workflow | Severity | Status | Regression test | Notes |
|---|---|---|---|---|---|---|
| MQA-001 | DeepSeek shipped retired model ids (`deepseek-chat`/`deepseek-reasoner`) as its defaults | pick a provider · every ask | high | FIXED | `src/shared/providers.test.ts`, `src/main/store.test.ts` | Registry moved to V4; persisted overrides heal on read |
| MQA-002 | Windows never probed screen capture and never ran the upfront permission pass — setup readiness was macOS-only | first run · setup checklist | high | FIXED | `src/main/platform-perms.test.ts` | Probe-backed status + boot probe on win32 |
| MQA-003 | No circuit breaker: a provider with a dead key is retried first on every single ask | live answers · every ask after a key dies | high | FIXED | `src/main/llm/provider-health.test.ts`, `src/main/provider-health-ux.contract.test.ts` | Session-scoped cooldown; demotes, never blocks |
| MQA-004 | `providerReady` stays true forever after repeated 401s — nothing tells the user their key died | detect a dead API key | high | FIXED | `src/main/llm/provider-health.test.ts`, `src/main/provider-health-ux.contract.test.ts` | New `unhealthyProviders` in the settings snapshot |
| MQA-005 | Raw provider error text shown to the user (`403 status code (no body)`) instead of an actionable message | any ask when failover is exhausted | medium | FIXED | `src/main/provider-health-ux.contract.test.ts` | Names the provider and points at Settings → AI |
| MQA-006 | First on-device answer after launch times out — cold model load exceeds the 15s suggest budget, and prewarm never ran | live answers on a zero-API-key install | high | FIXED | `src/main/llm/local-prewarm.test.ts` | Prewarm when local is the likely server + cold-start idle floor |
| MQA-007 | Test suite is flaky under heavy parallel load — temp-dir rename races in brain tests | CI / developer confidence | low | OPEN | — | Only reproduced with many concurrent vitest processes; single runs are clean |

## Details

### MQA-001 — DeepSeek shipped retired model ids as its defaults

**Intended.** `src/shared/providers.ts` documents `defaultModel`/`fastModel`/`thinkModel` as the ids the
app sends when the user has not overridden them, i.e. ids that must actually resolve at the provider.

**Actual.** The registry pinned `deepseek-chat` (default + fast) and `deepseek-reasoner` (think). DeepSeek
announced both for discontinuation on **2026-07-24** — a date already past — replacing them with the V4
generation (`deepseek-v4-flash`, `deepseek-v4-pro`).

**Repro.** Configure DeepSeek with a valid API key and ask anything. Once the provider completes the
sunset, every request returns a model-not-found error. Worse for anyone who ever *picked* a model in
Settings: `providerModels.deepseek = 'deepseek-chat'` is persisted, and a persisted override beats every
registry default in `resolveModelTier` (`src/shared/providers.ts`), so updating the app alone would not
have healed those profiles. The user experiences this as "my API key stopped working" and re-enters a
perfectly valid key, which changes nothing.

**Fix.** Registry moved to `deepseek-v4-flash` (base) / `deepseek-v4-pro` (think + deep), DeepSeek
promoted to a `featured` tier provider. `migrateRetiredModelId`/`migrateRetiredModelMap` in
`src/shared/providers.ts` map the retired ids to V4 Flash — deliberately Flash, not Pro, since DeepSeek
documents both old ids as aliases for V4 Flash's non-thinking/thinking modes and promoting to Pro would
silently triple a user's token cost. `src/main/store.ts` `getSettings()` applies the migration on **read**,
so existing profiles heal without waiting for a settings save. `reasoningEffortFor()` keeps the base tier
at low effort because V4 defaults to thinking mode, which would otherwise blow the 15s live-suggest idle
budget in `askStart`.

### MQA-002 — Windows setup readiness was macOS-only

**Intended.** `src/main/index.ts` describes the upfront pass as "Front-load the OS permission prompts
during onboarding … so the first real meeting isn't interrupted by them", and `platform-perms.ts` opens
with "macOS needs Screen Recording + Mic permissions. Windows needs Mic permission".

**Actual.** `permissionsRequestUpfront` was wrapped entirely in `if (process.platform === 'darwin')`, so
on Windows it did nothing at all. `windowsScreenStatus()` returned a hardcoded `'unknown'`, so no code
path could ever establish whether screen capture worked on Windows.

**Repro.** Install on Windows, complete onboarding, ask a screenshot question in the first meeting. If
capture is blocked by the graphics-capture privacy setting, the failure surfaces mid-meeting — the setup
checklist reported `screenRecording: 'unknown'` throughout and could not warn. Confirmed live: the QA
suite's boot group observed `{"mic":"granted","screen":"unknown"}` on Windows.

**Fix.** `probeScreenCapture()` performs a 1px `desktopCapturer` capture and records the outcome as real
evidence; `windowsScreenStatus()` returns that instead of a constant. The probe runs at boot on Windows
(where it raises **no** prompt) and stays inside onboarding on macOS (where it *does* raise the TCC
prompt and needs explaining first). `permissionsRequestUpfront` now has a win32 branch. macOS still
treats TCC as authoritative and consults probe evidence only when TCC is undecided.

### MQA-003 — a dead provider is retried first on every ask (no circuit breaker)

**Intended.** `src/main/index.ts` justifies capping same-provider retries when a failover target exists
so "the API answers in seconds instead of after the full ~30s of retrying a dead primary" — i.e. the
design explicitly values not burning the user's time on a provider that cannot answer.

**Actual.** Nothing remembers that a provider just failed. `pickPrimaryProvider` selects the configured
provider again on the very next ask, so every request re-pays the dead provider's round trip.

**Repro (measured, not theoretical).** With a revoked DeepSeek key configured, three consecutive suggest
asks each produced the walk `["deepseek","nvidia","local"]`, costing 6.5s / 9.3s / 9.2s before the local
model answered. Live suggestions have a 15s idle budget, so on a slower network this alone can exhaust
it — the user sees "no suggestion" rather than a fast local one.

**Suggested fix.** A short in-memory per-provider cooldown (e.g. skip a provider for N minutes after M
consecutive pre-token auth failures), cleared whenever its key changes or the app restarts. Must not
persist to disk — a provider outage should not outlive the session.

### MQA-004 — nothing ever marks a provider whose key died as not-ready

**Intended.** `publicSettings()` documents `providerReady` as "Active provider is usable: key present AND
any provider-specific setup done … Drives the add-key CTA so it only shows when the app genuinely can't
answer yet."

**Actual.** `providerReady` is derived purely from a key *string existing* (`hasApiKey`), never from
whether that key *works*. No failure counter, no health state, nothing downgrades it.

**Repro (measured).** With a revoked DeepSeek key that had just 401'd on three consecutive asks, the
settings snapshot still reported `providerReady: true`. The user is told everything is fine while every
cloud ask silently degrades to the on-device model, and there is no banner, badge, or CTA pointing at
the real problem. `testApiKey` *does* correctly reject the dead key (`401 … your api key … is invalid`),
so the detection capability exists — it is simply never invoked automatically.

**Suggested fix.** Track consecutive pre-token auth failures per provider; after a threshold, surface a
dismissible "Your <provider> key stopped working — re-enter it" banner deep-linking to Settings → AI,
and reflect it in `providerReady`. Pairs naturally with the MQA-003 cooldown (same signal drives both).

### MQA-005 — raw provider error text reaches the user

**Intended.** `askStart`'s error path replaces transport strings with clean copy — "Replace raw client
transport strings … with a clean message" — and the no-key path produces the well-formed
"No API key for Claude · Anthropic. Open Settings (gear) and add it."

**Actual.** A non-transient, non-Dust-auth failure falls through to `: message`, passing the provider's
raw string straight to the UI.

**Repro (measured).** Dead DeepSeek + dead NVIDIA keys with the local fallback disabled produced exactly
`403 status code (no body)` in the renderer. That tells the user nothing about what to do.

**Suggested fix.** Map auth-shaped failures (401/403/402, "invalid api key", "insufficient credit") to an
actionable message naming the provider and pointing at Settings, the same way the no-key path already does.

### MQA-006 — the first on-device answer after launch times out

**Intended.** Métis Local exists so that "a zero-API-key install still gets a working assistant"
(`src/shared/ipc.ts`, `localLlm.fallback`). `local-routing.ts` describes prewarm as warming the sidecar
so a real suggest does not pay the spin-up.

**Actual.** `localPrewarmEligible` required `useFor.suggest`, which now defaults to **false** (it must, or
local would preempt a configured cloud provider — see the non-preemption contract). So on exactly the
install this feature targets, prewarm never ran, the sidecar was always cold when the fallback finally
routed to it, and a cold ~730 MB GGUF load routinely exceeds `askStart`'s 15s suggest idle budget.

**Repro (measured, physical).** Fresh profile, zero API keys, `scripts/qa/e2e-workflows.mjs --only=ask`
immediately after launch: `suggest answers on-device with zero API keys configured` failed with
`Stream timed out — no response from the model.` The same check passed on a warm run — this is a
first-use-only failure, i.e. precisely a new user's first impression. It was introduced by the
`useFor`-defaults-off change and is therefore a regression of that change, caught by physical QA rather
than by any unit test.

**Fix.** Two complementary changes. (1) `localPrewarmEligible` gained a `cloudReady` argument and now
also engages when the fallback is armed and **no** cloud/CLI provider is ready — local is then the likely
server, so warming it is justified; with a healthy cloud provider configured the gate stays false and no
sidecar is spawned for its standing RAM cost. (2) `askStart` applies a 90s idle floor when routing to
local while the sidecar is not yet running, so a legitimate cold load is never mistaken for a hang. Once
warm, local keeps the normal tighter budgets.

### MQA-007 — suite flakiness under heavy parallel load

**Intended.** A green suite should mean the code is correct; a run's result should not depend on what
else the machine is doing.

**Actual.** With ~16 concurrent vitest processes running (a multi-agent QA sweep), individual runs failed
non-deterministically in `src/main/brain/corrections.test.ts` with
`ENOENT: … rename '….brain\index.json.<hash>.tmp' -> '….brain\index.json'` — the tmp+rename durability
path racing its own teardown. Different runs of identical code failed different tests.

**Evidence both ways.** Three consecutive full runs of the same tree gave 1 failure, 4 failures, then
**0 failures / 1925 passed / `success: true`**. Isolated runs of the implicated files pass consistently.
So this is a test-harness race under abnormal load, not a product defect — but it is exactly the kind of
flake that erodes trust in the gate, and this repo has a documented history of teardown races masking
real failures.

**Not fixed.** Left OPEN deliberately rather than papered over: the honest fix is to make the brain
tests' temp-profile teardown await in-flight index writes (an exported settle hook already exists,
`whenIndexWritesSettle`), which is a focused change that deserves its own pass rather than being bundled
into a QA sweep. CI runs a single suite at a time and is unaffected today.

### MQA-001 (continued)

**Not verified.** The exact live behavior of `reasoning_effort` on DeepSeek V4 (whether `low` fully
suppresses thinking, vs. the separate documented `thinking: {type}` parameter) has **not** been confirmed
against the live API — no DeepSeek key was available. `openai.ts`'s param-rejection retry means a
rejected `reasoning_effort` degrades safely rather than failing the request, but latency on the base tier
should be measured with a real key before relying on DeepSeek for live suggestions.
