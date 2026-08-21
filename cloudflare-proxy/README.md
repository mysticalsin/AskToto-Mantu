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
| `POST /v1/chat/completions` | `Authorization: Bearer <any configured key>` | OpenAI-shaped. Forwarded to `https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/v1/chat/completions` with the account token injected. `"stream": true` is passed through frame by frame. Accepts `METIS_PROXY_KEY` and/or any key listed in `METIS_PROXY_KEYS` — see [Per-user keys](#per-user-keys). |
| `GET /health` | none | `{ "ok": true, "service": "metis-cloudflare-proxy", "configured": true }`. `configured` says whether the account token, account id, and at least one proxy key are set — never what they are, never how many. |

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
| `METIS_PROXY_KEY` | What Métis presents as its API key, single-org mode. Worthless outside this Worker. | You generate it. `openssl rand -base64 32`, or `node -e "console.log(crypto.randomUUID())"`. |
| `METIS_PROXY_KEYS` *(optional)* | Per-user keys, so one caller can be revoked without rotating everyone else's. See [Per-user keys](#per-user-keys) below. | You generate one per user, the same way. |

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
        "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
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

This is the whole org sharing one key: rotating it re-keys every user's Métis install at once. If you
only need to cut off **one** leaked or departing user without touching everyone else, use per-user keys
instead — see below.

## Per-user keys

`METIS_PROXY_KEY` is one shared secret for the whole org: fine for a single user or a small trusted
team, but rotating it to drop one person locks out everyone. `METIS_PROXY_KEYS` is the minimal fix —
a second, optional Wrangler secret holding a JSON array of keys, any of which the Worker accepts.

**Format.** A JSON array of strings. Each entry is either a bare key, or `label:key` — everything before
the first `:` is a free-form label for your own bookkeeping (a username, a machine name) and plays no
part in authentication; only the text after it is compared against the bearer token. Pick whichever form
you want per entry; the Worker does not care which you use, or that a file uses both.

```json
["tony:Zt3f9…", "dana:Qp81x…", "8h2Kd9…"]
```

**Issue one key per user.** Same generator as the shared key, once per person:

```sh
openssl rand -base64 32
```

Build the array (labelling by user is recommended — it is what makes "revoke dana's key" a one-line
edit instead of a guess) and set it:

```sh
npx wrangler@4 secret put METIS_PROXY_KEYS
# paste: ["tony:<tonys key>","dana:<danas key>","priya:<priyas key>"]
```

Give each user their own key in Métis Settings. `METIS_PROXY_KEY` can stay set alongside `METIS_PROXY_KEYS`
(both are accepted at once) or be unset once everyone has moved to a per-user key — either is a valid
end state.

**Revoke one user without touching anyone else.** Edit the array, drop their entry, redeploy the secret:

```sh
npx wrangler@4 secret put METIS_PROXY_KEYS
# paste the array again, with dana's entry removed
```

That redeploys a new Worker version with dana's key gone and everyone else's untouched — no shared
secret to hand back out, no other user's Métis install re-configured. Confirm with the same `401` check
from the deploy section, using dana's now-revoked key.

**Malformed `METIS_PROXY_KEYS` fails closed.** If the secret is set but is not valid JSON, or not an
array of non-empty strings, the Worker refuses every request — including ones presenting a perfectly
valid `METIS_PROXY_KEY` — with a `5xx` naming the problem, and `/health` reports `configured: false`.
A typo while editing the array takes the proxy down for everyone rather than silently widening who it
accepts; fix the JSON (or unset the secret) and redeploy to restore service.

**When this still isn't enough.** Per-user keys give you revocation and rough attribution via the label,
nothing more — no per-user rate limits, no audit log of who made which call, no SSO. If you need real
per-identity access control, that is a heavier, deliberate design: put
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of the
Worker and decide it as its own project, not bolted on here.

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
