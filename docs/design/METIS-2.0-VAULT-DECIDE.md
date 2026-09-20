# Métis 2.0 Cap 1 — Vault + /v1/decide proof

**Written:** 20 Sep 2026 ~1:04pm ET (America/Toronto)  
**Branch:** `metis-2.0-inventory`  
**Tip SHA:** `69d19abd9ec8f00d258f738506c24f47c6414b6b` (`69d19abd`) — branch `metis-2.0-inventory` HEAD at proof write  
**Base:** `7e54a08` on `release/1.9.1` · **NEVER** `ffcbf911`  
**Contracts:** `docs/design/METIS-2.0-CONTRACTS-CAP1.md`  
**Pack:** HOLD · **OAuth:** LAST · Desktop / Intel / notch: out of this slice

## What landed

| Item | Status |
|------|--------|
| Vault id `typesafe_jev` in `VAULT_DECISION_PROVIDERS` only | OK — not in `VAULT_LLM_PROVIDERS` |
| Admin Paste / Test / Save / Rotate / Revoke | OK — Keys UI + admin keys + test-jev |
| Portal `POST /v1/decide` (server holds key) | OK — `operator/src/decide.ts` |
| Fleet `decisionProviders.jev` capability flag | OK — heartbeat; never ships raw key |
| Kill switch `jevEnabled` (+ desktop/intel toggles) | OK — operator settings |
| ACCESS bypass for `/v1/decide` | OK — beside `/v1/ask` |
| Desktop never sees TypeSafe secret | OK — Operator Bearer only |

## Focused vitest

```bash
npm run test:operator -- operator/src/decide.test.ts operator/src/keys.test.ts operator/src/fleet.test.ts
```

| Field | Value |
|-------|-------|
| **exit_code** | **0** |
| path | `operator/src/decide.test.ts` · `keys.test.ts` · `fleet.test.ts` |
| result | Test Files 3 passed · Tests **20** passed |
| recheck | `decide.test.ts` → 5 passed · exit 0 |
| duration | ~1.8s |

## Commits on branch (Cap 1)

1. `6547aca1` — RF Claude: `feat(operator): Cap1 portal Jev vault + /v1/decide (typesafe_jev)`
2. `154781af` — ACCESS bypass `/v1/decide` + this proof

## Push note

Box has no `GH_TOKEN` / `gh auth`. Local branch complete. Push from Totos-Mac:

```bash
git push -u origin metis-2.0-inventory
```

## Out of scope (held)

Desktop video adapters · Mantu Intelligence Jev assist · right-edge notch · OAuth · Pack / Latest
