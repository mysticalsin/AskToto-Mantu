# Development Guide — Métis

Everything a developer needs to go from `git clone` to a running app, understand how it's tested,
and avoid the traps that only show up once you're deep in the codebase. For packaging/signing/release,
this doc stops at a quick reference and points to `docs/ENTERPRISE_RELEASE.md` and `docs/SIGNING.md`
for the full runbook.

Internal note: the package name (`asktoto`), the `com.mantu.asktoto` app id, and the
release feed all stay stable through the Métis rebrand on purpose — macOS TCC grants and the
auto-updater are keyed to them. The active feed is this repository's `AskToto-Mantu` GitHub Releases page.
Everything user-visible says Métis.

## 1. Environment setup

**Node version.** Use Node **22.22.3 LTS**. CI, `.nvmrc`, `.node-version`, and `package.json#engines`
all pin the same version so native packaging does not drift between developer machines and runners.
Run `nvm use` (or your version manager's equivalent) before installing dependencies; a different major
version risks a native-module ABI mismatch with `sherpa-onnx-node` (see §4).

`@dust-tt/client@1.2.6` still declares its publisher's exact Node 20.19.2 build environment, so npm
prints one upstream `EBADENGINE` warning on install. Métis uses only its compiled `DustAPI` client, which
runs inside Electron 39's Node 22 runtime. The unused bundled MCP server tree is removed from installers
and verified from the finished `app.asar` by `scripts/check-packaged-runtime.mjs`.

**Clone and install:**

```bash
npm install
npm run dev
```

That's enough to run the overlay in dev. Three things are deliberately *not* required for `npm run dev`
to work, each with a graceful fallback — know about them so you're not surprised later:

1. **The `intelligence/` dashboard is a separate npm workspace**, not covered by the root
   `npm install`. It has its own `package.json` (`deal-psychology-dashboard`) and is built via
   `npm run build:intelligence`, which itself runs `cd intelligence && npm ci && npm run build`.
   `npm run build` and `npm run dev` now run `scripts/ensure-intelligence-bundle.mjs` first, so a
   normal tree cannot skip the dashboard. Totos-Mac show tree failed `tsc -b` with
   `IntelligenceUpdateButton.tsx(12,5): error TS2503: Cannot find namespace 'JSX'` (MQA-290); the
   button returns `ReactElement` and `tsconfig.app.json` loads React types. Tony's live 1.8.3 banner
   (`Intelligence dashboard bundle not found`) is the same miss on an app that never ran that build.
   `openIntelligenceWindow()` (`src/main/intelligence.ts`) looks for a built `intelligence/dist/index.html`
   in three candidate locations and returns `{ ok: false, error: 'Intelligence dashboard bundle not
   found — run npm run build:intelligence, then restart.' }` if none exist — it does not crash the app.

2. **The FFmpeg sidecar binaries are untracked.** `.gitignore` excludes the platform binaries below
   `resources/ffmpeg/` while preserving the tracked `manifest.json` trust anchor and LGPL license. A
   fresh clone has no FFmpeg binary. `bundledFfmpegPath()` (`src/main/ffmpeg-decoder.ts`) returns
   `null` when the platform/arch binary is missing — the app still runs; only the **import an audio
   file** feature silently can't decode. To get a binary locally for testing, see
   `docs/ENTERPRISE_RELEASE.md` → "ffmpeg Sidecar Provisioning", or copy one from a teammate's
   `resources/ffmpeg/<platform>-<arch>/` if the reviewed binaries are already checked out elsewhere.
   `scripts/check-ffmpeg-sidecar.mjs` (SHA-256-verified against `resources/ffmpeg/manifest.json`) is
   **only** invoked from `predist`/`dist`/`release*` scripts, never from `npm run dev` — dev never hard-fails
   on a missing sidecar.

3. **Runtime models are not fetched by `npm install`.** `npm run fetch-models` (`scripts/fetch-models.mjs`)
   provisions the reviewed on-device transcription payload (Whisper base + Parakeet TDT + ONNX runtime WASM)
   into `resources/models/`, `resources/asr/`, `resources/ort/`. It's idempotent (skips files already
   present before the final hash gate) and wired as `predist`/`prepack` so packaging always has them. Without
   running it, Listen still works in dev via a one-time CDN model download at runtime (see README's
   "Known gaps"); run `npm run fetch-models` once if you want the bundled-model path locally. The
   separate `npm run fetch:local-model` provisions the checksum-pinned Qwen3.5 0.8B payload, which exists so
   `check-local-model.mjs` can re-hash it and prove the byte length and SHA-256 pinned in
   `local-model-assets.mjs` are the real upstream file. Both are build-time operations, and neither ships:
   the ASR models are installer assets, but the LLM weights are fetched on first run by
   `src/main/llm/local-model-download.ts` (MQA-146) — an installed app does have a model downloader, and
   only for these.

**Secrets/config in dev vs. prod** (`src/main/secrets.ts`): in dev (`!app.isPackaged`) or when
`ASKTOTO_LOCAL_KEYSTORE` is set, secrets use a FILE backend — a per-install AES-256-GCM key persisted to
`<userData>/secret-key.bin` (mode `0o600`, wrapped with `safeStorage` when available, migrated in place
from older raw-key files) — specifically so macOS Keychain doesn't throw an "allow access" prompt on
every `npm run dev` rebuild (the app's code signature changes on every unsigned dev build, and Keychain
ties trust to the signature). Packaged builds default to the OS-native `safeStorage` backend (Keychain /
DPAPI / Linux secret-service) instead. Settings/keys live under `app.getPath('userData')`
(`src/main/store.ts`), encrypted with a versioned marker: `ATKENC2` (current, AES-GCM file backend),
`ATKENC1` (legacy `safeStorage`, migrated to `ATKENC2` on next write when running the file backend), or
unmarked legacy plaintext (migrated on next write). `app.getPath('userData')` resolves from the app name
in `package.json` (`"name": "asktoto"` — no `productName` field is set there, so this is the same in
dev and packaged builds); on macOS that's `~/Library/Application Support/asktoto`, on Windows
`%APPDATA%\asktoto`. Delete that directory for a clean-state test.

## 2. Run / test / debug workflows

```bash
npm run dev            # electron-vite dev — overlay running from source, hot-reloadable
npm run typecheck       # tsc --noEmit, both tsconfig.node.json (main/preload) and tsconfig.web.json (renderer)
npm test                # vitest run — see the test map below
npm run build           # electron-vite build → out/ (bytecode-compiled main, see §3)
npm run test:smoke:import  # builds, then runs scripts/smoke-import.mjs (playwright, packaged-app import smoke test)
```

**Logging** (`src/main/logger.ts`): main-process diagnostic logs go through `electron-log`, rotated at
5 MB, written to a file (mode `0o600`) under the OS-standard userData logs location; console output is
`'silly'`-level only when `NODE_ENV === 'development'`, otherwise silent. A **separate** append-only
audit log (`<userData>/logs/audit.log`, one JSON object per line, mode `0o600`) records only
security-relevant events (`auth.signin`, `key.set`, `capture.blocked`, `transcript.deleted`, etc. — see
the `AuditEvent` union in `logger.ts`) — metadata only, never message/transcript content. Don't confuse
the two logs when debugging.

**DevTools:** no window in `src/main/index.ts` or `src/main/intelligence.ts` calls
`webContents.openDevTools()`, and none of the three `webPreferences` blocks in the codebase set
`devTools: false` either — so DevTools are reachable via Electron's standard shortcut
(`Cmd+Opt+I` / `Ctrl+Shift+I`) but are not auto-opened on launch.

## 3. The one trap that will eat an afternoon: bytecode main bundle

`electron.vite.config.ts` runs the main-process bundle through electron-vite's `bytecodePlugin()` —
the shipped app carries **no readable main-process JS**, only compiled V8 bytecode (`out/main/index.jsc`).
V8 bytecode has no dynamic-import host callback, so **any** `await import(...)` in `src/main/**` throws
`A dynamic import callback was not specified.` at runtime.

This is invisible under `npm run dev` (runs source, not bytecode) and only breaks `npm run build` /
packaged builds — so it reproduces nowhere in your normal dev loop. It has already bitten several
features per the guard script's own comment (Dust/Spotlight, recap summary, SSO sign-in, MCP
connectors).

`scripts/check-no-dynamic-import.mjs`, wired as the `prebuild` script (runs automatically before
`npm run build`), statically scans `src/main/**/*.ts` (excluding `*.test.ts`) and hard-fails on any
`await import(...)` or `import(...)` in value position. Type-only `import('x').Type` positions are fine
(erased at compile time) and are not flagged.

**Rule: always use static top-level imports in `src/main/**`.** This restriction is main-process-only —
`src/preload/**` and `src/renderer/**` are NOT bytecode-compiled (a sandboxed preload and a Chromium
renderer can't load bytecode, per the config's own comment), so dynamic imports are fine there.

Corollary: main-process stack traces from a **packaged** build point at bytecode, not source — useless
for line-level debugging. Reproduce main-process bugs in `npm run dev` first.

## 4. Native dependencies

**sherpa-onnx (Parakeet on-device ASR).** `sherpa-onnx-node` is a native `.node` addon; its per-platform
binary ships as a separate optional package (`sherpa-onnx-darwin-arm64`, `-darwin-x64`, `-win-x64`,
`-linux-*`, …). `npm install`'s os/cpu-gated `optionalDependencies` resolution only installs the package
matching the **host** running the install — cross-building (e.g. `--win` from this macOS dev machine)
silently leaves the target's native addon missing, and electron-builder's `asarUnpack` glob then copies
whatever happens to be in `node_modules` regardless of target: the build exits 0 with no ASR addon for
that platform, and `src/main/parakeet.ts` falls back to Whisper with no build-time signal that anything
was wrong. `scripts/check-sherpa-platform.mjs` (wired into `check:sherpa` and every
`predist`/`dist`/`release*` script) hard-fails first, after attempting a safe, version-pinned
auto-provision (`npm install --no-save --force sherpa-onnx-<platform>-<arch>@<sherpa-onnx-node's own
version>`). No native compilation step is needed for local dev — prebuilt binaries ship as
platform-specific optional deps. Because native addons can't load from inside an `asar` archive,
`electron-builder.yml` excludes them via `asarUnpack: ['**/node_modules/sherpa-onnx-node/**',
'**/node_modules/sherpa-onnx-*/**']` — a dev debugging "works in `npm run dev`, fails once packaged" for
Parakeet specifically should look here first.

**ffmpeg sidecar.** Covered in §1 above for the dev-time behavior. At **build/package time**
(`scripts/check-ffmpeg-sidecar.mjs`, run from `predist`/`dist:local`/`release*`), the gate is hard: it
reads `resources/ffmpeg/manifest.json`, computes the target binary's SHA-256, and throws if the file is
missing or the hash doesn't match the reviewed manifest entry — packaging cannot silently ship an
unreviewed or tampered ffmpeg binary. Full provisioning steps (seeding the `ffmpeg-sidecar-v1` GitHub
release CI restores from): `docs/ENTERPRISE_RELEASE.md` → "ffmpeg Sidecar Provisioning".

**ONNX runtime / models.** `resources/ort/` (WASM runtime blobs, copied from `node_modules`, no network)
and `resources/models/` + `resources/asr/` (Whisper + Parakeet weights, downloaded) are populated by
`npm run fetch-models` (`scripts/fetch-models.mjs`) and bundled via `electron-builder.yml`'s
`extraResources`. All three are `.gitignore`d except tracked `.gitkeep` placeholders (needed so
electron-builder's `extraResources` config resolves against a real, if empty, directory in a fresh
clone).

## 5. IPC conventions

Every IPC channel name is a string constant in the `IPC` object (`src/shared/ipc.ts`) — never a literal
string at the call site. Payloads/responses are zod-validated. `ProviderIdSchema` carries a compile-time
parity guard against the `ProviderId` union in `src/shared/providers.ts` (a type-level assignment that
fails to typecheck if the two drift), so the provider list can't silently diverge between the schema and
the registry.

Every privileged `ipcMain.handle` in `src/main/index.ts` opens with `assertMainWindow(event)`, which
checks both that the sender is the main window's `webContents` *and* that the sending frame is the top
frame at the exact URL the main window has loaded — a compromised or unexpected sub-frame can't call
privileged IPC. A second guard, `assertBrainReader(event)`, additionally allows the separate Mantu
Intelligence dashboard window to call only the three read-only `brain:*` channels, via its own minimal
preload (`src/preload/intelligence.ts`) and a same-document URL check (`isIntelligenceSender()` in
`src/main/intelligence.ts`) — everything else stays main-window-only through `assertMainWindow`.
`requireAuth()` (`src/main/auth.ts`) additionally gates SSO-locked features.

**Checklist for a new IPC handler:** add the channel name as a constant in `IPC`, add a zod schema for
its payload/response, and call `assertMainWindow` (or `assertBrainReader` if it's one of the three
brain-read channels) as the first line of the handler.

**Renderer state.** `src/renderer/src/state.ts` is not a Redux/Zustand/Context store — it's a flat set
of custom hooks (`useAutoResize`, `useAsk`, `useSettings`, `useAuth`, `usePermissions`, …), each owning
its own IPC round-trips through the `window.toto` bridge exposed by `src/preload/index.ts`, composed
directly in `App.tsx`. There is no global store or reducer. `useAsk` batches streaming deltas via
`requestAnimationFrame` to avoid re-rendering on every SSE chunk. Extend renderer state by adding a new
hook in `state.ts`, not by introducing a state-management library.

## 6. Test map

`npm test` runs `vitest run` over `src/**/*.{test,spec}.{ts,tsx}` **and** `intelligence/src/**/*.{test,spec}.{ts,tsx}`
(`vitest.config.ts`) — one test command covers both the Electron app and the standalone dashboard
workspace.

- **Heaviest coverage:** `src/shared/**` (pure logic — `routing`, `redact`, `prompts`, `providers`,
  `quick-actions`, `wrapup`, `talkstats`, `transcript-filter`, `mars`, `perception`, `silence`, `ipc`)
  and `src/main/**` (`store`, `auth`, `transcripts`, `recall`, `graphify`, `dustcli`,
  `license`, `metrics`, `ffmpeg-decoder`, `import-jobs`, `import-audio`, `cli`/`cli-win`, `llm/*`,
  `brain/*`, `mcp/*`).
- **Renderer coverage is thin:** only `state.test.ts`, `components/RecallView.test.ts`, and a handful of
  `lib/` unit tests (`vad`, `keys`, `consent`, `transcript`, `import-audio`, `listen`, `entity-casing`)
  exist. Components like `Bar.tsx`, `Settings.tsx`, `Copilot.tsx`, and `App.tsx` have zero test coverage.
  `playwright` (a devDependency) is used only by `scripts/smoke-import.mjs`
  (`npm run test:smoke:import` — a single packaged-app import smoke test); there is no Playwright
  UI/E2E suite or config beyond that one script.
- **`intelligence/`:** `src/lib/{brainAdapter,ledgerstats,momentum,slug}.test.ts` — pure-TS lib tests,
  no DOM dependency, which is why the shared `environment: 'node'` vitest config covers them fine
  alongside the main app's tests.
- **`src/main/mcp/bidstackClient.test.ts` binds a real localhost TCP port.** It spins up an actual
  `node:http` server plus the MCP SDK's `StreamableHTTPServerTransport` to test
  `connectBidstack`/`pushToBidstack` end-to-end against a spec-faithful local mock — not a stub. It
  does **not** prove connectivity to a real BidStack instance (the test file's own header comment says
  so explicitly). This test needs the ability to bind a local port and will fail in a
  network-sandboxed CI/agent environment that blocks socket binds — that's an environment limitation,
  not a broken test.
- **Coverage reporting** (`vitest.config.ts`'s `coverage.include`) only instruments `src/main/**`,
  `src/shared/**`, `src/preload/**`. Renderer and `intelligence/` files are tested (per the `include`
  glob above) but never show up in the coverage report.

## 7. Packaging / release quick reference

Full runbook, signing setup, and the enterprise/customer checklist: **`docs/ENTERPRISE_RELEASE.md`**
and **`docs/SIGNING.md`**. This section is only the map of what exists.

```bash
npm run installers        # build the installer for this OS, print the installable files
npm run dist               # local macOS package (ad-hoc signed, not Developer ID/notarized)
npm run dist:win            # Windows package (unsigned unless WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD are set)
npm run release             # signed macOS build only; does not publish independently
npm run release:win          # signed Windows build only; does not publish independently
```

Only the `v<package-version>` tag workflow publishes. It waits for both native signed builds, verifies
their final packaged runtime payloads, uploads them to one draft, and makes that release public only
after the complete Mac + Windows asset set is present.

Every `predist*`/`dist*`/`release*` script chains `check-ffmpeg-sidecar.mjs` and
`check-sherpa-platform.mjs` before touching electron-builder — see §4 for what each checks.

`sherpa-onnx-node` and its per-platform packages are excluded from the `asar` via `asarUnpack` (§4);
native addons cannot load from inside an asar.

## 8. Known gotchas

- **This repo is developed inside a OneDrive-synced folder**
  (`~/Library/CloudStorage/OneDrive-MantuGroup/...`). `scripts/after-pack.mjs` strips
  OneDrive/Finder extended attributes from the packed app before signing, because `codesign` hard-rejects
  them ("resource fork … detritus not allowed" — OneDrive/CloudStorage stamps these on everything).
  Beyond the codesign issue, expect general OneDrive sync friction during development: file-lock
  contention or slower I/O in `out/`, `release/`, and `node_modules/` during `npm run dev`/`npm run
  build`, especially right after a sync event. `npm run dist:local` intentionally overrides
  `directories.output` to an OneDrive-free path
  (`/Users/tony/AI-Brain-build/asktoto-release`, per the script and the electron-builder.yml comment
  "Local rebuilds that need keychain-safe signing + an OneDrive-free output dir") — use the same pattern
  if OneDrive sync is causing you build flakiness.
- **Bytecode-compiled main process — dynamic `import()` fails only in built/packaged builds.** See §3.
  This is the single most common "works in dev, breaks in the build" bug in this codebase.
- **`bidstackClient.test.ts` binds a real local TCP port** and will fail under network-sandboxed
  CI/agent environments that block socket binds (see §6). If `npm test` fails only on this file in such
  an environment, that's expected — it is not evidence of a regression.
- **GitHub Actions billing was reported blocked on 2026-07-10.** That is mutable external state, so
  verify the current run before treating billing as the active cause of a failure. If a run still ends
  before its first step, the repository gates have not executed; use the local verification commands
  above and see `docs/MANTU-IT-REQUEST.md` for the recorded billing ask.
- **Node is pinned exactly.** `.nvmrc`, `.node-version`, `package.json#engines`, and both workflows use
  Node 22.22.3 (§1). Run `nvm use` before dependency or native-package work.
