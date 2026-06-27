# AskToto — TLS & Security Headers Report (Gate 6)

**Scope reality.** There is **no web server**, so the classic checklist — TLS termination, cert/cipher
config, HSTS, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, cookie flags — has **no
server to apply to** and is **N/A (justified)** item by item. What *does* apply: (1) **outbound TLS** to
provider/SSO/CDN hosts (handled by the vendor SDKs / Node + system trust store), (2) the **renderer
Content-Security-Policy**, and (3) the **one HTML surface the app serves itself** — the loopback OAuth
callback page in `auth.ts`.

---

## 1. Server TLS & HTTP security headers — N/A (justified, per item)

| Control | Status | Justification |
|---------|--------|---------------|
| TLS termination / cert / cipher suite / TLS version | N/A | No inbound HTTPS server. The only listener is the loopback OAuth catcher on `http://127.0.0.1:<random>` (`auth.ts:194-197`) — loopback, no TLS by design (RFC 8252). |
| HSTS (`Strict-Transport-Security`) | N/A | No server responses to clients; nothing to upgrade-pin. |
| `X-Frame-Options` / `frame-ancestors` | N/A → covered differently | App isn't framed; framing is blocked at the window layer (`will-navigate`/`setWindowOpenHandler`, `index.ts:176-182`) and renderer `frame-src 'none'`. |
| `X-Content-Type-Options: nosniff` | N/A | No server serving downloadable content to browsers. |
| `Referrer-Policy` / `Permissions-Policy` (as HTTP headers) | N/A | No HTTP responses; renderer loads from `file://`/dev server. |
| Cookie `Secure`/`HttpOnly`/`SameSite` | N/A | App sets no cookies; session is an encrypted local file (`auth.ts:122-131`). |
| Certificate pinning (outbound) | Not implemented | Acceptable for a desktop app behind corporate MITM proxies; pinning would break enterprise TLS inspection. See §2. |

---

## 2. Outbound TLS — PASS (delegated to SDKs + system trust store)

Every external call is HTTPS, made by a maintained vendor SDK using Node's TLS and the **OS trust
store**:

| Client | Host(s) | TLS owner | Evidence |
|--------|---------|-----------|----------|
| `@anthropic-ai/sdk` | `api.anthropic.com` | SDK (HTTPS) | `llm.ts:191` |
| `openai` SDK | `api.openai.com` + 10 compatible hosts | SDK (HTTPS) | `llm.ts:221`, `providers.ts:37-243` |
| `@dust-tt/client` | `dust.tt`/`eu.dust.tt` | SDK (HTTPS) | `llm.ts:128-131` |
| `@azure/msal-node` | `login.microsoftonline.com` | MSAL (HTTPS) | `auth.ts:163-167` |
| `@huggingface/transformers` | `huggingface.co`/`cdn.jsdelivr.net` | fetch (HTTPS) | `whisper.worker.ts:2-19` |
| `electron-updater` | update host (placeholder) | HTTPS | `updater.ts`, `electron-builder.yml` |

- **No plain-HTTP egress** and **no `NODE_TLS_REJECT_UNAUTHORIZED=0`** / `rejectUnauthorized:false`
  anywhere in `src/` (verified by grep — no hits). Default TLS verification is in force.
- Base URLs for built-in providers are **hardcoded `https://…`** (`providers.ts`); the only
  user-supplied URL is the "custom" provider, validated to start with `https://` before settings accept
  it (`store.ts:152`, schema invariant). So a downgrade to `http://` for a custom endpoint is rejected.
- **No certificate pinning** (informational): outbound trust relies on the system CA store, which means
  a corporate TLS-inspection proxy (or a machine with a malicious root) can MITM model traffic. This is
  the standard desktop trade-off; flag only if a zero-trust-egress requirement exists.

---

## 3. Renderer Content-Security-Policy — PASS (the de-facto "security headers" of this app)

Because the only rendered surface is the local React app, the CSP **`<meta http-equiv>`** in
`index.html:7-10` is what stands in for HTTP security headers. Full text and per-directive assessment
are in **NETWORK_SECURITY_REPORT.md §3**. Summary:

| Directive | Value | Verdict |
|-----------|-------|---------|
| `default-src` | `'self'` | PASS |
| `object-src` / `frame-src` / `form-action` | `'none'` | PASS — no plugins/iframes/form posts |
| `base-uri` | `'self'` | PASS — no base-tag hijack |
| `connect-src` | explicit host allowlist (13 provider hosts + Dust + HF/jsdelivr), **no wildcard `https:`** | PASS |
| `script-src` | `'self' 'wasm-unsafe-eval' blob:` (no `'unsafe-eval'`, no inline) | PASS (wasm needed for transformers.js) |
| `style-src` | `'self' 'unsafe-inline'` | LOW — inline styles permitted |
| `worker-src` | `'self' blob:` | PASS (Whisper worker) |

Caveat (repeated for the release manager): CSP is delivered via `<meta>`, not an HTTP header (no
server), and it constrains the **renderer only** — main-process SDK egress is outside CSP (see
NETWORK_SECURITY_REPORT.md §3 caveat). For a `file://`-loaded packaged app, meta-CSP is the correct and
effective mechanism; directives that require an HTTP header (`frame-ancestors`, top-level `sandbox`) are
N/A and are instead enforced at the Electron window layer.

---

## 4. The one self-served HTML page — OAuth callback — PASS

`auth.ts:180-183` writes a small static HTML page back to the browser on the loopback redirect:

```
res.writeHead(200, { 'Content-Type': 'text/html' })
res.end(`<html>…<p>${c ? 'Signed in — you can close this window.' : 'Sign-in failed.'}</p>…`)
```

| Aspect | Assessment |
|--------|------------|
| Reflected input | **None** — the only interpolation is a fixed string chosen by a boolean (`c ?`), not the request value. No XSS. |
| Content-Type set explicitly | PASS — `text/html`, no sniffing ambiguity. |
| Transport | `http://localhost` loopback — TLS N/A (host-local, transient). |
| Headers | none beyond `Content-Type`; acceptable for a one-shot loopback page that closes immediately (`server.close()` `auth.ts:185`). |
| Lifetime | page served once, server closed; not a standing web surface. |

No security-header hardening is warranted here — it is not a network-exposed page. (The residual
`state`-nonce hardening is tracked as NET-3 in the network report, not a TLS/headers issue.)

---

## Findings (TLS & Headers)

- **TLS-1 (LOW) — `style-src 'unsafe-inline'` in renderer CSP.** Permits inline styles
  (`index.html:9`); style-injection risk only. *Fix:* migrate to nonce/hashed styles if Tailwind/build
  allows; low priority.
- **TLS-2 (LOW / informational) — No outbound certificate pinning.** Model/provider TLS trusts the
  system CA store, so corp/malicious-root MITM is possible. *Fix:* only if a zero-trust egress mandate
  exists — pin provider/SSO certs (note this breaks TLS-inspection proxies). Otherwise accept.
- No server-side TLS/header findings — **N/A by architecture** (no server).

## Gate verdict — TLS & Headers
**Server TLS / HTTP security headers: N/A (justified, no server).** **Outbound TLS: PASS** (HTTPS via
maintained SDKs, default verification on, no http downgrade, https-only custom URLs). **Renderer CSP:
PASS** (strong allowlist; one LOW `unsafe-inline` style). **Self-served loopback page: PASS** (no
reflected input). TLS/headers gate = **PASS**, with two LOW hardening items.
