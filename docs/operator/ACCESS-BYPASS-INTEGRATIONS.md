# Access Bypass: `GET /v1/integrations` (P0)

Live symptom: `curl -sI https://metis-operator.tony-walteur.workers.dev/v1/integrations` → **302** Cloudflare Access HTML.
Expected (same as heartbeat): **401** JSON `{ ok:false, error:"missing HMAC headers" }`.

Worker code already treats `/v1/integrations` as HMAC device auth. Cloudflare Access is wrapping the path before the Worker. Wrangler OAuth on this machine can deploy Workers but **cannot** list/edit Zero Trust Access apps (API returns empty / 403). Tony or Ultron must click the Bypass policy.

## Exact Zero Trust clicks

1. Open [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → account **Tony.walteur@gmail.com's Account**.
2. **Access** → **Applications** → open self-hosted app **Métis Operator** (`metis-operator.tony-walteur.workers.dev`).
3. Find the existing **Bypass** policies for `/v1/heartbeat`, `/v1/ingest`, `/v1/use`, `/v1/skills/manifest`, `/health`, `/assets/*`.
4. **Add a policy** (or clone an existing Bypass policy):
   - **Policy name:** `Bypass HMAC /v1/integrations`
   - **Action:** `Bypass`
   - **Include:** `Everyone` (same as the other device HMAC bypasses)
   - **Selector / path rule:** path equals `/v1/integrations` (or "URI Path" is `/v1/integrations`)
5. Save. Order does not need to beat Allow for console paths if Bypass is path-scoped the same way as heartbeat.
6. Do **not** enable **Protect this Worker**.

## Code list that must stay in sync

`ACCESS_BYPASS_PATHS` in `operator/src/access.ts`:

- `/health`
- `/v1/ingest`
- `/v1/heartbeat`
- `/v1/use`
- `/v1/ask`  ← add this in Zero Trust (same Bypass as `/v1/use`)
- `/v1/skills/manifest`
- `/v1/integrations`  ← add this in Zero Trust
- `/assets/*`

Also documented in `operator/README.md` (Cloudflare Access section) and `docs/operator/RUNBOOKS.md` §5.

## Prove after click

```sh
curl -sI https://metis-operator.tony-walteur.workers.dev/v1/integrations
# expect: HTTP/2 401

curl -s https://metis-operator.tony-walteur.workers.dev/v1/integrations
# expect: {"ok":false,"error":"missing HMAC headers"}

curl -s -X POST https://metis-operator.tony-walteur.workers.dev/v1/heartbeat \
  -H 'content-type: application/json' -d '{}'
# still: {"ok":false,"error":"missing HMAC headers"}
```

Or: `node operator/scripts/smoke.mjs --url https://metis-operator.tony-walteur.workers.dev`
