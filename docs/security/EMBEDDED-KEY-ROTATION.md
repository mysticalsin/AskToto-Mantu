# Embedded product-key rotation

Installer-embedded `METIS_PROXY_KEY` (`src/main/embedded-cloudflare-key.ts`) is a **disclosed, scoped, revocable product key**. `npx asar extract` recovers it. That is the documented residual on audit item 2, not a hidden leak.

The Cahê pilot edition, which used to embed a Kimi key the same way, was retired on 2026-09-26 (owner decision D-30, ticket M2-0214) and removed from the repository entirely.

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

See `docs/CLOUDFLARE.md` and `scripts/rotate-embedded-keys.mjs`.
