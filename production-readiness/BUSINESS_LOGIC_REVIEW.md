# AskToto — Business-Logic Review

**Gate:** Gate 4 (Backend / business logic)
**Scope:** settings layering & migration, key storage, model routing, transcript persistence,
graphify build orchestration, meeting detection, auth/session logic. **Date:** 2026-06-27

This reviews the **correctness** of the main-process logic (not just its security): the invariants that,
if broken, corrupt data, lose meetings, mis-route models, or brick the app.

---

## 1. Settings layering & fail-safe migration — PASS (well-engineered)

`getSettings()` (`store.ts:142-160`) layers **DEFAULT < managed (org policy) < user overrides** and is
hardened against a poisoned config bricking every IPC handler that reads it:

- Whole-object parse first; on failure, `validKeysOnly` keeps only individually-valid user keys.
- Repairs the one cross-field invariant (`provider:'custom'` needs https `customBaseUrl`) and, crucially,
  resets `provider` to the **provider-independent** default so a malicious `managed-config` setting
  `provider:'custom'` cannot make the repair a no-op and throw org-wide (`store.ts:151-156`).
- Final fallback is `SettingsSchema.parse(DEFAULT_SETTINGS)`, which is always valid.

`selftest.ts:30-66` exercises exactly this: malformed managed-config (`temperature:'NaN'`,
`mode:'bogus'`) and bad user values do **not** crash `getSettings`, bad fields drop to defaults, valid
ones (`provider:'kimi'`) apply. **Admin precedence is correct**: machine-wide policy overlays the
per-user file (`store.ts:86-91`) and `getLockedKeys` unions both so locked keys can't be edited from the
UI (`store.ts:94-98,167-174`). **This is a robust, production-grade config system.**

---

## 2. API-key storage — PASS

`setApiKey` (`store.ts:186-202`) **refuses to persist** when `safeStorage` is unavailable (throws a
clear message) rather than writing plaintext — correct fail-closed posture. Empty input clears the key.
`getApiKey` reads **env first** (`store.ts:296-306`), enabling env-var keys without writing disk; a
legacy `plain:` prefix is read but **never written** by current code. Files are `0o600`. Settings (which
hold profile PII + contextDocs) are encrypted whole-file at rest with atomic temp+rename
(`store.ts:176-183`) — a crash mid-write cannot wipe every setting.

**Edge note (LOW):** `getApiKey` env-precedence means a shell-exported `ANTHROPIC_API_KEY` silently
overrides the in-app stored key even in a packaged build. Intended for power users, but worth documenting
so a stale env var doesn't mask the configured key.

---

## 3. Model routing & tier resolution — PASS

`routeTier` (`routing.ts:51-65`) is deterministic and zero-latency: `suggest`→always base (real-time);
`never`/`always` honored; in `auto`, `recap`→think, `summary`→base, chat/vision escalate only when
`isHardQuestion` matches (code fences, >600 chars, technical/math/"think-harder" regexes,
`routing.ts:21-45`). `resolveModelTier` (`providers.ts:315-328`) falls back think→base→default so a
provider without a distinct think model still resolves a model. `ask:start` validates that a model
exists and that vision is supported before streaming, returning actionable `streamError`s instead of
silent failures (`index.ts:506-531`). **Logic is coherent and matches the documented thinking-mode
policy.** The `ProviderIdSchema`↔`ProviderId` parity guard (`ipc.ts:21-29`) prevents enum drift.

---

## 4. Transcript / note persistence — PASS (one MEDIUM carryover)

`saveMeeting`/`saveNote` (`transcripts.ts:178-265`) are **collision-safe** (incrementing `-2,-3,…`
suffix when a same-second file exists), write **Dust-readable frontmatter** (`status:
ready-for-followup`), and **YAML-escape** titles (`yamlSafeTitle`, control-char strip in `cleanTitle`,
`transcripts.ts:166-175`) — no frontmatter injection from a hostile meeting title. Writes are atomic
(temp+rename) with temp cleanup on failure (`writeSaved`, `transcripts.ts:39-62`). When encryption is on,
the plaintext `index.md` row is **skipped** so titles/dates don't leak (`transcripts.ts:204-209,259-263`)
— a thoughtful correctness/privacy invariant. `selftest.ts:68-91` verifies collision-safety, index, and
frontmatter against the **real** save path.

**MEDIUM (carryover):** `appendIndexRow`, `ensureMeetingsFolder`, and the writes are synchronous; with
the folder on OneDrive (possibly offline) a slow write blocks the main thread. The functions fail-open on
error (no data-loss, but a dropped index row). Acceptable; pairs with the async-fs item in
`BACKEND_REVIEW.md §6`.

---

## 5. Graphify build orchestration — PASS (race fixed, confirmed)

`buildGraph` (`graphify.ts:193-226`) sets the `building` lock **synchronously before any `await`**
(`graphify.ts:196-198`) — the comment explicitly calls out that `detectPython`/`pickBackend` yield to
the event loop, so without the early lock a rebuild double-click + the debounced timer could spawn
concurrent builds into the same `outDir`. **This is the buildGraph race the prior audit fixed; confirmed
present and correct.** `scheduleRebuild` (`graphify.ts:234-243`) coalesces save bursts into one
incremental rebuild (20 s debounce) and **skips when transcripts are encrypted** (the runner can't read
them) — correct invariant. Backend selection prefers the local Claude CLI (no key), then stored
Claude/OpenAI, never Gemini (`graphify.ts:144-154`), matching the design. `computeRelated`
(`graphify.ts:266-323`) is a pure, unit-tested function (1-/2-hop concept neighbours), keeping the graph
logic testable without Electron.

---

## 6. Meeting detection — PASS

`detectMeeting` (`meeting-detect/index.ts`) is **fail-open** (never rejects; returns `''` on any error),
so a flaky AppleScript/PowerShell probe can't crash the poller. The poller
(`index.ts:312-335`) guards against **overlap** (`meetingDetecting` flag — skips if the prior detect is
still running) and only fires the consent banner on a **visible** transition (`!meetingActive`). The mac
path degrades AppleScript → title-only → CGWindow fallback (`mac.ts:166-182`). Detection heuristics
(`shared.ts`, `win.ts:77-102`) conservatively avoid chat-only Slack/Teams windows. No correctness or
security issue; `customMeetingApps` are matched in JS only (see injection analysis in
`BACKEND_REVIEW.md §4`).

---

## 7. Auth / session logic — PASS (with the enforcement caveat)

`signIn` (`auth.ts:157-245`) is a correct PKCE public-client flow: tenant lock + domain check on
id-token claims, session persisted encrypted (`auth.ts:122-131`), and **stale-session invalidation** when
the configured `allowedDomain` changes (`auth.ts:137`). Config precedence
env → machine-managed → per-user-managed → in-app settings (`auth.ts:85-99`) ensures an org deployment
can't be loosened from the UI. The **business caveat** (not a bug): `requireAuth` returns true when
unconfigured, so the gate is inert until SSO is deployed — see `AUTHORIZATION_MATRIX.md` enforcement
caveat. This is the single most important pre-prod action item for a sensitive-data rollout.

---

## 8. Stream bookkeeping — MEDIUM (no timeout)

`streams` Map entries are deleted on done/error/cancel (`index.ts:547-568`), but a provider that hangs
without ever streaming or closing (OpenAI/Dust branches have **no timeout**, `llm.ts`) leaves a dangling
entry + open `AbortController` and a stuck renderer spinner. Add a request timeout. (Cross-referenced in
`BACKEND_REVIEW.md §5`.)

---

## Gate summary (Business logic)

| Gate | Status | Evidence |
|---|---|---|
| Settings layering + crash-proof migration | **PASS** | `store.ts:142-160`; `selftest.ts:30-66` |
| Key storage fail-closed + encrypted at rest | **PASS** | `store.ts:186-202` |
| Model routing / tier resolution correctness | **PASS** | `routing.ts`, `providers.ts:315-328` |
| Transcript persistence (atomic, collision-safe, YAML-safe) | **PASS** | `transcripts.ts`; `selftest.ts:68-91` |
| Graphify concurrency (build lock) | **PASS** | `graphify.ts:196-198` (race fixed) |
| Meeting detection fail-open + no overlap | **PASS** | `index.ts:312-335`, `meeting-detect/*` |
| Auth/session correctness | **PASS** | `auth.ts:137,157-245` |
| Auth gate **enforced** (prod, sensitive data) | **UNKNOWN** | unconfigured ⇒ `requireAuth`=true |
| Stream timeout / cleanup | **FAIL** | no timeout on OpenAI/Dust streams |
| Sync-fs blocking main thread (recall/transcripts) | **FAIL** | `recall.ts:51-88` (MEDIUM) |
