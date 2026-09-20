# Cap1 fuse status — existing Operator Worker only
**When:** 20 Sep 2026 ~1:13pm ET (America/Toronto)  
**Branch tip (box):** `8312bbab` (Cap2) on parent Cap1 `9568d21`  
**Worker:** `metis-operator` → https://metis-operator.tony-walteur.workers.dev  
**No second portal.**

## Live check (curl /health)
```json
{"ok":true,"service":"metis-operator","version":"2b26efa","builtAt":"2026-09-14T02:50:46.011Z"}
```
**Cap1 Keys UI (TypeSafe/Jev) is NOT live yet** — Worker still `2b26efa` (2026-09-14).

## Source on tip `9568d21` (ready to deploy)
- Keys section `TypeSafe / Jev (decision provider)` — `operator/src/render/pages/keys.ts`
- Vault `typesafe_jev` in `VAULT_DECISION_PROVIDERS` only — `operator/src/vault.ts`
- `POST /v1/decide` — `operator/src/decide.ts`
- Vitest Cap1 decide/keys: **13/13** on box

## Deploy (Totos-Mac, wrangler auth)
```bash
cd AskToto-Mantu && git checkout metis-2.0-inventory && git pull
node operator/scripts/deploy.mjs --env production
# expect /health version ≈ 9568d21c or tip short SHA after Cap2 push
```
Box: no wrangler OAuth / no CF API token create. CF MCP can read Worker; production deploy needs Mac session.

## Cap2 parallel
Tip `8312bbab` + bundle `proof/metis-20-cap2.bundle` — Mac `gh` push required. Pack HOLD. OAuth LAST.
