# metis-cloudflare-proxy

A single-file Cloudflare Worker that lets Métis use Cloudflare's AI REST API **without the desktop app
ever holding a Cloudflare account token**.

The operator deploys this. Métis then talks to the Worker, and the Worker adds the account token on the
way out. The token lives on infrastructure the operator controls and is never packaged, never shipped,
never in a settings file.

Why it works this way — and what a Métis user has to enter in Settings — is in
[`../docs/CLOUDFLARE.md`](../docs/CLOUDFLARE.md). This file is the deploy runbook.

```
Métis  ──Bearer METIS_PROXY_KEY──▶  this Worker  ──Bearer CLOUDFLARE_API_TOKEN──▶  api.cloudflare.com
                                    (holds both secrets, streams the reply straight back)
```

---

## What it exposes

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /v1/chat/completions` | `Authorization: Bearer <METIS_PROXY_KEY>` | OpenAI-shaped. Forwarded to `https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/v1/chat/completions` with the account token injected. `"stream": true` is passed through frame by frame. |
| `GET /health` | none | `{ "ok": true, "service": "metis-cloudflare-proxy", "configured": true }`. `configured` says whether all three secrets are set — never what they are. |

Anything else is a `404`; the wrong method on a real route is a `405`. There is no CORS handling: Métis
calls this from its Electron **main** process, not from a browser.

---

## The three secrets

All three are Wrangler secrets. None of them appears in `wrangler.jsonc`, in this repo, or in any build
output — that is the entire point of the design.

| Secret | What it is | Where it comes from |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | The account token the Worker spends. | Cloudflare dashboard → **My Profile → API Tokens → Create Token**. Give it permission to run AI models on the one account below, and nothing else. Not a Global API Key — those cannot be scoped. |
| `CF_ACCOUNT_ID` | The account the models bill to. | Cloudflare dashboard → any zone's **Overview** sidebar, or `npx wrangler whoami`. |
| `METIS_PROXY_KEY` | What Métis presents as its API key. Worthless outside this Worker. | You generate it. `openssl rand -base64 32`, or `node -e "console.log(crypto.randomUUID())"`. |

---

## Deploy

Requires a Cloudflare account and Node. Wrangler is run through `npx`, so there is nothing to install
into this repo and no second `package.json` to keep in sync.

```sh
cd cloudflare-proxy
npx wrangler@4 login
```

Set the three secrets. Each command prompts for the value on a hidden line — do not pass secrets as
shell arguments, they end up in your shell history.

```sh
npx wrangler@4 secret put CLOUDFLARE_API_TOKEN
npx wrangler@4 secret put CF_ACCOUNT_ID
npx wrangler@4 secret put METIS_PROXY_KEY
```

If this is the very first command against a Worker that does not exist yet, Wrangler offers to create
it — say yes. Then deploy:

```sh
npx wrangler@4 deploy
```

### Getting the Worker URL

`wrangler deploy` prints it on the last line:

```
Deployed metis-cloudflare-proxy triggers (0.79 sec)
  https://metis-cloudflare-proxy.<YOUR_SUBDOMAIN>.workers.dev
```

It is also on the Worker's page in the dashboard (**Workers & Pages → metis-cloudflare-proxy**), and
`npx wrangler@4 deployments list` will show the current version. The value Métis needs is that URL with
`/v1` appended.

### Verify the deploy — two checks, both required

`configured: true` proves the secrets landed:

```sh
curl https://metis-cloudflare-proxy.<YOUR_SUBDOMAIN>.workers.dev/health
# {"ok":true,"service":"metis-cloudflare-proxy","configured":true}
```

A real streaming completion proves the token works and the passthrough is live. Tokens should appear
progressively, not all at once at the end:

```sh
curl -N https://metis-cloudflare-proxy.<YOUR_SUBDOMAIN>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_METIS_PROXY_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
        "model": "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "messages": [{"role": "user", "content": "Say hello in five words."}],
        "stream": true
      }'
```

And confirm the door is shut — this must come back `401`:

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  https://metis-cloudflare-proxy.<YOUR_SUBDOMAIN>.workers.dev/v1/chat/completions \
  -X POST -H "Content-Type: application/json" -d '{}'
# 401
```

---

## Rotating `CLOUDFLARE_API_TOKEN`

Rotate by **overlap**, not by gap: create the replacement first, so the proxy is never running without a
valid token.

1. Create a new API token in the Cloudflare dashboard with the same scope as the old one.
2. `npx wrangler@4 secret put CLOUDFLARE_API_TOKEN` and paste the new value. Wrangler creates a new
   version of the Worker and deploys it immediately; the change is live in seconds.
3. Re-run the streaming `curl` above. A `502` mentioning `CLOUDFLARE_API_TOKEN` means the new token is
   wrong or under-scoped — fix it before step 4.
4. **Delete the old token** in the dashboard. Until you do this, the rotation has not actually happened.

Nothing on any user's machine changes. Métis never held this token.

## Revoking a leaked `METIS_PROXY_KEY`

The proxy key is a bearer credential to a paid endpoint. If one leaks — pasted into a ticket, committed,
found in a log — treat it as spending someone's money until it is replaced.

1. Generate a new one (`openssl rand -base64 32`).
2. `npx wrangler@4 secret put METIS_PROXY_KEY`, paste it. **The old key stops working the moment that
   version deploys**, which is the behaviour you want: revocation is immediate and total.
3. Update Métis Settings on every machine that used the old key. Between step 2 and step 3 those
   installs get `401 Invalid proxy key` and fail over to whatever other provider they have configured.
4. Check what the leaked key spent: **Workers & Pages → metis-cloudflare-proxy → Logs**, and the AI
   Gateway dashboard for the account.

There is deliberately no list of accepted keys and no per-user keys. One secret, one `put` to revoke.
If you need per-user revocation, that is a different design (put Cloudflare Access in front of the
Worker) and should be decided as one, not bolted on.

## Keeping the bill bounded

The proxy key is the only thing between a scraped hostname and the operator's balance, so give it a
second floor:

- **AI Gateway rate limiting.** Every request through this Worker already passes through the account's
  default gateway. Create a dedicated gateway with a request-per-minute limit, then set
  `CF_AI_GATEWAY_ID` in `wrangler.jsonc`'s `vars` and redeploy. The Worker pins that gateway with the
  `cf-aig-gateway-id` header and ignores any gateway a *caller* asks for — gateway choice is the
  operator's, or the rate limit would be trivially bypassable.
- **Scope the API token to one account and to AI only.** A leaked-but-scoped token cannot touch DNS,
  R2, or zone settings.

---

## Local development

```sh
cd cloudflare-proxy
npx wrangler@4 dev
```

`wrangler dev` reads secrets from a `.dev.vars` file next to `wrangler.jsonc`:

```
CLOUDFLARE_API_TOKEN=<YOUR_TOKEN>
CF_ACCOUNT_ID=<YOUR_ACCOUNT_ID>
METIS_PROXY_KEY=<ANY_LOCAL_TEST_VALUE>
```

That file holds a real account token. `cloudflare-proxy/.gitignore` already ignores it — the ignore was
committed before this paragraph existed, on purpose. Never move those values into `wrangler.jsonc`.

## Tests

`src/index.test.ts` covers the two things that can hurt someone if they are wrong — the auth boundary
and the account token not leaking back out — plus the streaming passthrough, all without deploying.

It **is** part of the repo's `npm test` run. The root `vitest.config.ts` scopes `include` to `src/`,
`intelligence/src/`, `scripts/` and `eval/`, so its globs can never reach this directory — which is why
`package.json`'s `test` script chains `test:proxy` explicitly. A suite that never runs is not a suite.
To run only this one, from the repo root:

```sh
npm run test:proxy
```

Type-check the Worker against the Cloudflare runtime's globals (not part of `npm run typecheck`,
which describes the Electron main and renderer trees):

```sh
npx tsc --noEmit -p cloudflare-proxy/tsconfig.json
```

What the tests do **not** cover, and do not claim to: Wrangler secret binding, `wrangler deploy`, the
live Cloudflare endpoint, and AI Gateway behaviour. Those are the `curl` checks above.
