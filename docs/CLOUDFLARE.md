# Cloudflare as a Métis provider

Cloudflare is the one provider Métis reaches through infrastructure **you** deploy rather than by
calling a vendor directly. This document explains why, what an operator has to stand up, and what a user
then types into Settings.

The deploy runbook itself — commands, secrets, rotation, revocation — is
[`cloudflare-proxy/README.md`](../cloudflare-proxy/README.md). This is the picture that runbook sits
inside.

Portal-hosted keys (licensed seat → `metis-operator` vault → Workers AI / AI Gateway, no seat-local
key) are a different plane: [`docs/design/METIS-CF-LLM-GATEWAY.md`](design/METIS-CF-LLM-GATEWAY.md).
Do not merge that Worker with this proxy.

---

## The rule: Métis does not ship a Cloudflare token

Métis is a packaged Electron app. `npx asar extract` recovers every string inside it in about two
seconds. There is no build flag, no obfuscation and no keychain trick that changes that — anything
compiled into the app is published with the app.

This repo already treats that as settled: `scripts/check-cahe-package.mjs` refuses to build a package
carrying an embedded key unless a human sets an explicit override, and it exists because the alternative
was tried and rejected.

A Cloudflare account token is a worse thing to embed than an ordinary model key. It is not scoped to one
model vendor: through the AI REST API it reaches Workers AI *and* OpenAI, Anthropic, Google AI Studio
and the rest, all billed to one account under Unified Billing. One extracted token is one open tab on
the operator's balance.

So the token does not travel. It sits in a Cloudflare Worker the operator deploys, as a Wrangler secret,
and Métis authenticates to that Worker with a different credential that is worthless anywhere else.

```
┌──────────────┐                          ┌───────────────────────┐                     ┌──────────────────┐
│    Métis     │  POST /v1/chat/          │  metis-cloudflare-    │  POST .../ai/v1/    │  api.cloudflare  │
│  (desktop)   │ ───completions──────────▶│  proxy   (Worker)     │ ───chat/completions▶│  .com            │
│              │  Bearer METIS_PROXY_KEY  │                       │  Bearer CLOUDFLARE_ │                  │
│              │ ◀────SSE stream──────────│  holds both secrets   │ ◀───API_TOKEN───────│  → Workers AI    │
└──────────────┘                          └───────────────────────┘                     │  → OpenAI        │
                                                                                        │  → Anthropic     │
  knows: the Worker URL + the proxy key      knows: the account token                    │  → Google AI …   │
  never sees: the account token              never returns it, in any response           └──────────────────┘
```

The two credentials are independent, which is the property that makes this worth the extra moving part:

- A leaked **proxy key** is revoked with one `wrangler secret put`, immediately, without touching the
  Cloudflare account or any other Métis provider.
- A rotated **account token** requires no change on any user's machine, because no machine ever had it.

---

## What the operator stands up

Four steps, in full in [`cloudflare-proxy/README.md`](../cloudflare-proxy/README.md):

1. Create a Cloudflare API token scoped to one account, permitted to run AI models and nothing else.
2. `wrangler secret put` three values into the Worker: `CLOUDFLARE_API_TOKEN`, `CF_ACCOUNT_ID`, and a
   `METIS_PROXY_KEY` you generate (`openssl rand -base64 32`).
3. `wrangler deploy`. Note the `https://metis-cloudflare-proxy.<subdomain>.workers.dev` URL it prints.
4. Verify: `GET /health` must answer `"configured": true`, a streaming `curl` must return tokens
   progressively, and an unauthenticated `POST` must return `401`.

Then hand the users two strings: the Worker URL and the proxy key. Nothing else.

---

## What a user enters in Settings

Two fields, both supplied by the operator:

| What | Value | Notes |
| --- | --- | --- |
| The proxy's base URL | `https://metis-cloudflare-proxy.<subdomain>.workers.dev/v1` | An OpenAI-compatible base — Métis appends `/chat/completions` to it, so the `/v1` suffix is required. |
| The API key | The `METIS_PROXY_KEY` value | Sent as `Authorization: Bearer …`. Not a Cloudflare credential and not usable at Cloudflare. |

There is no account id and no Cloudflare token to enter. If a user is ever asked for one, something is
misconfigured — that is the failure mode this whole design exists to make impossible.

Model ids are typed the same way as for any other provider, in Cloudflare's format below.

---

## On by default: an installer-embedded Cloudflare credential, so a fresh install needs zero setup

Cloudflare is the DEFAULT provider (`BaseSettingsSchema.provider`). By default the release builds now also
embed a Cloudflare credential (encrypted at rest), so a brand-new install answers with **nothing to paste**:
on a fresh profile `provider` is `cloudflare`, a key is seeded into the encrypted keystore, an https
endpoint is set, and `providerReady` is true with no "Add your Cloudflare key" prompt.

The embedded credential comes in **two shapes**, both encrypted into the same blob
(`src/main/embedded-cloudflare-key.ts`), built only from build-time env — only ciphertext ships, and
**nothing about the account (id, endpoint or token) is in tracked source**:

1. **Worker proxy key** (the original, token-never-ships design above). The blob's plaintext is a bare
   `METIS_PROXY_KEY`; the app still points `cloudflareBaseUrl` at the operator's Worker. Set
   `METIS_CLOUDFLARE_API_TOKEN` (or the legacy `METIS_PROXY_KEY`) at build time, with no account id.

2. **Direct Cloudflare account credential** (the product owner's on-by-default configuration). The blob's
   plaintext is a JSON `{token,baseUrl}`: `token` is a Cloudflare **account API token** sent as
   `Authorization: Bearer …`, and `baseUrl` is the account-scoped OpenAI-compatible REST endpoint
   `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`. Métis then talks to Cloudflare **directly**,
   with no Worker in the path. Set `METIS_CLOUDFLARE_API_TOKEN` **and** `METIS_CLOUDFLARE_ACCOUNT_ID` at
   build time (or `METIS_CLOUDFLARE_BASE_URL` for a full endpoint override). On first run the runtime seeds
   both the key and — guarded so it never clobbers an operator/user endpoint (`=== METIS_WORKER_URL`) — the
   account endpoint into settings.

   The honest trade-off is the same as any embedded credential: an account token that ships is
   **obfuscation, not secrecy** (see below), and an account token is broader than a proxy key. The product
   owner accepts this deliberately and rotates the token out-of-band; size/scope the token accordingly and
   be ready to rotate it. The truly-secure alternative remains shape (1)/the Worker proxy.

Either shape is the same disclosed, opt-in mechanism the Cahê pilot uses for its Kimi key
(`src/main/cahe-embedded-key.ts`) — `src/main/embedded-cloudflare-key.ts` is the general-build counterpart:

1. Generate a **separate** key — never the operator's own `METIS_PROXY_KEY` — and add it to the Worker's
   `METIS_PROXY_KEYS` array under its own label, e.g. `"embedded-default:<value>"`
   (`cloudflare-proxy/src/index.ts`'s multi-key union). A labeled key is revoked independently, by
   removing just that entry, without touching any other user's key. Size it as a minimum-quota fallback
   on the Worker side, not a shared admin credential.
2. Supply the credential as build environment variables (build **Secrets** in CI, or exported shell vars
   locally). All are read **only** from the environment — never a hardcoded value, never a committed file:
   - `METIS_CLOUDFLARE_API_TOKEN` (or legacy `METIS_PROXY_KEY`) — the token to embed.
   - For the **direct account** shape, also `METIS_CLOUDFLARE_ACCOUNT_ID` (the endpoint is derived as
     `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`), or `METIS_CLOUDFLARE_BASE_URL` to set a
     full endpoint explicitly. Omit both for the bare Worker-proxy-key shape.
   The predist/prebuild step `scripts/embed-cloudflare-key.mjs` then AES-256-GCM-encrypts the payload into
   `build/cloudflare-embed/key.json` (gitignored). Only the **ciphertext** blob is written to disk; the
   plaintext token is not. If no token env var is set, the step is a clean no-op (the normal keyless build).
3. Build with `METIS_EMBED_CLOUDFLARE_KEY=1` set as well. `.github/workflows/release.yml` already sets this
   for the mac/win release jobs, so with the account secrets configured in the repo the DMG/EXE embed the
   credential **by default**; locally you set it explicitly, e.g.
   `METIS_CLOUDFLARE_API_TOKEN=… METIS_CLOUDFLARE_ACCOUNT_ID=… METIS_EMBED_CLOUDFLARE_KEY=1 npm run dist`
   (or `release:build:mac`, `dist:win`, `release:build:win`, or the Cahê chain). This is a deliberate
   **double opt-in**: the token env supplies the credential, and `METIS_EMBED_CLOUDFLARE_KEY=1` authorizes
   packaging it. Without the second var, `scripts/check-embedded-cloudflare-key.mjs` refuses the package
   outright rather than silently shipping a key nobody meant to embed. That same gate proves the packaged
   blob is ciphertext (never a plaintext `proxyKey` field) and that the decrypted token appears **nowhere**
   in the packaged app.

### The encryption, and its honest limits

The blob is AES-256-GCM ciphertext. The key is derived (scrypt) from build-stable material — the appId plus
an obfuscation secret that lives in `src/main/embedded-key-material.json` and therefore **ships inside the
app**. That last fact is the whole caveat: because the decryption material travels with the binary, a
determined attacker can re-derive the key and decrypt the blob. **This is obfuscation, not secrecy.** It
raises the bar meaningfully over the old plaintext file — `npx asar extract` no longer hands you the token
in two seconds, and a casual `strings` sweep finds nothing usable — but it does not make the token
unextractable, and nothing compiled into a shipped client can. Do not describe it as "cannot be reverse
engineered".

The truly-secure option, where the token never ships at all, is the Worker proxy this document is about:
users paste their own `METIS_PROXY_KEY`, and no key is embedded. The embedded key is a **convenience for a
controlled audience** — which is exactly why what keeps it safe is its SCOPE (a revocable, rate-limited,
minimum-quota `embedded-default` label), never this encryption and never the operator's real key.

On first launch, `importEmbeddedCloudflareKey()` reads the blob, decrypts it **in memory**, and seeds the
plaintext into the app's own encrypted keystore (the same AES file keystore a pasted key goes through)
exactly once per profile. The decrypted value is never written to disk or logs as plaintext; only the
keystore's own ciphertext lands on disk. It never overwrites a key the user already has — their own paste
(or an earlier seed) always wins, permanently, even across later updates.

To rotate a leaked installer key without expanding its scope: `npm run rotate:embedded-keys`
(see `docs/security/EMBEDDED-KEY-ROTATION.md`). That command never writes an account token.

---

## Model ids: `{provider}/{model}`

Cloudflare's AI REST API is OpenAI-compatible. There are **two** id forms, and they are not
interchangeable. Everything below was run against a live account before being written down.

| `model` value | Runs on | Works out of the box |
| --- | --- | --- |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Cloudflare's own Workers AI | Yes — this is the default |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI | Yes — the think tier (first visible token ~0.4s; the reasoning model that used to sit here spent 3.6-14.2s on hidden reasoning first, MQA-229) |
| `@cf/openai/gpt-oss-120b` | Workers AI (returns a `reasoning` field) | Yes — the deep tier (coding/math; slow to first visible token by design) |
| `openai/gpt-5.5` | OpenAI, billed through Cloudflare | Only with a funded gateway |

- **Workers AI ids are bare `@cf/…`.** A `workers-ai/` prefix is rejected outright: `AiError: No such
  model`. Métis shipped that prefix once and every ask 404'd, which is MQA-226 — the mock gateway could
  not catch it because a mock echoes whatever model it is handed.
- **The `{provider}/{model}` form is only for the third-party labs.** It is real, but it bills through
  Unified Billing: with no credit, `openai/gpt-5.5` answers `Insufficient balance; add money to your
  gateway or use BYOK`. That is why no default points at one. `anthropic/…` and `google-ai-studio/…`
  ids were listed here previously and are not valid at this endpoint at all.
- **The Workers Free plan refuses some catalogue models** with `is not available on the Workers Free
  plan`. Check `GET /accounts/{id}/ai/models/search` for what your own account actually serves.

## Screen-asks do not go to Cloudflare

`PROVIDERS.cloudflare.vision` is **false**, and not because of the model — Llama 4 Scout is genuinely
multimodal. This endpoint has no way to carry the image: every `image_url` shape is rejected with
`Property image_url only supports base64 encoded image data` (code 6004), both a `data:image/jpeg;base64,…`
URL and bare base64, on Scout and on the dedicated `llama-3.2-11b-vision-instruct` alike. It is a
transport limit, not a model one (MQA-227). Screen-asks therefore route to the on-device model, which
works. Re-test against a live endpoint before ever flipping that flag back.

## What AI Gateway adds, whether you ask for it or not

Requests through the REST API route through the account's **default AI Gateway**, so its logging,
caching, rate limiting and guardrails apply automatically. The operator can pin a specific gateway
instead — with, for example, a request-per-minute cap sized to the team — by setting `CF_AI_GATEWAY_ID`
in `cloudflare-proxy/wrangler.jsonc` and redeploying. The Worker then sends `cf-aig-gateway-id` on every
upstream call.

The Worker deliberately ignores a `cf-aig-gateway-id` supplied by a *caller*. If it honoured one, any
client could route around the rate-limited gateway the operator deployed it behind, and the rate limit
would be decoration.

**Privacy, said plainly:** prompts and completions traverse the operator's Cloudflare account, and if
that account's gateway has logging enabled, they are stored there. Métis reads screens and meetings, so
this is a real disclosure, not boilerplate — the operator should decide the gateway's log retention
before rolling this provider out to a team, the same way they would for any other vendor.

## Why the REST API and not `gateway.ai.cloudflare.com`

Cloudflare also exposes a legacy compatibility endpoint at
`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions`. It is
deprecated for single-model calls, and it bakes the gateway id into the URL — the thing we specifically
want under operator control and changeable without touching any client. Métis uses the REST API:

```
POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions
```

## Streaming

`"stream": true` works end to end. The Worker hands Cloudflare's response body straight to the client
without reading it, so SSE frames arrive as they are produced and Métis renders answers token by token.
This is a load-bearing property, not an optimisation: buffering the completion in the Worker would turn
every reply into a long pause followed by a wall of text, and it is pinned by a test
(`cloudflare-proxy/src/index.test.ts`) that reads a frame off the response while the upstream stream is
still open.

## When something is wrong

The Worker never relays a Cloudflare error body — one can quote the request it rejected, headers
included, which would be a path for the account token to escape. Every failure is re-stated with a
status chosen for what the reader can act on:

| Status Métis sees | Means | Fix |
| --- | --- | --- |
| `401 Invalid proxy key` | The `METIS_PROXY_KEY` in Settings does not match the Worker's. | Re-paste it. If it was recently rotated, the operator has a newer value. |
| `502 … check CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID` | Cloudflare rejected the **operator's** token — wrong, expired or under-scoped. Nothing is wrong with the user's key. | Operator: re-check the token's scope, then `wrangler secret put CLOUDFLARE_API_TOKEN`. |
| `503 This proxy is not configured` | The Worker is deployed but one or more secrets were never set. | Operator: `wrangler secret list`, then set the missing ones. `GET /health` will flip to `"configured": true`. |
| `429` | Rate limited, by AI Gateway or upstream. Passed through unchanged so Métis backs off and fails over. | Raise the gateway limit, or leave it — the failover is working as intended. |
| `402` / `404` / `400` | Out of credit / unknown model id / malformed request. Passed through unchanged. | Check the balance, or the `{provider}/{model}` spelling above. |
| `502 Could not reach Cloudflare AI` | The Worker could not connect upstream. | Transient; check the Cloudflare status page if it persists. |
| `404 Not found. This proxy serves …` | The base URL in Settings is wrong — most often missing the `/v1`. | Append `/v1` to the Worker URL. |

## Rotation and revocation

Both are one command and are covered step by step in
[`cloudflare-proxy/README.md`](../cloudflare-proxy/README.md):

- **Rotating the Cloudflare token** changes nothing on any user's machine. Create the new token, put it,
  verify, *then* delete the old one.
- **Revoking a leaked proxy key** takes effect the moment the new version deploys. Every install using
  the old key gets `401` until Settings is updated, which is the correct behaviour for a bearer
  credential to a paid endpoint.
