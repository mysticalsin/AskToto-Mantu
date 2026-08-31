---
project: Métis
type: operator-control-plane-contract
owns: Cloudflare-hosted Operator console, device ingest, signed skill packs, client prompt-cache honesty
does-not-own: overlay chrome (Bar / Island / Hide), Overlay 58, leftover Intelligence PR 61, onboarding, installer packing, Fly license-server, cloudflare-proxy AI token proxy
ready-to-merge: no until Devon Mac-shows Access login as Tony, a second Claude ask with a real cache read, and a Push that the Mac applies as an overlay
audience: Tony Walteur only. Two emails. Nobody else.
tokens:
  accent: "#7C8CF8"
  accent-soft: "rgba(124,140,248,0.16)"
  glass-fill: "rgba(20,20,22,0.55)"
  glass-fill-strong: "rgba(16,16,18,0.72)"
  glass-border: "rgba(255,255,255,0.12)"
  text-primary: "rgba(255,255,255,0.95)"
  text-secondary: "rgba(255,255,255,0.55)"
  text-muted: "rgba(255,255,255,0.38)"
  ok: "#83C092"
  danger: "#F0717A"
  hair: "rgba(255,255,255,0.10)"
typography:
  ui: "Geist, -apple-system, system-ui, sans-serif"
  mono: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
  scale: { xs: 11, sm: 12, base: 13 }
radius: { sm: 8, md: 12 }
spacing: 4px-scale
---

# Operator control plane

Tony's fleet console. How people use Métis, who is live, what Asks cost, whether prompt cache is hitting, which questions should sharpen a skill, and a signed push of that skill to every Mac and Windows seat.

This is not a Settings card. It is not a local analytics page that pretends to be the fleet. The product is a Cloudflare Worker named `metis-operator` under `operator/`. The Métis client keeps prompt caching on, and talks to this Worker only when Settings has an Operator URL.

Tokens: Métis glass from [`DESIGN.md`](./DESIGN.md). One accent `#7C8CF8`. No purple gradient. No emoji as icon. No lorem. No sample numbers. Empty states when the log is empty.

Copy is original Métis. No em dashes in user-facing strings. Never identify as AI.

Windows has no notch. The hosted console is a dense 7am operations page. The in-app Settings row is a power field plus an Open Operator link that launches the Access-gated URL in the system browser.

## Who this is for

Tony only. Cloudflare Access allowlist:

- `tony.walteur@gmail.com`
- `twalteur@amaris.com`

Regular users never see a fleet dashboard. They may have an Operator URL configured by Tony. That only sends heartbeats and Ask metadata. It does not open the console.

## What this is not

| Surface | Job |
| --- | --- |
| `license-server` on Fly | License activate / heartbeat / seats. Keep it there. No prompts. |
| `cloudflare-proxy/` (`metis-cloudflare-proxy`) | AI token proxy. Do not reuse. |
| `aria-intake-llm`, `notebooklm-mcp`, `partner-mcp`, `tco-supabase-keepalive` | Existing Workers. Do not touch. |
| Overlay / Island / Hide / Bar | Frozen. Do not restyle. |
| In-app Operator page | Removed. Do not leave a fake local fleet view. |

New tree: `operator/`. New Worker name: `metis-operator`. Account already in use: `tony.walteur@gmail.com`, account id `294885a27b3cc0a1cbe5d0ccbe38de4f`.

## Security (hard)

1. **Admin UI + `/v1/admin/*`.** Cloudflare Access. Worker also verifies identity via `ctx.access.getIdentity()` and/or `Cf-Access-Jwt-Assertion` JWKS. If Access did not run, admin routes return 401. No homemade password page. No `LICENSE_ADMIN_TOKEN` for this UI.

2. **Device ingest.** `POST /v1/ingest`, `POST /v1/heartbeat`, `GET /v1/skills/manifest` are not behind Access (Electron cannot do the Access login). HMAC-SHA256: timestamp + nonce + deviceId + body hash, secret `OPERATOR_INGEST_SECRET` (Wrangler secret). Reject skew greater than 5 minutes. Rate limit per device. Replay nonce window.

3. **Prompts at rest.** AES-GCM with `OPERATOR_PROMPT_KEY` before D1. Decrypt only on an Access-authenticated admin GET. Every reveal is audit-logged (who, when, which ask id).

4. **Never ingest** Listen transcripts, screen captures, audio, or API keys. Ask text + metadata only. Client redacts secrets before send.

5. **No secrets in git, logs, or PR bodies.** Wrangler secrets only. The skill-pack public key may be committed (it is a verify key, same rule as license leases).

6. **Path split.** Access protects `/` and `/v1/admin/*`. Ingest paths stay HMAC-only. How to set that in Zero Trust is in `operator/README.md`. Do not enable "Protect this Worker" for all traffic: that would lock Electron out.

## Data

**Live seats.** last-seen under 2 minutes = online. DAU. Versions. OS (`darwin` / `win`). Hashed license seat id. App version.

**Cache.** `cacheRead` / `cacheWrite` / uncached tokens. TTFT hit vs miss. By provider and by mode. Real usage fields only. Missing = not reported. Never a fake $0.

**Cost.** Estimate from the published list-price table in `src/shared/operator.ts`. Every dollar figure is labeled "estimate, list price". Hide rather than show $0.00 when fields were not reported.

**Prompts.** Ask question text, mode, skill version, rating, outcome. Searchable. Default list is redacted. Click-to-reveal + audit.

**Change management.** Skill drafts, approvals, pushes, rollout, who (Tony email), when.

**Skills.** Cluster recent prompts per mode. Draft a unified diff against the locked `SKILL.md` (or the current approved override). Tony edits. Approves. Pushes. Push writes a signed skill pack. Clients pull and apply as overlays (`userData/skills-overrides`) with an overlay lock. Never auto-apply a draft. Humanizer stays in every mode. Recruiting stays interviewer-of-record. Interview stays candidate-side.

## Client (Métis)

Prompt caching is always on for supported cloud APIs. It is a cost and latency win for everyone.

### Cache (always)

- Anthropic: last stable system block with `cache_control: { type: 'ephemeral', ttl: '1h' }`. On 400, retry default ephemeral and record `ttl: '5m'`.
- Record `cache_read_input_tokens`, `cache_creation_input_tokens`, and `input_tokens` as the uncached remainder.
- OpenAI cloud only: `prompt_cache_key = metis:${mode}:${skillLockHash}` and an explicit breakpoint. On 400, retry once without those fields and mark the endpoint unsupported.
- Local / llama / Dust / CLI: `cache: 'n/a'`. Keep llama `cache_prompt` slot pinning.
- Prefix byte-stability: two `buildSystem` calls in one session with different transcripts must produce identical cached-prefix bytes.

### Operator URL (off until configured)

Settings → Privacy → Advanced:

- Operator URL (https). Empty by default.
- Send Ask text for skill improvement (default ON once a URL is set). Off sends metrics only.
- Open Operator: system browser to the Access-gated URL.

When a URL is set:

- Heartbeat about every 60s while the app is up.
- After each Ask: metrics always; prompt text only if the toggle is on.
- Poll skill manifest on launch and every 6 hours. Verify ed25519 with the embedded operator public key. Apply overlay only if signature and hash match.

`METIS_OPERATOR_URL` env may prefill the URL. Do not leave a local-only analytics page.

## Worker UI

Dense operations console. First paint:

- Live count (last-seen < 2 min)
- Cost today (estimate, list price)
- Cache hit rate (real fields only)
- Pending skill diffs

Then: seats, asks (redacted), skill queue (pending / approved / pushed), change log.

Empty: "No Asks on the fleet yet." Never invent a chart.

## Ready to merge

**READY TO MERGE: no** until Devon Mac-shows Access as Tony, a second Claude ask with a cache read, Draft / Approve / Push, and the Mac overlay version bump.

Do not wrangler deploy from CI with secrets. Overlay chrome stays frozen. Do not merge.
