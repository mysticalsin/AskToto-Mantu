# AskToto — Network Security Report (Gate 6, Network)

**Scope reality.** Desktop app. Network posture is **outbound-only** plus **one transient loopback
listener**. There is no inbound service, no exposed port, no public endpoint, no API gateway, no
firewall/WAF to configure. This report enumerates exactly what the app talks to, over what transport,
and the single listener it opens.

---

## 1. Inbound surface — only a transient loopback OAuth server — PASS

The **only** server the app ever opens is the OAuth redirect catcher during Azure sign-in.

| Property | Value | Evidence | Assessment |
|----------|-------|----------|------------|
| Bind address | `127.0.0.1` (loopback) | `auth.ts:194` `server.listen(0, '127.0.0.1', …)` | PASS — not `0.0.0.0`; never reachable off-host. |
| Port | `0` → random ephemeral | `auth.ts:194-197` | PASS — no fixed port to squat/scan. |
| Lifetime | closed on first request, or 300 s timeout | `auth.ts:184-193` (`server.close()` in handler; `setTimeout … 300000`) | PASS — short-lived, not a standing listener. |
| Scope | only created inside `signIn()` when Azure SSO is configured | `auth.ts:157-213` | PASS — never opened in the default/unconfigured path. |
| Response | static HTML, reflects no user input | `auth.ts:180-183` (ternary on presence of `code`, no echo) | PASS — no reflected XSS. |
| Transport | plain `http://localhost:<port>` | `auth.ts:197` | OK — loopback OAuth redirect; TLS unnecessary and not used by the system OAuth loopback pattern (RFC 8252). |

`grep -rn "createServer|\.listen(|net\.Server" src/` returns **only** `auth.ts`. No other inbound
socket exists anywhere in the codebase. Verified.

**Minor hardening gap (LOW):** the auth code request (`pca.getAuthCodeUrl`, `auth.ts:199-205`) sets
PKCE (`S256`) and `prompt:'select_account'` but **no `state` parameter**, and the loopback server
returns 200 to any GET on that ephemeral port while open. Because the server is loopback-only, lives
only seconds, and the token exchange independently validates PKCE + tenant + domain (`auth.ts:215-232`),
exploitability is very low — but adding a `state` nonce and rejecting requests that lack the expected
`state` would close the residual CSRF/confused-deputy window. See Finding NET-3.

---

## 2. Outbound destinations (the real network surface)

All egress is initiated by vendor SDKs over **HTTPS**. There is no plain-HTTP egress and no custom
socket code. Hosts:

| Destination | Purpose | Initiated in | Transport |
|-------------|---------|--------------|-----------|
| `api.anthropic.com` | Claude chat/vision | `llm.ts:191-198` (`@anthropic-ai/sdk`, default baseURL) | HTTPS (SDK) |
| `api.openai.com/v1` + 10 OpenAI-compatible hosts (moonshot, nvidia, deepseek, dashscope, minimax, openrouter, groq, together, fireworks, mistral) | GPT / OSS model chat | `llm.ts:221-240` (`openai` SDK, `baseURL` from `providers.ts:37-243`) | HTTPS (SDK) |
| `dust.tt` / `eu.dust.tt` / `*.dust.tt` | Dust agent conversations | `llm.ts:126-131`, `store.ts:226-231` (`@dust-tt/client`) | HTTPS (SDK) |
| `login.microsoftonline.com/<tenantId>` | Azure AD SSO | `auth.ts:167` (`@azure/msal-node`) | HTTPS (MSAL) |
| `huggingface.co`, `cdn.jsdelivr.net`, `*.hf.co` | Whisper ONNX model download (first Listen) | `whisper.worker.ts:2-19` (`@huggingface/transformers`, `Xenova/whisper-tiny`) | HTTPS (fetch) |
| Custom provider base URL (user-set, any HTTPS) | "Custom · OpenAI-compatible" | `llm.ts:221`, `index.ts:532-533` | HTTPS (SDK) |
| Update host (placeholder today) | electron-updater | `updater.ts`, `electron-builder.yml` `publish` | HTTPS |
| Dust CLI keychain read (`security` tool) | local IPC only, **no network** | `dustcli.ts:29-45` | N/A (local process) |
| `graphify` python runner + local `claude` CLI | local subprocess; may itself call out via the user's own creds | `graphify.ts:205-215` | out-of-app |

**Provider API keys travel only on these HTTPS calls and never reach the renderer** — the renderer sees
only `hasKeys` booleans (`store.ts:312-316`, `index.ts:118-126`). Keys are read in the main process and
handed straight to the SDK (`index.ts:496`, `llm.ts`).

---

## 3. Renderer egress control — Content-Security-Policy — PASS (with one architectural caveat)

The renderer is constrained by a `<meta http-equiv="Content-Security-Policy">` (`index.html:7-10`):

```
default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'none'; frame-src 'none';
img-src 'self' data: blob:; media-src 'self' blob: data:;
connect-src 'self' blob: <the 13 provider hosts> https://dust.tt https://*.dust.tt
            https://huggingface.co https://cdn.jsdelivr.net https://*.hf.co;
script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline';
font-src 'self' data:; worker-src 'self' blob:;
```

| Aspect | Assessment |
|--------|------------|
| `connect-src` is an explicit host allowlist (no wildcard `https:`) | PASS — a compromised/injected renderer can only exfiltrate to the enumerated provider hosts, not anywhere. The comment notes arbitrary-HTTPS custom providers intentionally require a custom build. |
| `object-src 'none'`, `frame-src 'none'`, `form-action 'none'`, `base-uri 'self'` | PASS — no plugins, no iframes, no form posting, no base-tag hijack. |
| `script-src 'self' 'wasm-unsafe-eval' blob:` (no `'unsafe-eval'`, no inline) | PASS — `wasm-unsafe-eval` + `blob:` are required by transformers.js WASM workers; inline scripts blocked. |
| `style-src 'unsafe-inline'` | LOW — inline styles allowed (Tailwind/inline). Style-only injection risk; acceptable. |

**Architectural caveat (informational, not a vuln):** the actual LLM provider calls run in the **main
process** (`llm.ts`), which is **not subject to the renderer CSP**. So the CSP is *defense-in-depth for
the renderer* (and the only constraint on the in-renderer Whisper model fetch), but it does **not**
bound main-process egress — e.g. a user-configured "custom" provider base URL is honored at the main
layer regardless of CSP. This is by design and gated by `assertMainWindow` + the settings trust path,
but reviewers should not read the CSP as the egress firewall for model traffic.

---

## 4. Whisper model download — no integrity verification — MEDIUM

On first Listen the renderer pulls `Xenova/whisper-tiny` (q8 ONNX) from the HF hub /
`cdn.jsdelivr.net` via `@huggingface/transformers` (`whisper.worker.ts:19`, `env.allowLocalModels=false`
`whisper.worker.ts:5`). Transport is HTTPS, but there is **no Subresource Integrity / hash pinning** on
the downloaded model weights, and `cdn.jsdelivr.net` is a third-party CDN. A CDN compromise or TLS-MITM
(corp proxy with a trusted root) could serve a tampered model. Impact is bounded — the model only
transcribes audio to text and runs in the sandboxed renderer (no Node) — but it is an unverified remote
code/weights fetch. Known gap. Finding NET-2.

---

## 5. Firewall / WAF / DDoS / network segmentation — N/A (justified)

| Domain | Status | Why |
|--------|--------|-----|
| Firewall / security groups | N/A | No inbound service; loopback OAuth is host-local. Host OS firewall governs outbound. |
| WAF / API gateway / rate limiting | N/A | No server endpoints to protect. |
| DDoS protection | N/A | Nothing public to attack. |
| Network segmentation / VPC / private link | N/A | No cloud network. |
| mTLS / service mesh | N/A | No internal services. |
| Egress proxy allow-listing | Partially DIY via CSP `connect-src` for the renderer; org egress proxy would govern SDK traffic | Enterprises can additionally allow-list the §2 hosts at their proxy. |

---

## Findings (Network)

- **NET-1 (MEDIUM) — Outbound egress not centrally enforceable.** Main-process SDK traffic bypasses the
  renderer CSP; a user-set "custom" provider can send prompts/transcripts to any HTTPS host. *Fix:*
  optionally honor a managed-config egress allowlist in the main process, or document that orgs should
  allow-list the §2 hosts at their network proxy and lock `provider`/`customBaseUrl` via managed-config
  (`locked` array already supported, `store.ts:94-98`).
- **NET-2 (MEDIUM) — Whisper model fetched without integrity pinning.** HTTPS but no SRI/hash on weights
  from `huggingface.co`/`cdn.jsdelivr.net`. *Fix:* pin a model revision + verify a known SHA-256, or
  bundle the ~30 MB `whisper-tiny` weights in `extraResources` and set `allowLocalModels=true`.
- **NET-3 (LOW) — OAuth loopback lacks a `state` nonce.** PKCE present; loopback + short TTL limit risk,
  but no CSRF `state` is issued/validated and the server answers any GET while open (`auth.ts:176-205`).
  *Fix:* add a random `state`, pass it to `getAuthCodeUrl`, and reject callbacks whose `state` mismatches.

## Gate verdict — Network
**Inbound surface: PASS** (loopback-only, random port, transient). **Outbound: PASS on transport**
(all HTTPS via vendor SDKs) with **MEDIUM** gaps on egress enforceability (NET-1) and model integrity
(NET-2). Firewall/WAF/segmentation: N/A (justified). Network gate = **PASS with required mediums**
(NET-1/NET-2 should be closed before a sensitive-data production deployment).
