# AskToto — API Security Report

**Gate:** Gate 4 (Backend / API)
**Date:** 2026-06-27

> **What "API" means here.** AskToto exposes **no inbound HTTP/REST/gRPC API and runs no server**. The
> "API surface" is two things: (1) the **internal IPC contract** between renderer and main process
> (`src/shared/ipc.ts` + `src/preload/index.ts`), and (2) the **outbound** calls the main process makes
> to LLM providers and to Dust. This report covers both. Inbound-API gates (authn/authz on routes, CORS,
> rate-limiting, request-body limits, WAF) are **N/A — there are no routes**; the one exception is the
> transient OAuth loopback listener, assessed in §4.

---

## 1. Internal IPC API — the real attack surface

The IPC contract is a fixed channel map (`ipc.ts:32-70`) bridged through a typed, allow-listed `toto`
object (`preload/index.ts:34-85`). The renderer cannot invoke arbitrary channels. Each handler enforces:

1. **Origin** — `assertMainWindow` (sender must be the main window top frame). 32/32 handlers. 
2. **Identity** — `requireAuth` on every data/privileged channel (15 sites).
3. **Schema** — zod parse on every structured payload.

See `AUTHORIZATION_MATRIX.md` for the channel-by-channel proof. No IPC handler is missing the origin
check; the only ungated-on-`requireAuth` channels are settings/auth/window/UI and are justified there.

### IPC input limits (anti-DoS / anti-overflow) — PASS
- `ask:start` image: base64 **≤ 5.5 MB** + charset refine (`ipc.ts:122-129`).
- `contextDocs`: **≤ 25 docs/mode**, **≤ 120 000 chars/doc** (`ipc.ts:194-199`); folded into prompts
  with a hard **40 000-char budget** (`personas.ts:24-39`); profile capped at **24 000** (`personas.ts:19`).
- `customMeetingApps`: ≤ 20 items, ≤ 80 chars each (`ipc.ts:218`).
- `outputLanguage`: ≤ 40 chars (`ipc.ts:185`).
- Transcript slices bounded before send (`llm.ts:21-35`: 6 000–16 000 chars).

---

## 2. Outbound provider calls — TLS & key handling

- All provider base URLs are **https** (`providers.ts:37-243`); the OpenAI/Anthropic/Dust SDKs use
  HTTPS. `custom`/`dust` base URLs are zod-refined to `^https://` (`ipc.ts:152-169,221-227`). There is
  **no plaintext-http egress path**.
- Keys are read env-first then from the `safeStorage`-encrypted on-disk blob (`store.ts:295-306`); they
  are injected only into the SDK client constructor, never logged (verified), never sent to the renderer.
- `temperature`/`max_tokens` are branched correctly for OpenAI o-series reasoning models
  (`llm.ts:227-239`) — avoids 400s but no security impact.

### LOW — SSRF-shaped surface via `custom`/`dust` base URL
`ask:start` and `testApiKey` will POST to a **user-configured** `customBaseUrl`/`dustBaseUrl` carrying
the user's key (`index.ts:532-533`, `store.ts:242-256`). This is intended (BYO endpoint) and is
constrained to `https://` and to the **trusted main-window** renderer, so it is the user pointing their
own client at their own endpoint — not classic SSRF (no server-side fetch of attacker URLs on behalf of
a third party). Flagged for completeness; no action required for single-user.

---

## 3. Supply chain (outbound dependency risk) — FAIL (MEDIUM)

```
$ npm audit
27 vulnerabilities (11 moderate, 16 high)        # full tree
$ npm audit --omit=dev
9 vulnerabilities (4 moderate, 5 high)           # runtime tree
```

**Runtime-tree vulnerabilities all originate from one chain:**
`@dust-tt/client` → `@modelcontextprotocol/sdk` → `express`, `body-parser`, `qs`, `path-to-regexp`,
`router`, `ajv`, `express-rate-limit` (DoS / ReDoS / MCP DNS-rebinding & cross-client leak advisories).

**Reachability assessment:** AskToto uses `@dust-tt/client` **only as an HTTP client** —
`createConversation`, `streamAgentAnswerEvents`, `getAgentConfigurations` (`llm.ts:136-152`,
`store.ts:227-289`). It **never instantiates the MCP server / Express middleware** where these
DoS/ReDoS/DNS-rebinding bugs live, so the vulnerable code is present in the tree but **not on a reachable
path**. Real but limited → **MEDIUM**. *Fix:* upgrade `@dust-tt/client` to a release that drops or
patches the MCP `express` chain, or `npm audit fix` / override the transitive `path-to-regexp`/`qs`.

The remaining 18 (full-tree) vulns are the **electron-builder toolchain** (`app-builder-lib`,
`dmg-builder`, `cacache`, `make-fetch-happen`, `node-gyp`, `tar`) — **build-time devDependencies only**,
not shipped in the app → **N/A for runtime**, still worth a CI `audit` budget.

### Whisper model fetch — no SRI (known gap)
The ONNX Whisper model is fetched from the HF CDN on first Listen with **no subresource integrity** (per
the established findings; the fetch lives in the renderer/transformers layer, outside `src/main`). A
MITM/CDN-compromise could serve a tampered model. **MEDIUM/deferred** — pin a hash or bundle the model.

---

## 4. Inbound surface — the only listener (OAuth loopback) — PASS

The sole inbound socket is the **temporary** OAuth redirect listener in `signIn`
(`auth.ts:174-213`): `server.listen(0, '127.0.0.1')` (loopback-only, **random port**), serves **one**
request, then `server.close()`; a **5-minute** timeout tears it down. It only extracts the `?code=` and
hands it to the PKCE token exchange (verifier required) — a forged hit cannot mint a session without the
verifier. **No general-purpose server, no remote bind, no persistent port.**

---

## 5. Prompt-injection handling (LLM "API" abuse) — PASS

Untrusted-content modes (`suggest`/`summary`/`recap`/`vision`) get an `INJECTION_GUARD` appended
(`personas.ts:70-81`); imported reference docs and transcripts are explicitly framed as **data, not
instructions** (`personas.ts:35`, `llm.ts:21-35`). `selftest.ts:110-122` asserts the guard is present on
all three untrusted modes. This is the correct posture for treating transcript/screen/doc content as
hostile.

---

## Gate summary (API)

| Gate | Status | Evidence |
|---|---|---|
| IPC origin + identity + schema | **PASS** | §1; `AUTHORIZATION_MATRIX.md` |
| IPC input size limits | **PASS** | §1 |
| Outbound TLS (https-only) | **PASS** | https base URLs + zod refine |
| Key handling (no renderer/log leak) | **PASS** | `BACKEND_REVIEW.md §7` |
| Supply chain (runtime deps) | **FAIL** | 9 runtime vulns via `@dust-tt/client`→MCP SDK |
| Supply chain (build deps) | **N/A** | electron-builder toolchain, not shipped |
| Whisper model integrity (SRI) | **FAIL** | no SRI on HF CDN fetch (deferred) |
| Inbound OAuth loopback hardening | **PASS** | loopback, random port, 1-shot, 5-min timeout |
| Prompt-injection guard | **PASS** | guard on untrusted modes |
| Inbound REST/CORS/rate-limit/WAF | **N/A** | no inbound server (justified) |
