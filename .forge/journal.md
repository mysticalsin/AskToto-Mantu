# forge journal — AskToto enterprise hardening

## 2026-07-07 — recap-on-import live validation + error-message accuracy fix

**Goal:** Prove the recap-on-import feature (import audio → AI recap auto-generated) works end-to-end
against a real provider, and confirm the on-demand "Generate recap" fallback.

**What happened:**
- Ran `.forge/qa-recap.mjs` against packaged `win-unpacked` with a known-good provider.
- Both auto-recap-on-import and on-demand `recallGenerateRecap` returned empty with the generic
  `"No AI provider is configured. Add one in Settings."` — even though `providerReady=true`.
- Instrumented `generateRecapForTranscript` with gate-reason logging, rebuilt, re-ran. Trace:
  ```
  [recap-dbg] provider=kimi kind=openai allowed=null hasKey=true dustReady=false
  [recap-dbg] tier=think model="kimi-for-coding" thinkingMode=auto
  [recap-dbg] onError: 403 You've reached your usage limit for this billing cycle ...
  ```

**Root cause:** NOT a code bug. The recap path resolves provider + model correctly, makes the real
streaming call, and fails gracefully. The provider (Kimi) returned **403 quota exhausted**; the
earlier NVIDIA env-key attempt hit the same class (stale key). Provider-account state, not logic.

**Real defect surfaced (fixed):** the on-demand handler mapped *any* null recap to
`"No AI provider is configured"`, which misdirects a user whose provider IS configured but hit a
quota/auth wall. Refactored `generateRecapForTranscript` to return a `RecapResult` union
(`{ok:true,recap}` | `{ok:false, reason:'not-configured'|'provider-error'|'empty', message?}`) so the
handler surfaces the provider's actual message (e.g. the 403 quota notice) instead of the blanket
"configure a provider". Verified live: error now reads the real 403 text.

**Validation status:** recap path exercised end-to-end (provider/model resolution → real API call →
graceful failure with accurate message). A *successful* recap render was not captured because both
available providers were out of quota / stale-keyed at test time; the success path is identical to a
normal `ask` (proven working earlier — Kimi streamed `QA-OK-42` before quota ran out).

**Files:** `src/main/index.ts` (`RecapResult` type + handler mapping), `src/main/import-audio.ts`
(`RecapGenerator` type + `.ok` usage). Typecheck clean, 534/534 tests pass.
