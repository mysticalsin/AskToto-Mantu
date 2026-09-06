---
project: Métis
type: operator-control-plane-contract
owns: Cloudflare-hosted Operator console, license generate, seat approval, keys vault, Cloudflare AI Gateway OAuth connect
does-not-own: overlay chrome, installer pack, Fly license-server, Metis-Releases Latest, Goldberg Aria
ready-to-merge: no
this-slice: thin-operator-license-generate
audience: Tony Walteur only. Two emails. Nobody else.
tokens:
  accent: "#2563EB"
  live: "#10B981"
  ok: "#16A34A"
  danger: "#DC2626"
  bg: "#0a0a0b"
  panel: "#111113"
---

# Operator — thin license-generate tip

Live URL: `https://metis-operator.tony-walteur.workers.dev/` (`#overview`).
Access: Cloudflare Access email-code only. Allowlist `tony.walteur@gmail.com` +
`twalteur@amaris.com`. Never a homemade password form.

**Hold merge.** Draft only. No pack. No Latest. Ultron green-lit Operator-only
deploy to `metis-operator` (`tony-walteur.workers.dev`). Do not merge fat PR151.

**ULTRON LOCK.** Do **not** publish or promote any Metis-Releases Latest feed.
EXE / DMG / Native → Latest only after Bob QA **and** Ultron approve.

Visual contract lives in [DESIGN.md](DESIGN.md) § Operator — Shoey
OpenPanel bar, Métis seats. Implement that page map (dictionary + every
rail section) before inventing chrome.

## Generate license (P0)

| Step | Where | What |
| --- | --- | --- |
| 1 | Operator `#overview` or `#licenses` | Pick duration: 1 / 7 / 30 / 90 days / 1 year |
| 2 | `POST /v1/admin/licenses/generate` `{ days }` | Access JWT. Unauth **401** `{ ok:false, error:"Access required" }` |
| 3 | Once-string | `METIS-OP-1.<jti>.<iat>.<exp>.<hmac-sha256-b64url>` HMAC over canonical with `OPERATOR_INGEST_SECRET`. Shown once. last4 after reload. Never in Events. |
| 4 | Métis Identity | Activate the string. Seat heartbeat `{ license: "licensed", licenseId }` (jti). |
| 5 | Worker | `seatAuthorizedForKeys` = Tony Approve **or** active issued jti. Revoke wins. Vault keys via HMAC `/v1/use`. |

Selling ATK- / Fly JWS stays closed. `LICENSE_ACTIVATION_OPEN` stays false.

## Cloudflare · AI Gateway (kept, not blocking)

`#keys` → **Log in to Cloudflare** → GET `/cloudflare/connect` (OAuth) → callback
writes vault `cloudflare` + `cloudflare-account` (last4 only). Paste is not the
happy path. License generate must work if CF OAuth secrets are missing.

## Security (unchanged)

- Unauth console GET **302** Access. Unauth `/v1/admin/*` **401** JSON.
- Ingest stays HMAC. Do not "Protect this Worker" for all traffic.
- Vault last4 only. No secrets in HTML/JSON.
- Filter `usage-*` / `usage-import` from fleet.

## Overview glance (P0)

`#overview` reads at a glance: **Live seats · Time saved · Value**. Places
is a **corner** map + Cities / Regions / Countries (Shoey columns).
`#realtime` is WorldMap + LiveFeed + GeoTable. `GET /v1/admin/realtime.geo.json`
is city-level `{ country, city, count, unique_sessions, avg_duration }`.
Activity is Métis heartbeats / asks / recaps, never pageviews. People lists
last-seen seats with city when the 2-min live window is empty. Generate
stays on the page.
