# Embedded product-key rotation

Installer-embedded `METIS_PROXY_KEY` (`src/main/embedded-cloudflare-key.ts`) and the Cahê Kimi key (`src/main/cahe-embedded-key.ts`) are **disclosed, scoped, revocable product keys**. `npx asar extract` recovers them. That is the documented residual on audit item 2, not a hidden leak.

They must never become:

- the Cloudflare **account** token (`CLOUDFLARE_API_TOKEN`)
- the operator's own `METIS_PROXY_KEY`
- a license admin token, Graph token, or MCP bearer

## One command

```sh
npm run rotate:embedded-keys
```

That writes a new gitignored `build/cloudflare-embed/key.json` and prints the Worker update. Then:

1. `cd cloudflare-proxy && npx wrangler@4 secret put METIS_PROXY_KEYS` — keep every other labeled key; replace only the `embedded-default:` entry with the printed value.
2. Drop the previous `embedded-default` entry. Old installers stop at the Worker. New installs get the new key.
3. Rebuild the installer with `METIS_EMBED_CLOUDFLARE_KEY=1`.

Cahê edition only: replace `build/cahe-kimi.local.json`, run `node scripts/embed-cahe-kimi-key.mjs` (or the Cahê build chain, which calls it), and revoke the old `sk-kimi-` key at the vendor. The packaged file is the encrypted blob under `build/cahe-embed/kimi.json` — never ship plaintext `kimiApiKey` JSON. Do not reuse that key as anything else.

See `docs/CLOUDFLARE.md` and `scripts/rotate-embedded-keys.mjs`.
