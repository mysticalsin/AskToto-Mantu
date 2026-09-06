---
project: Métis
type: operator-slice-contract
slice: licenses-roi
owns:
  - Operator Licenses table (real D1 seats)
  - Operator ROI strip (real Asks + cost estimates)
does-not-own:
  - Fly license-server activate / heartbeat
  - overlay chrome
  - Goldberg Aria
  - homemade login
  - demo seats
notes: DESIGN before UI. Access-only. Fail loud. Never invent seats or dollars.
ready-to-merge: no
---

# Operator licenses and ROI

Tony-only console at `https://metis-operator.tony-walteur.workers.dev/`. Cloudflare Access is the door. No homemade password page. Two emails, nobody else.

This slice makes two existing Operator surfaces honest and complete:

1. **Licenses / devices.** Every seat that has checked in via HMAC ingest. One row per `device_id` from D1 `seats`. OS, app version, last seen, country. No license keys, no secrets.
2. **ROI.** Asks in the last 7 days, live seats, and list-price cost estimates already derived from reported token fields. Missing usage stays "not reported", never `$0`.

Fly `license-server` still owns activate and member seats. Operator does not mint keys and has no Generate License API. Mint from `license-server` `POST /admin/licenses` or the admin UI at `/admin/ui` (local `http://127.0.0.1:8420/admin/ui`; Fly app name `asktoto-license`). `asktoto-license.fly.dev` did not resolve when last probed. Operator shows the fleet that actually heartbeats.

## Hard law

- Access JWT or `ctx.access.getIdentity()` on every admin GET. No Access, 401.
- Empty fleet copy: "No heartbeats yet." Never a fake Paris seat.
- ROI copy must say "estimate" when a dollar figure is shown.
- Device ids may be shortened in the table. Full ids stay in D1, not in a public URL.
- Do not restyle overlay chrome. Do not pack. Do not stamp Latest from this slice.

## Pixel language

Same Operator chrome (`docs/design/OPERATOR.md`): near-black, Geist, uppercase eyebrows, crop-mark cards. Licenses is a real table under Fleet. ROI is a KPI strip, not a vanity percentage.

## What landing looks like

Tony opens Access, lands on the packed console, sees Keys / Licenses / Devices map already in the pre-Shoey chrome. Licenses lists every heartbeat seat or the honest empty line. ROI uses the same ask log the Cost cards use.
