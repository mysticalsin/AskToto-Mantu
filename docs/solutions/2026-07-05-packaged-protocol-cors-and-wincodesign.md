# Packaged-only failures: custom-protocol fetch (CORS) + electron-builder winCodeSign extraction

Two Windows packaging failures that only reproduce in the PACKAGED app / on a real Windows box,
found while shipping the enterprise build on 2026-07-05. Companion to
`2026-07-05-windows-enterprise-port.md`.

## 1. Custom protocol fetch fails only when packaged: `TypeError: Failed to fetch`

**Symptom.** `asr-model://` (privileged custom scheme serving bundled Whisper/ORT weights) worked
in dev, but in the packaged exe every `fetch('asr-model://…')` — window and Web Worker alike —
rejected with `TypeError: Failed to fetch`. The 2.2 GB of bundled models was dead cargo;
transformers.js silently fell back to the CDN when online (masking the bug for months) and Listen
hard-failed offline because the worker sets `env.allowRemoteModels = false` when bundled.

**Root cause.** The packaged renderer loads over `file://` → its origin is opaque → every fetch to
another scheme is a cross-origin request. The scheme was registered without `corsEnabled`, so
Chromium refused the request outright — no request ever reached the protocol handler (nothing to
debug on the main-process side; the handler was correct).

**Fix (both halves required).**
```ts
protocol.registerSchemesAsPrivileged([{
  scheme: 'asr-model',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}])
// and in the handler, on every success Response:
headers.set('Access-Control-Allow-Origin', '*') // renderer origin is opaque; explicit allow needed
```

**Prevention rule.** A dev-mode pass never validates a custom protocol: dev renderers are served
from `http://localhost` and remote fallbacks mask local failures. Smoke-test the PACKAGED app with
a direct probe — Playwright `_electron.launch({ executablePath })`, then
`win.evaluate(() => fetch('scheme://…'))` from both the window and a Worker — and assert
`ok === true` plus expected byte lengths. Any repo bundling offline assets behind a custom scheme
should keep such a probe next to its build scripts (here: `.forge/probe-asr-protocol.mjs`).

## 2. electron-builder winCodeSign cache: symlink privilege breaks all Windows signing

**Symptom.** First `electron-builder --win` on a machine dies in a retry loop:
`ERROR: Cannot create symbolic link : A required privilege is not held by the client` while
extracting `winCodeSign-2.6.0.7z`, then `cannot execute cause=exit status 2`.

**Root cause.** The winCodeSign archive contains macOS `.dylib` symlinks. 7za needs
`SeCreateSymbolicLinkPrivilege` (admin shell or Windows Developer Mode) to create them. They are
irrelevant for Windows signing, but the non-zero exit makes electron-builder delete the extraction
and retry forever.

**Fix.** Pre-seed the cache once (non-admin safe) — extract ignoring the two symlink errors:
```bash
CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
curl -sL -o "$CACHE/winCodeSign-2.6.0.7z" \
  https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z
7za x -y -snld -o"$CACHE/winCodeSign-2.6.0" "$CACHE/winCodeSign-2.6.0.7z"   # exit 2 = darwin symlinks only
```
Builder then finds `winCodeSign-2.6.0/` and never re-extracts. Alternatives: enable Developer
Mode, or an elevated shell for the first build only.

## 3. Bonus: store-cert signing without a PFX password

`-c.win.certificateSha1=<thumbprint>` signs from the current user's cert store (no
`WIN_CSC_LINK`/password needed) — handy for a locally generated enterprise cert. Deprecated field
in electron-builder 25 (moves to `win.signtoolOptions` in 26); works, warns.
