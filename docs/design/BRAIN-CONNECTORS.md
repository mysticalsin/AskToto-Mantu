# Brain connectors

Date: 2026-08-31
Owner: Tony · Settings → Brain
Status: **active contract** — implement only what this file states.

## Outcome

Settings → Brain shows three connectors.

- **Polo Pre-Sales** stays Tony's CRM form: MCP URL, API key, Test, Save. No visual or flow rewrite.
- **ClickUp** and **Plane** are product connects: official logo, name, one friendly line, one **Connect** button. Connect opens the vendor login in the system browser and Métis finishes MCP setup. No URL, key, slug, Test, or Save on the default card.
- **Advanced** (closed on every mount) is the power path: paste an API key. Extra headers (Plane workspace slug) live here too. The official hosted MCP URL is pinned in main — never a field.
- Nothing auto-sends. Connect is a click. Push stays Review → Confirm.

## QUALITY hats (fail closed)

`QUALITY.md` is not in this repo. These hats *are* the gate. Any reject fails the slice.

| Hat | Ships only if | Rejects |
|---|---|---|
| Product | Common path is logo + one Connect. Login tab opens from that click. | A 5-field form (URL, key, slug, Test, Save) as the default ClickUp or Plane card. |
| Craft | Official ClickUp and Plane marks. Apple density: 12/11 type, hairline card, one CTA. | Generic Lucide icons as brand marks. Invented glyphs. Scraped PNGs. Purple-hero / card-in-card slop. |
| Trust | Connect, Test, Save, Disconnect fire only from an explicit click. Review still confirms every push. | `useEffect` / mount / logo-hover that calls connect, save, or `mcpPush`. |
| Scope | Polo card source-equal in flow. Overlay, onboarding, starfield, Jarvis pill, thinking-orbs, island/bar geometry untouched. | Edits under those surfaces. Pack. Merge. |
| Power | Advanced still accepts a key (and Plane extra headers). | Removing the key path, or putting URL/key on the default card "just in case". |

Would Apple ship this Settings connect? Only if every hat passes.

## Default card (ClickUp, Plane)

One row:

1. Official mark (28px, rounded well).
2. Name (12 medium) + one line (11 muted).
3. **Connect** when disconnected. **Connected** pill + Reconnect / Disconnect when connected.

Copy (fixed):

- ClickUp line: `Tasks from a recap. Nothing sends itself.`
- Plane line: `Work items from a recap. Nothing sends itself.`
- Button: `Connect` → `Waiting for ClickUp…` / `Waiting for Plane…`
- Connected tools line uses the saved `tools` list. No endpoint URL.

Logo tap when **disconnected** runs the same Connect. Logo tap when **connected** is inert (Reconnect is the explicit control).

Forbidden on the default card (and on the collapsed Advanced header):

- `MCP endpoint URL`
- API key input
- Workspace slug
- Test connection / Save

## Advanced (ClickUp, Plane)

`ExpandableSection` / equivalent: **closed on every mount**. Title `Advanced`. Desc: `Paste a key if you already have one.`

When open:

- API key (password).
- Plane only: optional `X-Workspace-slug` (and any other extra header already on the connection). Not required for first-run OAuth.
- Test connection + Save. Same `mcpTestConnection` / `mcpSaveConnection` as Polo. Save stays disabled until Test succeeds.
- **No MCP URL field.** Main pins the URL.

## Polo Pre-Sales

`McpConnectionCard` with `kind="bidstack"` is frozen for this slice:

- Still asks for MCP endpoint URL + API key.
- Still Test → Save.
- Still no logo rewrite.
- Still the existing "Set up" / Reconnect / Disconnect chrome.

Do not extract, restyle, or "align" Polo to the product-connect card.

## Auth and pinned URLs

### ClickUp (already shipped)

- Connect: existing `runClickupOAuth` / `mcp:clickupConnect` (OAuth 2.1 + PKCE + DCR).
- Pinned MCP URL (never shown): `https://mcp.clickup.com/mcp` (`CLICKUP_MCP_ENDPOINT`).
- Advanced key: `mcpSaveConnection` against that same pinned URL. Official ClickUp MCP is OAuth-first; a pasted key is a power option and may be rejected by ClickUp — surface their error, do not invent a second endpoint.

### Plane (this slice)

Researched live 2026-08-31 from `https://mcp.plane.so/.well-known/oauth-authorization-server` and [Plane MCP docs](https://developers.plane.so/dev-tools/mcp-server):

| Endpoint | Auth | When |
|---|---|---|
| `https://mcp.plane.so/http/mcp` | OAuth 2.1 + PKCE + DCR | **Connect** (primary) |
| `https://mcp.plane.so/http/api-key/mcp` | Bearer PAT + optional `X-Workspace-slug` | **Advanced** key |

Discovery (pin these, do not ask the user):

- `authorization_endpoint`: `https://mcp.plane.so/authorize`
- `token_endpoint`: `https://mcp.plane.so/token`
- `registration_endpoint`: `https://mcp.plane.so/register`
- `grant_types_supported`: `authorization_code`, `refresh_token`
- `code_challenge_methods_supported`: `S256`
- `token_endpoint_auth_methods_supported`: `client_secret_post`, `client_secret_basic` — **not** `none`. Plane is a confidential client. `client_secret` from DCR is a secret: encrypted `mcpSecrets` (`key-mcp-plane-client.bin`), never `settings.json`.
- `client_id` is public: `planeClientId` in settings, main-owned (strip on `settings:set`, same as `clickupClientId`).

Connect flow (`mcp:planeConnect`):

1. Explicit click only.
2. DCR once (cache `planeClientId` + encrypted client secret). Reuse after that so the login tab opens immediately.
3. Loopback `http://127.0.0.1:<ephemeral>/callback` (literal `127.0.0.1`, RFC 8252 §7.3). Plane's hosted allowlist includes localhost callbacks.
4. `shell.openExternal` to `/authorize` with PKCE S256 + `read write` (matches `scopes_supported`).
5. Exchange code with `client_secret_post` + `code_verifier`.
6. `connectMcp(PLANE_MCP_OAUTH_ENDPOINT, accessToken, {}, 'Plane')`.
7. Persist access token via `setMcpApiKey('plane')`, refresh via `setMcpRefreshToken('plane')`, upsert `mcpConnections` in **main**.
8. Workspace is chosen on Plane's login page. No slug on first run.

Advanced key flow: pin `PLANE_MCP_PAT_ENDPOINT`. Never persist a renderer-supplied Plane/ClickUp URL — main overwrites `clickup`/`plane` saves to the pinned URL for that path (OAuth URL after Connect, PAT URL after Advanced save).

`mcp:push` 401/403 on a Plane OAuth connection: one refresh + retry, same single-flight lock as the interactive flow. Failure → "Reconnect Plane in Settings." Confidential meetings still never send.

## Never auto-send

Invariant: no `useEffect`, timer, or mount path may call `mcpClickupConnect`, `mcpPlaneConnect`, `mcpSaveConnection`, `mcpTestConnection`, or `mcpPush`. Review remains confirm-to-send.

## Logos

Vendor official simple-icons paths (CC0 marks; trademarks remain ClickUp / Plane Software):

| Brand | simple-icons slug | Official hex | Source |
|---|---|---|---|
| ClickUp | `clickup` | `#7B68EE` | https://clickup.com/brand |
| Plane | `plane` (commit `978656df6ce854ac04e45351059f8e3db7e34ef4`) | `#121212` | https://plane.so/brand-logos/logo-with-wordmark.svg |

Render as inline SVG React components (`ClickUpMark`, `PlaneMark`). Plane's hex is near-black — paint with `currentColor` on our dark glass so the **official path** stays, and it still reads. Do not invent a second Plane glyph. Attribution also lives in `docs/design/DESIGN.md`.

## Out of scope

- Overlay hide / island / bar geometry, onboarding, starfield, Jarvis pill, thinking-orbs.
- Pack. Merge. Ready-to-merge.
- Rewriting Polo, Review push chrome, or `mcpClient.ts` transport (OAuth tokens are bearer keys).

Post-meeting ClickUp **create-task** (destination, args, fail-loud) lives in [`CLICKUP-PUSH.md`](./CLICKUP-PUSH.md). Connect OAuth stays this file + PR 73's exact loopback DCR.

## Tests (required)

Source-contract on `Settings.tsx` (no Settings render harness):

1. ClickUp default card (disconnected JSX before Advanced) has no `MCP endpoint URL` and no API-key `<input>`.
2. Plane default card has no MCP URL field / `MCP endpoint URL`.
3. Polo `McpConnectionCard` still has `MCP endpoint URL` + API key + Test + Save.
4. Advanced (ClickUp + Plane) still has an API key input.
5. No `useEffect` in the product-connect cards calls connect / save / push.

Plus: `planeOAuth` loopback+PKCE tests (mirror `clickupOAuth.test.ts`); `planeClientId` stripped on `settings:set`; Polo / overlay / onboarding files unchanged in the diff.
