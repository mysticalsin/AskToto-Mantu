# Build & Ship Métis on Windows

Verified end-to-end on this machine — Windows 10 x64, Node 24.13.1 (repo pins `22.22.3`), npm 11.8.0,
Electron 39.8.10, electron-builder 26.15.3 — on 2026-07-15/16, covering both the standard installer
(`electron-builder.win.yml`) and the Cahê pilot installer (`electron-builder.cahe.win.yml`).

## Why Windows Must Build On Windows

`electron.vite.config.ts` compiles `src/main` to V8 bytecode (`main.build.bytecode: true` — see the
config's own comment and `docs/DEVELOPMENT.md` §3 on the dynamic-import trap this creates). The build's
`out/main/index.js` is a thin loader that `require("./index.jsc")`s the compiled bytecode through
`out/main/bytecode-loader.cjs`, which hands the `.jsc` bytes to Node's `vm.Script` as `cachedData` and
checks the result:

```js
if (script.cachedDataRejected) {
  throw new Error("Invalid or incompatible cached data (cachedDataRejected)");
}
```

That check — and its exact wording — comes from electron-vite's own bytecode compiler
(`node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js`), not from this repo. V8 only accepts cached
bytecode produced by the *same* V8 build: same Electron version, same OS, same CPU architecture.
Bytecode compiled on macOS arm64 is foreign data to the V8 embedded in a Windows x64 Electron binary, so
`cachedDataRejected` fires and the packaged app fails to launch. That was the crash in the original
shipped Windows build: commit `cc99f8d` ("Fix Windows build: separator-agnostic asar gate + autocrlf
license pin") records that, up to that point, "the app was only ever built on macOS."

There is no flag or config to relax this. **Build the Windows target on an actual Windows machine (or a
`windows-latest` CI runner)** — never cross-compile main's bytecode elsewhere and ship it into a Windows
package. `.github/workflows/build.yml` and `release.yml` already do this correctly
(`build-windows` runs on `windows-latest`).

## Prerequisites

- Git.
- Node. `package.json`'s `engines.node`, `.nvmrc`, and `.node-version` all pin the exact `22.22.3`.
  Node 24.x also works (verified: 24.13.1) — `npm install`/`npm ci` prints an `EBADENGINE` warning for
  the mismatch, which is benign and does not fail the install (the repo already ships with one
  unrelated `EBADENGINE` warning from `@dust-tt/client`'s own Node 20.19.2 pin, per
  `docs/DEVELOPMENT.md`; this is the same class of warning, not a build blocker).
- npm (bundled with Node).

```bash
git clone https://github.com/mysticalsin/AskToto-Mantu.git
cd AskToto-Mantu
npm ci
```

## Provision Build Assets

Métis bundles its ASR models, local-LLM weights, and native sidecars into the installer; none of them
are downloaded at runtime. Provision them in this order — it mirrors `predist:win` in `package.json`:

**1. ffmpeg sidecar — the one asset with no fetch script.** Every other sidecar below has a
`fetch-*.mjs`; ffmpeg does not. Restore the reviewed LGPL-only binary from this repo's
`ffmpeg-sidecar-v1` GitHub release (see `docs/ENTERPRISE_RELEASE.md`'s "ffmpeg Sidecar Provisioning"):

```bash
gh release download ffmpeg-sidecar-v1 --repo mysticalsin/AskToto-Mantu --pattern ffmpeg-win32-x64.exe
mkdir -p resources/ffmpeg/win32-x64
mv ffmpeg-win32-x64.exe resources/ffmpeg/win32-x64/ffmpeg.exe
node scripts/check-ffmpeg-sidecar.mjs win
```

`check-ffmpeg-sidecar.mjs` hashes the restored binary against `resources/ffmpeg/manifest.json`'s
`win32-x64/ffmpeg.exe` entry. A mismatch means the wrong binary was restored, not a broken gate.

**2. Native ASR addon:**

```bash
node scripts/check-sherpa-platform.mjs win
```

Verifies the native Parakeet ASR addon for win-x64, attempting an auto-provision
(`npm install --force sherpa-onnx-win-x64@<version>`) first if it's missing.

**3. Local-LLM sidecar runtime:**

```bash
node scripts/fetch-llama-server.mjs win
node scripts/check-llama-sidecar.mjs win
```

Downloads both the Vulkan (GPU, preferred) and CPU (fallback) `llama-server.exe` builds. Windows
packages need both — `local-runtime.ts` falls back to the CPU build once if Vulkan fails to spawn.

**4. Local-LLM model weights:**

```bash
node scripts/fetch-local-model.mjs
node scripts/check-local-model.mjs
```

The bundled Qwen3.5 0.8b GGUF chat model plus its vision projector.

**5. ASR models:**

```bash
node scripts/fetch-models.mjs
```

Whisper-base (WASM ASR fallback), the Parakeet TDT 0.6b v3 int8 model, and ONNX-runtime's WASM blobs;
finishes by running `check-runtime-assets.mjs` itself. **See "Known Windows Pitfalls" below if this
step fails while extracting the Parakeet `.tar.bz2` archive.**

## Build

```bash
npm run build:intelligence
npm run build
npx electron-builder --config electron-builder.win.yml --win --x64 --publish never
node scripts/check-packaged-runtime.mjs win --post-sign
```

`npm run build` also runs the `prebuild`/`postbuild` gates (`check-no-dynamic-import`,
`check-offline-package`, `check-built-offline`) automatically. The electron-builder command above is the
**standard** build — it embeds no key of any kind. `check-packaged-runtime.mjs --post-sign` is the same
post-build gate the release scripts use: exact reviewed inventories for the Qwen/ASR/ORT/llama/FFmpeg/
Sherpa payloads, plus the PE x64 executable-architecture check. Installers land in `release/`.

## The Cahê Pilot Edition

Cahê (`docs/cahe-windows-edition.md`) is a Windows-only pilot build, isolated from the standard Métis
install by construction, not just by name:

- Its own `appId` (`com.mantu.metis.windows-cahe`) and executable name (`Metis-Windows-Cahe.exe`).
- Its own isolated userData profile — `src/main/cahe-edition.ts`'s `initializeCaheEditionIdentity()`
  points `app.getPath('userData')` at a dedicated folder before any settings/transcripts/keystore file is
  touched, so it can never read, overwrite, or share state with a normal Métis install.
- It still **displays** as "Métis" — window title, taskbar, and Start-menu shortcut all read `Métis`
  (`CAHE_DISPLAY_NAME`); only the isolated userData folder name and the installed `.exe` stay
  ASCII/distinct internally.
- The active provider is locked to Kimi (`caheEditionPolicy()`: `allowedProviders: ['kimi', 'dust']`,
  `lockedKeys: ['provider', 'providerPriority']`). Dust can still be connected for its own agent/workspace
  session; connecting it does not replace Kimi as the active provider.
- Auto-update is disabled (`shouldDisableAutoUpdate()` returns `true` for Cahê) — it never shares the
  standard Métis release feed. New Cahê builds ship as new Cahê installers.

### Plug-and-play embedded key

The pilot is meant to work with zero setup, so it can ship with a Kimi API key baked in — an
intentional, disclosed convenience for this pilot only, not a general pattern.

1. Put the operator-provided key in the gitignored `build/cahe-kimi.local.json` (see `.gitignore`):

   ```json
   { "kimiApiKey": "sk-kimi-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" }
   ```

   It must be a **Kimi Code** key (`sk-kimi-…`). Kimi Code keys authenticate against the coding endpoint
   `https://api.kimi.com/coding/v1`, not Moonshot's own `api.moonshot.ai` — a regular Moonshot key 401s
   there (see `src/shared/providers.ts`'s `kimi` provider entry). A label prefix such as `"Metis: sk-kimi-…"`
   is tolerated — `src/main/cahe-embedded-key.ts` regex-extracts the bare `sk-kimi-` token before storing it.

2. `electron-builder.cahe.win.yml`'s `extraResources` copies that file to `resources/cahe/kimi.json`
   **unconditionally** whenever it's present — the env var below does not control whether the key gets
   copied into the package, only whether the post-build check accepts that it did. Build with the
   embed flag explicitly set:

   ```powershell
   $env:METIS_CAHE_EMBED_KEY = "1"
   npx electron-builder --config electron-builder.cahe.win.yml --win nsis --x64 --publish never
   node scripts/check-packaged-runtime.mjs win release/win-unpacked/resources --post-sign --executable=Metis-Windows-Cahe.exe
   node scripts/check-cahe-package.mjs release
   ```

   Or use the wrapped convenience script, which runs the full provision → build → both check gates in
   one go and writes to `release/cahe-win/` instead:

   ```powershell
   $env:METIS_CAHE_EMBED_KEY = "1"
   npm run installers:win:cahe
   ```

   Without `METIS_CAHE_EMBED_KEY=1`, `scripts/check-cahe-package.mjs` hard-refuses the package the
   moment it finds an `sk-kimi-` pattern in the packaged `win-unpacked/resources/cahe/` bundle — the
   extraResource that actually carries the key — or in `app.asar` or the installer `.exe`
   (`Refusing Cahê package with an embedded Kimi API key: …`). Those last two are a net for a key that
   lands somewhere it was never meant to be, not coverage of this one: NSIS ships `win-unpacked` inside
   an LZMA-compressed payload, so a byte scan of the `.exe` cannot see `cahe/kimi.json` there at all.
   This is the safe default; a normal Métis
   build (`electron-builder.win.yml`) never bundles `cahe-kimi.local.json` in the first place, since only
   the Cahê config lists it under `extraResources`. **With** the flag set, the same scan still runs but
   tolerates the key, printing a loud multi-line warning that names the file it found the key in and
   reminds the operator that **the key is extractable from the installer by anyone who has it** — use a
   key scoped to this pilot's minimum plan/quota, and be ready to rotate it.

3. **First run is a one-time seed, not a sync.** `src/main/cahe-embedded-key.ts`'s
   `importEmbeddedCaheKey()` runs once during app startup (wired into `src/main/index.ts`). The first
   time it runs for a profile — whether it succeeds, finds no bundle, or hits an error — it writes a
   `.cahe-key-seeded` marker file into that isolated userData folder and never acts again for the life of
   the profile. So a pilot user who later changes or clears the Kimi key in **Settings → AI** keeps that
   choice permanently; the embedded key is never silently reapplied on a later launch.

## Signing

An unsigned local build isn't blocked, but Windows SmartScreen will flag the installer as an
unrecognized app on first run until it's Authenticode-signed (or Microsoft's reputation service warms up
to it). For a signed local build:

```powershell
$env:WIN_CSC_LINK = "C:\secure\MantuCodeSigning.pfx"
$env:WIN_CSC_KEY_PASSWORD = "..."
npx electron-builder --config electron-builder.win.yml --win --x64 --publish never
```

A tagged customer release additionally requires `WIN_CSC_EXPECTED_SUBJECT`, and `verify-signing.mjs`
checks that the produced binary's Authenticode subject matches it exactly — see `docs/SIGNING.md` for
the full credential list and the store-signing (Microsoft Store) path.

## Known Windows Pitfalls

| Issue | Symptom | Status |
|---|---|---|
| `app.asar` entries keyed with backslashes | An archive packed on Windows keys its entries with `\` instead of `/`. `check-packaged-runtime.mjs` and `check-cahe-package.mjs` used to look entries up with a hardcoded forward-slash path, so a Windows-packed archive failed dependency-pruning checks that a macOS-packed archive passed — per commit `cc99f8d`, the packaged-runtime gate threw `express-rate-limit/package.json not found` and the Cahê package check failed the same way, even though the archive was fine. | **Fixed** (commit `cc99f8d`) — both scripts now normalize `\` to `/` before lookup; still correct on macOS. |
| `.gitattributes` didn't cover the moved license path | The Qwen model license moved from `resources/local-ai/licenses/` to `resources/local-llm/`, but `.gitattributes` still only pinned the old path. On a Windows checkout, `core.autocrlf` rewrote the license LF→CRLF, so it failed its exact byte-size/hash pin in `check-local-model.mjs`. | **Fixed** (commit `cc99f8d`) — added a `resources/local-llm/*.txt -text` rule. |
| `fetch-models.mjs`'s Parakeet `.tar.bz2` extraction | `fetchParakeet()` used to shell out to plain `tar xjf`. Windows ships its own `tar.exe` (bsdtar, under `System32`), separate from Git for Windows' GNU tar under `Git\usr\bin`; whichever resolves first on `PATH` decided whether extraction worked. | **Fixed** — `scripts/tar-bz2-extract.mjs` inflates the archive in-process on Windows, so no external `tar` is involved. |
| `fetch-llama-server.mjs`'s llama runtime `.zip` extraction | Same class, different container: `extractRuntime()` ran `execFileSync('tar', ['-xf', <archive>, …])` with a drive-letter path. GNU tar cannot read a `.zip` at all **and** parses the leading `D:` as `[user@]host:path` remote-tape syntax, failing with `tar: Cannot connect to D`. Node's spawn resolves a bare command name through `PATH` only — it does **not** fall back to `System32` — so the build was a coin flip decided by the operator's shell. | **Fixed** — `scripts/zip-extract.mjs` inflates the zip in-process with `node:zlib`; no external binary, no `PATH` dependency. |

Both extractors are pure-Node and add no dependencies. If you are chasing a *new* extraction failure,
check that you are not reintroducing a bare `tar`/external-tool spawn: `scripts/` is expected to stay
free of `PATH`-resolved archive tools on Windows.
