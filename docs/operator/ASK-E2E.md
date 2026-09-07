# G11 — Portal Ask E2E (prove host only)

Prove host (lock): `https://metis-operator.tony-walteur.workers.dev/`
Worker: `metis-operator`. Pack HOLD. OAuth LAST. No seat-local keys.

## Deploy this tip

```sh
cd operator
node scripts/deploy.mjs --env production
# or: npx wrangler@4 deploy --var OPERATOR_VERSION:<shortsha>
node scripts/migrate.mjs --remote
```

Zero Trust: add **Bypass / Everyone** for path `/v1/ask` (clone `/v1/use`). Do not enable Protect this Worker.

## Success signals

Unauth probe (Access must not wrap):

```sh
curl -sI https://metis-operator.tony-walteur.workers.dev/v1/ask
# expect HTTP 401, NOT 302

curl -s -X POST https://metis-operator.tony-walteur.workers.dev/v1/ask \
  -H 'content-type: application/json' -d '{}'
# expect {"ok":false,"error":"missing HMAC headers"}
```

Licensed seat Ask (HMAC, no seat-local CF/DeepSeek key):

```sh
# BODY: provider=cloudflare model=@cf/deepseek-ai/deepseek-v4-flash-0731 messages=[{role,content}]
# HMAC headers: same as /v1/use (ts, nonce, device, sig)
# expect: content-type text/event-stream ; data: {"t":"delta",...} then {"t":"done",...}
# never a vault secret in the stream
```

## Stamp gate (Tony)

1. Flash stream works with **no seat-local key**. Default model `@cf/deepseek-ai/deepseek-v4-flash-0731` (`portal-cf`).
2. Portal Overview + Keys show **two lines**: `portal-cf` vs `portal-direct` with tokens + list-price estimate, or `not reported`. Never `$0`.
3. Optional deep only: `@cf/deepseek-ai/deepseek-v4-pro-0813`. portal-direct (`api.deepseek.com`) is cost-compare, not everyday Ask.
4. Revoke vault or seat → next Ask `403` / `503`.

RF proves Flash stream first after deploy, then cost UI.
