---
project: Métis
type: operator-slice-contract
slice: portal-hosted-llm-bind
status: FRAME
owns:
  - Portal Keys → Operator proxy → provider for licensed·approved seats
  - Cloudflare Workers AI / AI Gateway DeepSeek bind (no seat-local key)
  - Métis Ask E2E on that bound path
  - Cost/usage compare Portal-proxied CF vs non-CF
does-not-own:
  - overlay chrome / Settings CF tile (KineticGrid b8a677b)
  - installer pack / Latest / EXE / DMG
  - Fly license-server
  - CF OAuth polish (LAST)
  - MCP gateway-token
  - Goldberg Aria
ready-to-merge: no
audience: Tony Walteur only
prove-host: https://metis-operator.tony-walteur.workers.dev/
---

# FRAME — Portal-hosted LLM bind (Workers AI / AI Gateway DeepSeek)

**Status: FRAME.** DESIGN before UI. No product code in the change that lands this file.
READY TO MERGE stays no. Pack HOLD. OAuth LAST.

Operator = Portal. Live console: `https://metis-operator.tony-walteur.workers.dev/`.
Worker name `metis-operator`. Not `cloudflare-proxy`. Not Fly.

---

## Tony hard locks (non-negotiable)

### 1. Portal-hosted keys for licensed seats

When Tony adds an API key on Portal `#keys` (Anthropic / DeepSeek / Cloudflare / any vault LLM),
an **approved or licensed mid-tier** seat (`operator_keys` entitlement — default Métis tier, not
Métis Light) must spend **that** key through the Operator proxy.

- Seats **never** receive the key.
- Seats **must not** need their own paste for that provider.
- Flow: **licensed Métis → Operator → provider.**

This is already the Keys page copy on the live Portal:

> Seats never receive these keys. A licensed seat calls the Operator, and the Operator calls the provider.

> After a seat is approved, these keys are the default Ask path. CLI tokens stay on the seat.

The implement slice makes that copy true end to end. It does not invent a second key story.

### 2. Prove host

Full E2E prove **only** on `https://metis-operator.tony-walteur.workers.dev/`.
Tony states A–D already proven there. No alternate host. No staging Worker. No localhost
stand-in as the Ultron stamp. No `cloudflare-proxy` URL as the Portal path.

---

## Ultron process

Write this file first. Then UI / Worker / desktop contract work in a later slice.
Do not invent Keys chrome. Do not pack. Do not contact Tony from this agent.

---

## 1. Current state (what already ships)

Investigated on `feat/operator-wow` tip at FRAME time. Do not treat hypotheses as facts.

### 1.1 Three planes (keep them distinct)

| Plane | Worker / app | Role today |
| --- | --- | --- |
| Portal / Operator | `metis-operator` | Access console, license generate, seat approve, vault, HMAC ingest, `POST /v1/use` |
| Desktop seat | Electron `src/` | Overlay Ask, CLI-first, Operator heartbeat, `streamOperatorAsk` → `POST /v1/ask` |
| AI token proxy | `metis-cloudflare-proxy` | Desktop OpenAI-compat shim. Account token in Wrangler secrets. **Not** Portal vault |

`docs/design/OPERATOR.md` and `operator/README.md` already say Operator ≠ `cloudflare-proxy`.
This FRAME does not merge those Workers.

### 1.2 Portal Keys + vault (done)

- `#keys` paste form: Anthropic, OpenAI, Gemini, NIM, **DeepSeek**, MiniMax, Qwen, Kimi,
  OpenRouter, Groq, Mistral, Grok, Custom. AES-GCM in D1 `vault_keys`. last4 only in HTML/JSON.
- Cloudflare · AI Gateway card: **Log in to Cloudflare** → `GET /cloudflare/connect` → callback
  dual-writes vault `cloudflare-account` + `cloudflare` (label `AI Gateway`).
- `ensureDefaultAiGateway` POSTs gateway id `default` (best-effort; first authenticated Ask
  also auto-creates).
- OAuth scopes already include `workers-ai:run`, `ai-gateway:read`, `ai-gateway:edit`.
- Missing `CF_OAUTH_CLIENT_ID` / `CF_OAUTH_CLIENT_SECRET` → fail loud on Keys (503 after Access).
  License generate must still work. OAuth stays LAST.
- Forbidden in vault: `claude-cli`, `codex-cli`, `dust`, `local`.

Live copy already matches lock 1. The bind/Ask path does not yet.

### 1.3 Seat authorization (done)

`seatAuthorizedForKeys` = Tony Approve **or** active issued license jti. Revoke wins.
Heartbeat returns `fundedProviders` (IDs only) + `tier` + `entitlements` to an authorized seat.
Default Métis tier includes `operator_keys`. Métis Light does not (`ask` + `intelligence` only).
Desktop `operatorFundedProviders()` empties the list when `operator_keys` is false.

First heartbeat can bind `activated_device` to the jti. That is seat bind for **license**, not
yet a named “CF / Portal LLM bind” object.

### 1.4 Operator LLM proxy today (partial)

`POST /v1/use` (HMAC, not Access):

- Decrypts the active vault row for `provider`. Never returns the secret.
- **DeepSeek** → `https://api.deepseek.com/v1` **direct** (Tony’s vault DeepSeek key).
- **Cloudflare** → `https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1/chat/completions`
  with `cf-aig-gateway-id: default` (Tony’s vault CF token + account id).
- **Anthropic / OpenAI-compat** → vendor base URL with the vault secret.
- **Buffered JSON.** 60s timeout. No SSE. Rejects vision / screenshots.
- Tests cover authorized `/v1/use` with `provider: cloudflare` after OAuth provision.

No wrangler `ai` binding on `metis-operator` or `metis-cloudflare-proxy`. REST + header only.

### 1.5 Desktop Ask today (split contract)

Routing law (`src/shared/ask-routing.ts`): working CLI first; then Operator-hosted IDs after
CLI exhaustion; Dust never general chat.

Desktop `viaOperator` when: no seat-local key, provider ∈ `operatorFundedProviders()`,
`operator_keys` entitled. Then `streamOperatorAsk` HMAC POSTs **`/v1/ask`** and requires
`text/event-stream` (`delta` / `done` / `error`).

**The Worker does not register `/v1/ask`.** README and `operator/src/index.ts` document
`/v1/use` only. Portal-funded streaming Ask is not E2E.

`OPERATOR_HOSTED_PROVIDER_IDS` includes `deepseek` and Anthropic/OpenAI/… **It does not
include `cloudflare`.** Heartbeat may list `cloudflare` (vault allowlist has it);
`filterFundedProviders` drops it. A licensed seat cannot spend Tony’s CF vault row via
the funded-providers path.

Seat-local Cloudflare still works the old way: `cloudflareBaseUrl` + proxy/account key
(embedded or pasted). That is **not** Portal-hosted keys. North star §4.5 and
`docs/CLOUDFLARE.md` remain true for that plane.

### 1.6 `gateway-token` (not this slice)

`operator/src/connectors/gateway-token.ts` mints a 1h HMAC bearer for brokered **MCP**
(`POST /v1/mcp/:id`). Not AI Gateway. Do not reuse the name for LLM bind.

### 1.7 Cost / usage today

| Meter | What it is | Gap |
| --- | --- | --- |
| D1 `asks` tokens + cache fields | Ingested from the seat | Empty if Ask never completes through Operator |
| `LIST_PRICE_TABLE` | Claude / GPT families only | No `@cf/…`, no `deepseek-v4-*` |
| Overview Value | Time-saved × hourly rate, or `not reported` | Not LLM $ |
| `pullCloudflareOverview` | GraphQL **Worker invocations** (requests / errors / cpuMs) | Not AI Gateway tokens or $ |
| `/v1/use` | Returns token counts when the vendor sends them | Not persisted as an Ask row with a path tag |

Missing usage stays **`not reported`**. Never `$0`.

### 1.8 Cloudflare-hosted DeepSeek (catalogue, not wired)

Workers AI (Aug 2026, Cloudflare docs) hosts:

| Model id | Role | Published unit price (docs at FRAME time) |
| --- | --- | --- |
| `@cf/deepseek-ai/deepseek-v4-flash-0731` | Base / everyday | $0.44 / $1.32 / $0.014 per M (in / out / cached in) |
| `@cf/deepseek-ai/deepseek-v4-pro-0813` | Think / deep | $1.32 / $3.96 / $0.044 per M |

Paid Workers plan or prepaid AI Gateway credits. Same REST path Operator already uses for
`provider: cloudflare`. Desktop `PROVIDERS.cloudflare` still lists Llama Scout / Llama 3.3 /
gpt-oss only. `PROVIDERS.deepseek` still points at `api.deepseek.com` with
`deepseek-v4-flash` / `deepseek-v4-pro`.

AI Gateway also accepts third-party `deepseek/…` (Unified Billing or BYOK). Workers AI
`@cf/deepseek-ai/…` does **not** need a DeepSeek platform key.

---

## 2. Target architecture

### 2.1 One law

**Tony’s Portal vault is the key. The Operator Worker is the only process that decrypts it.
The seat sends HMAC + prompt. The provider never sees a Métis seat credential.**

No mid-flight key invent: no generated DeepSeek key, no generated CF token, no embed, no
copy of the vault secret onto the seat, no “temporary” key in heartbeat JSON.

### 2.2 Bind (what “seat bind” means)

Bind is authorization + funded IDs, not a new secret.

```
Tony: Portal #keys Add API or Log in to Cloudflare
        │  vault write (AES-GCM). last4 only in UI
        ▼
Tony: Generate license  OR  Approve seat
        │  jti activate on Métis → Identity, or approval=approved
        ▼
Seat heartbeat (HMAC) { license, licenseId }
        │  seatAuthorizedForKeys + operator_keys
        ▼
Heartbeat JSON: fundedProviders: ["anthropic","deepseek","cloudflare",…]
        │  IDs only. Never secret, cipher, account token
        ▼
Seat memory: operatorFundedProviders()
        │  renderer: hasKeys / last4 facts only
        ▼
Ask: viaOperator → Operator proxy → vendor
```

`cloudflare-account` stays a vault meta row for Overview / GraphQL. It is **not** a
funded provider ID. Advertise `cloudflare` (the AI Gateway / Workers AI row) only.

Mid-tier = default `metis` tier with `operator_keys`. Light stays unfunded.

### 2.3 Two DeepSeek paths (keep both; tag them)

| Path id | Vault row Tony added | Upstream | Needs DeepSeek platform key? |
| --- | --- | --- | --- |
| `portal-cf` | `cloudflare` (+ account id on the row) | CF AI REST + `cf-aig-gateway-id: default` + `@cf/deepseek-ai/…` | No |
| `portal-direct` | `deepseek` | `api.deepseek.com` | Yes — the vault secret |

Both are Portal-hosted. Both are lock 1. The FRAME’s **CF DeepSeek bind** is `portal-cf`.
`portal-direct` stays the non-CF compare and the path when Tony pasted DeepSeek and has
not connected Cloudflare.

Do **not** merge the two into one provider ID. Cost compare dies if you do.

Do **not** send the vault DeepSeek key to Cloudflare as a request header on `portal-cf`.
CF credential precedence: a provider key on the request skips BYOK / Unified Billing and
is the wrong hop.

Optional later (not this FRAME’s happy path): Unified Billing `deepseek/deepseek-v4-flash`
through the same REST API when the gateway has credit. Still Tony’s CF token. Still no
seat key. Still `portal-cf`. Do not default to it until a live account proves the id.

### 2.4 Upstream (reuse REST; do not require a new binding)

Happy path stays the documented REST API (`docs/CLOUDFLARE.md`):

```
POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions
Authorization: Bearer {vault cloudflare secret}
cf-aig-gateway-id: default   (or Operator-pinned id — never a caller-supplied one)
```

`stream: true`. Pass the SSE body through. Do not buffer the completion in the Worker.

A wrangler `ai` binding (`env.AI.run`) is **optional later**, same models, same gateway id.
It is not required to close the Ask gap. Do not add it in the first implement slice unless
streaming REST fails on a live prove.

Ignore caller `cf-aig-gateway-id` (proxy Worker already does). Pin on the Worker.

Deprecated `gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat/…` stays out
(`docs/CLOUDFLARE.md`). It bakes gateway id into a URL seats would have to know.

### 2.5 Default models on the Portal-funded CF path

When `viaOperator` and `provider === 'cloudflare'` (implement slice):

| Tier | Model |
| --- | --- |
| base / fast | `@cf/deepseek-ai/deepseek-v4-flash-0731` |
| think / deep | `@cf/deepseek-ai/deepseek-v4-pro-0813` |

Do not ship `workers-ai/` prefixes (MQA-226). Re-test ids against the **live** account
before locking defaults in code — Free plan refusal and catalogue drift are real.

Seat-local `PROVIDERS.cloudflare` defaults (Llama Scout, etc.) stay for the proxy-key
plane. Overlay Settings CF tile stays KineticGrid `b8a677b`. This FRAME does not restyle it.

Vision stays off on Operator proxy (MQA-227 transport limit; `/v1/use` already rejects
screenshots).

---

## 3. Secret / key seating (never invent mid-flight)

### 3.1 Where secrets live

| Secret | Seat | Portal UI | Worker |
| --- | --- | --- | --- |
| Vault LLM keys (Anthropic, DeepSeek, …) | never | last4 | D1 ciphertext + `OPERATOR_VAULT_KEY` |
| CF account / AI Gateway token | never | last4 | same vault (`cloudflare`, `cloudflare-account`) |
| `CF_OAUTH_*` | never | `oauthBound` flag | Wrangler secrets |
| `OPERATOR_INGEST_SECRET` | seat Settings (HMAC only) | bound / missing | Wrangler secret |
| `METIS_PROXY_KEY` / CF token on `cloudflare-proxy` | optional old plane | no | other Worker — out of this bind |
| MCP `gateway-token` | memory, 1h | no | mint only |

Decrypt happens inside `handleUse` / the future `/v1/ask` handler. Response JSON/SSE is
scanned so the secret, cipher, and iv never leak (already in `/v1/use`).

### 3.2 Fail loud — do not invent

| Condition | Response |
| --- | --- |
| No active vault row for the requested provider | `503` “Operator cannot issue a use” (keep honest copy; optional: “Connect it on Keys”) |
| Seat not approved and no active jti | `403` `SEAT_NOT_APPROVED` |
| `operator_keys` false (Light) | desktop: empty `fundedProviders`; no viaOperator |
| CF vault row missing `accountId` | `503` — cannot call account-scoped REST |
| OAuth secrets unset | Keys fail loud. Generate license still works. Paste vault still works |
| Caller sends a CF token or DeepSeek key in the Ask body | reject. HMAC seat body is provider/model/messages only |

Rotate / revoke stay the existing vault buttons. Revoke stops the next Ask. No seat update.

Build-time embedded Cloudflare (`docs/CLOUDFLARE.md` shape 2) is **not** the Portal bind.
Do not seed a new embed in this slice. Do not rotate Tony’s account token from Ask code.

---

## 4. Métis Ask E2E (desktop → Operator → CF)

Prove host only: `https://metis-operator.tony-walteur.workers.dev/`.

```
Métis desktop (licensed, operator_keys, no seat DeepSeek/CF key)
        │  CLI exhausted or absent
        ▼
nextAskRoute → { provider: 'cloudflare' | 'deepseek' | …, tier: 'operator' }
        │  HMAC headers (ingest secret). No LLM key
        ▼
POST https://metis-operator.tony-walteur.workers.dev/v1/ask
        │  Access must NOT wrap this path (same bypass as /v1/use)
        ▼
seatAuthorizedForKeys + decryptActiveLlmSecret(provider)
        │
        ├─ cloudflare → REST + gateway header + @cf/deepseek-ai/…   [portal-cf]
        └─ deepseek   → api.deepseek.com                            [portal-direct]
        │
        ▼
SSE stream to the seat (delta / done / error)
        │
        ▼
Ingest Ask row: provider, model, tokens, path tag, outcome
```

### 4.1 Contract to close

Desktop already speaks `/v1/ask` + SSE. Implement **on the live Operator Worker**:

1. Register `POST /v1/ask` next to `/v1/use` (HMAC, rate limit, Access bypass).
2. Same body parser / seat / vault rules as `handleUse`.
3. Stream upstream when the provider supports it (CF REST `stream: true` already works
   on `cloudflare-proxy`; copy that pass-through property).
4. Keep `/v1/use` as the non-stream / test / tooling path. Do not delete it.

Do not retarget desktop to buffered JSON. Overlay Ask is a stream.

Do not grow overlay Settings in this slice. Operator URL + ingest secret are already
how the seat finds Portal. KineticGrid CF tile is a different tip.

### 4.2 Prove script (implement slice, live host only)

A. Portal `#keys`: active `cloudflare` last4 (OAuth or already-seated vault — do not
   invent a token in the agent).  
B. Seat: issued Métis license or Approve; heartbeat shows `cloudflare` in
   `fundedProviders`; `operator_keys` true.  
C. Desktop: no `getApiKey('cloudflare')`, no `getApiKey('deepseek')`. Typed Ask.
   Tokens stream. Provider/model on the Ask row = `cloudflare` +
   `@cf/deepseek-ai/deepseek-v4-flash-0731` (or the live-proven id).  
D. Repeat with vault `deepseek` and no CF spend (or a second Ask) for `portal-direct`.  
E. Revoke the vault row or the seat → next Ask `403` / `503`, not a silent seat key.

A–D in Tony’s lock are **already proven** on this host for prior Operator slices.
Letters above are this FRAME’s Ask prove, not a rename of those.

---

## 5. Cost / usage — Portal-proxied CF vs non-CF

### 5.1 What to compare

Same prompt family, two Portal paths:

| Series | Path | Bill |
| --- | --- | --- |
| CF | `portal-cf` `@cf/deepseek-ai/…` | Workers AI / AI Gateway credits (Cloudflare) |
| Non-CF | `portal-direct` `deepseek-v4-*` | DeepSeek platform (Tony’s vault key) |

Optional third series later: CLI Asks (subscription, not Tony’s meter). Already split
in `dashboard.ts` as `cliAsks` vs `operatorAsks`. Keep that split. Add **CF vs
direct** inside `operatorAsks`.

### 5.2 Honest numbers only

1. Persist `/v1/ask` (and `/v1/use`) token fields onto D1 `asks` with `provider`,
   `model`, and a path tag (`portal-cf` | `portal-direct` | `cli` | `seat-local`).
2. Extend `LIST_PRICE_TABLE` with **labeled estimates** for:
   - `@cf/deepseek-ai/deepseek-v4-flash-0731` / `…-pro-0813` (Workers AI published).
   - `deepseek-v4-flash` / `deepseek-v4-pro` (DeepSeek published — re-verify at
     implement; desktop blurb today cites ~$0.14/1M in for Flash).
3. Overview / Keys: two lines, not one blended dollar. Copy must say **estimate,
   list price** when a $ is shown. Missing → `not reported`. Never `$0`.
4. Optional: AI Gateway analytics / logs for the `default` gateway (tokens, estimated
   cost, cache). Worker invocation GraphQL stays a **different** KPI (Operator
   Worker CPU). Do not label invocations as LLM spend.
5. Seat-local DeepSeek / embedded CF proxy spend is **out of the Portal compare**.
   Do not mix it into Tony’s vault meter.

Spend limits / User Insights on the gateway are Cloudflare dashboard features. Portal
may link; it must not invent per-seat $ from empty D1.

---

## 6. GAP list

| ID | Item | State | Slice |
| --- | --- | --- | --- |
| G0 | Keys copy + vault allowlist + last4 + AES-GCM | **DONE** | — |
| G1 | CF OAuth connect + dual vault write + default gateway | **DONE** (OAuth secrets may be unset; LAST) | — |
| G2 | `seatAuthorizedForKeys` + `operator_keys` + heartbeat IDs | **DONE** | — |
| G3 | `/v1/use` DeepSeek direct + CF REST (buffered) | **DONE** | — |
| G4 | `cloudflare-proxy` streaming REST + optional gateway pin | **DONE** (other Worker; not Portal bind) | — |
| G5 | `POST /v1/ask` SSE on `metis-operator` (desktop contract) | **MUST-BUILD** | implement |
| G6 | Put `cloudflare` in `OPERATOR_HOSTED_PROVIDER_IDS` / `filterFundedProviders` | **MUST-BUILD** | implement |
| G7 | Stream CF REST (`stream: true`) through `/v1/ask`; never leak vault | **MUST-BUILD** | implement |
| G8 | Portal-funded CF default models = `@cf/deepseek-ai/deepseek-v4-*` (live-proven) | **MUST-BUILD** | implement |
| G9 | Persist Ask path tag + tokens; CF vs direct cost series; list-price rows | **MUST-BUILD** | implement |
| G10 | Access bypass + rate limit for `/v1/ask` (same family as `/v1/use`) | **MUST-BUILD** | implement |
| G11 | Live E2E on `metis-operator.tony-walteur.workers.dev` only | **MUST-BUILD** | implement + Ultron |
| G12 | Wrangler `ai` binding | **NOT REQUIRED** | later if REST fails |
| G13 | Unified Billing `deepseek/…` as default | **NOT REQUIRED** | later |
| G14 | Overlay Settings CF tile / embed key | **OUT** | KineticGrid / pack |
| G15 | CF OAuth product polish | **OUT / LAST** | after Ask E2E |
| G16 | Pack / Latest / EXE / DMG | **HOLD** | Ultron + Bob QA |

Must-build for Ultron stamp of the **implement** slice: **G5–G11**.
This FRAME PR ships the doc only.

---

## 7. Out of scope

- **Pack HOLD.** No installer, no Metis-Releases Latest, no version bump.
- **OAuth LAST.** Do not block Ask E2E on `CF_OAUTH_*` being pretty. Seated vault
  rows (paste or a prior connect) are enough. Missing OAuth must not block
  Generate license (already law).
- Overlay chrome, Hide / Island / Bar, KineticGrid CF Settings tile.
- Fly license-server, ATK- keys, `LICENSE_ACTIVATION_OPEN`.
- MCP `gateway-token`, connector OAuth, ClickUp / Plane.
- Native Swift app.
- Merging `cloudflare-proxy` into Operator.
- Inventing keys, seats, dollars, or an alternate prove host.
- Contacting Tony from this agent.
- Fat PR151. Aria / Polo densify. WebsiteCloner chrome work.

---

## 8. Acceptance / Ultron stamp

### 8.1 This FRAME (docs PR)

1. This file exists under `docs/design/`. Ultron ACK.
2. No UI / Worker / desktop behavior change in the FRAME PR.
3. Cross-links only. Pack untouched.

### 8.2 Later implement slice (not this PR)

Stamp only if **all** hold on `https://metis-operator.tony-walteur.workers.dev/`:

1. Tony’s Portal key (CF and/or DeepSeek) answers a licensed Métis Ask. The seat
   has **no** local key for that provider. HMAC only.
2. Network: desktop → that Operator host `/v1/ask` → CF REST or `api.deepseek.com`.
   No account token and no DeepSeek secret in seat storage, logs, or renderer.
3. CF DeepSeek uses a live-proven `@cf/deepseek-ai/…` id, not `workers-ai/…`.
4. Unauthorized seat or revoked vault fails loud (`403` / `503`). No invented key.
5. Portal shows CF vs non-CF usage as estimates or `not reported`. Never `$0`.
6. CLI-first unchanged. Light tier stays unfunded. Vision still refused on Operator.
7. No pack. OAuth missing does not block license generate.

READY TO MERGE stays no until Ultron says otherwise.

---

## Implementation order (after Ultron ACK FRAME)

1. Land this DESIGN (this PR).
2. Worker: `/v1/ask` SSE + Access bypass + vault/stream (G5, G7, G10).
3. Shared routing: fund `cloudflare` + Portal-funded CF DeepSeek model ids (G6, G8).
4. Meter: path tag + list-price + CF vs direct series (G9).
5. Live prove on the lock-2 host (G11). No pack.

---

## Related

- Live Keys copy: `operator/src/render/pages/keys.ts`
- Vault / funded IDs: `operator/src/vault.ts`, `operator/src/keys.ts`, `src/shared/ask-routing.ts`
- Proxy today: `operator/src/use.ts` — desktop expect: `src/main/llm/operator-ask.ts`
- CF OAuth: `operator/src/cloudflare-connect.ts`
- Seat gate: `operator/src/fleet.ts` `seatAuthorizedForKeys`
- Entitlements: `src/shared/operator-entitlements.ts` (`operator_keys`)
- `docs/design/OPERATOR.md` — thin tip, OAuth LAST, generate license
- `docs/design/DESIGN.md` — Operator Keys + `/cloudflare/connect`
- `docs/design/METIS-PLATFORM-NORTH-STAR.md` §4.2–4.5 — vault + CF is a Worker
- `docs/CLOUDFLARE.md` — REST, gateway pin, no account token on the seat
- `cloudflare-proxy/` — orthogonal streaming shim
