# Métis 2.0 — Cap 1 Contracts (Portal-managed Jev)

**Locked:** 20 Sep 2026 · Ultron greenlight Cap 1  
**Branch:** `metis-2.0-inventory` @ base `7e54a08`  
**Owner:** Claude Totos-Mac seat (vault worker) · Devon sync ACK — one branch only

## HARD LOCKS

1. **Vault id** `typesafe_jev` lives in **NEW** `VAULT_DECISION_PROVIDERS` — **NEVER** in `VAULT_LLM_PROVIDERS`.
2. **Fleet** heartbeat advertises `decisionProviders: { jev: boolean }` via `seatAuthorizedForKeys` + portal enable — **flags only, no secrets**.
3. **`POST /v1/decide`** is portal-mediated. Clients never hit TypeSafe. Templates allowlist: `action_disambiguate` | `intel_rank` | `intel_score`. Pin `jev-1.13.0` **only after** live admin Test succeeds.
4. Desktop / seat shell / commits **NEVER** see `TYPESAFE_API_KEY` (or any raw TypeSafe secret).
5. Desktop adapter IDs (video slice) are **noted for later** — vault FIRST this seat.

## Typed decide (narrow)

### Request (seat → portal)
```json
{
  "template": "action_disambiguate" | "intel_rank" | "intel_score",
  "payload": { "...template-bounded object..." },
  "deadlineMs": 3000
}
```

### Response (portal → seat)
```json
{
  "ok": true,
  "template": "...",
  "result": { "...narrow typed..." },
  "confidence": 0.0,
  "provider": "typesafe_jev"
}
```
Confidence ≠ authorization.

### Upstream (portal only)
- `POST https://api.typesafe.ai/v1/systemone`
- `Authorization: Bearer <vault-decrypted typesafe_jev secret>`
- Version pin field recorded only after live Test.

## Portal Keys UI (TypeSafe / Jev)

Paste → Test → Save → Rotate → Revoke → Enable/Disable fleet (`jevEnabled`).  
Independent toggles (settings): `jevDesktop`, `jevIntel` (capability metadata; Cap 1 stores flags).  
Masked last4 only after save.

## Out of scope this seat
Desktop actions, notch, Codex Win E2E, OAuth, pack.
