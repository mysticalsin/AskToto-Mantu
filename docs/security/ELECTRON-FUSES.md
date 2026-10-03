# Electron fuses of the shipped builds

Ticket M2-0558. Electron fuses are bits in the packaged Electron binary that switch off runtime features. Until this change no
fuse was set, so every shipped DMG and Setup kept Electron's defaults: `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and the Node
`--inspect` flags were all honoured. The readiness diagnosis of 1.9.6 observed the packaged app loading a `NODE_OPTIONS --require`
module under `ELECTRON_RUN_AS_NODE` (freeze-repro fuse probe, M2-0557). On macOS any local process could then run code as Metis
and inherit its Screen Recording and Microphone grants.

## Declared state

The state lives in the electron-builder configs. `scripts/build/electron-fuses.mjs` reads it and CI fails when a packaged app
differs from it.

| Fuse | Shipped macOS DMG/ZIP and Windows Setup/portable (`electron-builder.yml`, `electron-builder.win.yml` extends it) | QA-identity variant (`build/qa-identity.electron-builder.yml`) |
|---|---|---|
| `RunAsNode` | **on**, until the owner decides (see below) | on |
| `EnableNodeOptionsEnvironmentVariable` | **off** | off |
| `EnableNodeCliInspectArguments` | **off** | **on**: the QA driver (ST-1 and other inspector-driven harnesses) measures inside main through `--inspect` |
| `EnableEmbeddedAsarIntegrityValidation` | **on** | on |
| `OnlyLoadAppFromAsar` | **on** | on |
| `EnableCookieEncryption`, `LoadBrowserProcessSpecificV8Snapshot`, `GrantFileProtocolExtraPrivileges` | not declared: Electron's default | not declared |

Asar integrity is supported on both targets by the packager in use (electron-builder 26.15.3, Electron 43.6.0). electron-builder
writes the `app.asar` header hash into `Info.plist`, where the universal merge (`@electron/universal`) recomputes it, and into the
Windows executable's resources.

**Where the fuses are flipped.** electron-builder flips `electronFuses` after the `afterPack` hook and before its own signing
step. That order is right for Windows and for Developer ID releases. The ad-hoc and QA-identity mac chains (`ASKTOTO_ADHOC_SIGN=1`)
sign inside `scripts/after-pack.mjs`, so that hook applies the same declared fuses itself just before its `codesign`. Without that,
the later flip would land after the seal. electron-builder's own pass then rewrites identical bytes.

## Inventory of product uses

Searched on `m2/integration` at `4ef9cf74` with `git grep -n -E "ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|--inspect|inspect-brk|SIGUSR1|node:inspector"`
over `src/`, `native-app/`, `native/`, `intelligence/`, the builder configs, `build/` and `package.json`, excluding tests. Line
numbers are the same on this branch.

### `ELECTRON_RUN_AS_NODE`: used. Electron's own binary is the bundled Node runtime for the managed CLIs

| Location | What it does | Runs in a packaged build |
|---|---|---|
| `src/main/cli.ts:433` (`resolveSpawnTarget`, doc at `:426`) | Spawns an in-app managed CLI entry script (a `.js` file under `managed-cli/`) as `process.execPath` with `ELECTRON_RUN_AS_NODE=1`. Callers: `runCliStream` (`src/main/cli.ts:666`), `detectCli` (`:832`), `checkCliSession` (`:948`), `testCli` (`:1068`) and the Dust status refresh (`src/main/dustcli.ts:150`) | Yes, for the managed Claude Code and Codex CLIs |
| `src/main/cli-installer.ts:489` (`managedCliCommand`, doc at `:473`, module doc at `:9`) | Returns `process.execPath` + `ELECTRON_RUN_AS_NODE=1` for a managed CLI. Dust uses the shipped portable Node instead when it is present | Yes, for Claude Code and Codex |
| `src/main/cli.ts:1579` and `:1582` (`loginCliInvokeLines`, caller `loginCli` at `:1616`) | Writes the env of `managedCliCommand` into the Terminal/console login script (`set ELECTRON_RUN_AS_NODE=1` on Windows, an env prefix on macOS), so the login runs the same way | Yes |
| `src/main/cli-installer.ts:698` (`planNpmInstallSpawn`, caller `npmInstallProductionSpawn` at `:701`) | Fallback: runs npm under Electron-as-Node only when no portable Node exists | No: both installers ship `resources/managed-node` |
| `src/main/dust-cli-chat.ts:142` (`planManagedDustSpawn`), `:248`, `:254` | Fallback: runs the Dust CLI and its keytar seed script under Electron-as-Node only when no portable Node exists | No: same reason |
| `src/main/managed-node.ts:4` | Comment only. It explains why Dust needs a real Node ABI (keytar) | — |

Outside the product: `scripts/ensure-electron-runtime.mjs:237` checks the development Electron download after `npm install`.
`scripts/qa/freeze-repro/run-matrix.sh:402` is the M2-0557 fuse probe.

### `NODE_OPTIONS` (and `NODE_EXTRA_CA_CERTS`, which the same fuse governs): no product use

The search finds no product reference. Every match is in tests, hermetic test tooling (`scripts/hermetic/deny-non-loopback.cjs`)
or the M2-0557 probe. One effect follows from the fuse's documented behaviour (DERIVED): a user- or admin-set
`NODE_EXTRA_CA_CERTS` no longer adds trust roots to Node networking in the main process. Chromium networking keeps using the OS
trust store.

### Node inspect flags (`--inspect`, `--inspect-brk`, `SIGUSR1`): no product use

There is no product use. The QA harnesses that drive main through the inspector are the only users:

| Harness | Target | How it keeps working |
|---|---|---|
| `scripts/qa/st-1.mjs:301` | QA-identity candidate (macOS) | The QA-identity config keeps the inspect fuse on |
| `scripts/qa/st-1.mjs:301` | Installed Windows candidate (ST-1-W, BLOCKED_EXTERNAL: managed QA laptop) | The recorded unblock step in `qa-candidate.yml` runs `electron-fuses.mjs set` on the installed copy first |
| `scripts/check-packaged-asr.mjs` (Playwright `_electron.launch`, release gate in `dist:win` and the release orchestrator) | `release/win-unpacked/Metis.exe` | The gate launches `Metis-asr-gate.exe`, a copy written beside the shipped executable with only the inspect fuse on (`harnessCopy`), and deletes it afterwards. The copy shares the shipped resources, `app.asar` and integrity resource. The shipped executable and the installers built from it are never modified |
| `scripts/qa/packaged-smoke.mjs:534` (OV-STABLE and RE-HIDE rows) | Shipped build in `packaged-smoke.yml`, macOS and Windows | That workflow turns the fuse on in the installed copy only (`electron-fuses.mjs set`), after the shipped signature was verified. It re-seals the macOS copy ad hoc |
| `scripts/qa/history-design-capture.mjs:500` | Promotable DMG in `qa-candidate.yml` (`history-design-mac`) | Same installed-copy change, after the DMG was verified against the provenance |

`--remote-debugging-port`, which every harness also passes, is a Chromium switch. No fuse governs it. `scripts/smoke-import.mjs`
can be pointed at a packaged executable by hand (`ASKTOTO_SMOKE_EXECUTABLE`), but no lane does that. Against a shipped build it
needs a harness copy too.

## RunAsNode: owner decision pending

RunAsNode stays on because the managed Claude Code and Codex CLIs need it (table above). Turning it off without a replacement
runtime would break them. The owner chooses one of two options, and the choice is recorded in the program's decision log:

1. **Move the CLI runtime off `ELECTRON_RUN_AS_NODE`, then turn RunAsNode off.** The options are Electron `utilityProcess`, or the
   portable Node that both installers already ship for Dust (`resources/managed-node`, `src/main/managed-node.ts`).
2. **Keep RunAsNode on** and write the residual risk into the program's threat model.

Residual risk while RunAsNode is on (DERIVED from Electron's fuse documentation; not measured on a TCC-granted host): with
`NODE_OPTIONS` and `--inspect` off, a local process can no longer inject code into a Metis it launches as an app. It can still run
`ELECTRON_RUN_AS_NODE=1 <Metis executable> -e '<script>'`, and that script executes as the signed Metis binary. On macOS it may
therefore be attributed to Metis's TCC grants. The portable Node in option 1 is a separately signed executable with its own code
identity.

The M2-0557 freeze-repro probe sets both `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS`. On a candidate built with this change it
reports `DISABLED_OR_UNAVAILABLE` in `node-options-fuse.json`. It reports the same once RunAsNode is off too. The per-fuse state
comes from the CI check below.

## Verification

| Where | What |
|---|---|
| `build.yml` jobs `build-macos` and `build-windows` (every PR) | `node scripts/build/electron-fuses.mjs check` against `release/mac-universal/Metis.app` (both universal slices) and `release/win-unpacked/Metis.exe`. Uploads `electron-fuses-macos` / `electron-fuses-windows` |
| `qa-candidate.yml` jobs `build-mac` (both variants) and `build-win` | The same check against each candidate, each with its own config. Uploads `electron-fuses-<variant>` |
| `freeze-repro.yml` on the next candidate | `node-options-fuse.json` reports `DISABLED_OR_UNAVAILABLE` |
| `scripts/build/electron-fuses.test.ts`, `scripts/after-pack.test.ts` | Wire parsing, the declared state of the three real configs, and fuses flipped before the ad-hoc seal |
