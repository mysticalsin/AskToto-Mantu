# Building the macOS DMG

Everything a Mac needs to produce a Métis `.dmg`, in order, with nothing to figure out on the day.
Written 2026-08-18 against `v1.5.4` (`main` @ `9b3ea10`) and verified command-by-command from the
scripts themselves — every claim below was checked, not assumed.

## Why this file exists

The Windows installer can be built anywhere; the Mac one cannot. `main` compiles to V8 bytecode
(`electron.vite.config.ts` → `bytecode: true`), and V8 only accepts cached data produced by the same
V8 build — `docs/WINDOWS.md` states the rule and says outright there is no flag to relax it. On top of
that the packaging chain compiles a **Swift** sidecar and needs Apple's toolchain for the DMG itself.
So this is a macOS-only job, and this file is the whole of it.

## Do NOT pre-stage the Mac binaries from Windows

Tempting, and it does not work. `node scripts/fetch-llama-server.mjs mac` on Windows fails while
unpacking, because Windows `tar.exe` cannot create the mac `.dylib` entries:

```
llama-b9957/libggml-cpu.0.dylib: Can't create '...': Invalid argument
fetch-llama-server FAILED
```

(Verified on this repo, 2026-08-18.) Nothing needs staging anyway — `predist` downloads everything
downloadable, on the Mac, by itself. Start from a clean clone.

## Prerequisites

| What | Why | Check |
|---|---|---|
| macOS (Apple Silicon or Intel) | the target, and the only host that can produce it | — |
| **Xcode command line tools** | `swiftc` + `lipo` + `xcrun` build the mac-helper; `hdiutil`/`codesign` make and validate the DMG | `xcode-select -p` |
| **Node 22.22.3** exactly | pinned in `engines`, `.nvmrc` and `.node-version`; `release-gates.test.ts` asserts CI uses the same | `node -v` |
| ~10 GB free disk | 3.2 GB of sidecars + a universal package + the DMG | — |

`scripts/check-xcode-tools.mjs` fails early and actionably if the toolchain is missing — it is only
wired into the *signed release* path, so for an unsigned build you find out when `swiftc` is invoked.
Install the tools first and neither matters:

```bash
xcode-select --install
```

## Path A — unsigned DMG (what you want for testing, and for 1.5.4 right now)

**No signing secrets required.** `npm run dist` passes `ASKTOTO_ADHOC_SIGN=1` and
`-c.mac.identity=null`, and `check-release-secrets` is *not* in this path (verified).

```bash
git clone <repo> && cd AskToto-Mantu
git checkout v1.5.4          # or: git checkout main
nvm use                      # honours .nvmrc → 22.22.3
npm ci
npm run dist                 # predist runs automatically first
```

`predist` self-provisions, in this order, before packaging starts:

```
check-ffmpeg-sidecar mac arm64 / x64     provision-mac-natives
check-sherpa-platform mac arm64 / x64    provision-electron-dist
fetch-llama-server mac  → check-llama-sidecar mac
build-mac-helper        → check-mac-helper mac      ← the Swift compile
fetch-local-model       → check-local-model
fetch-speaker-model     fetch-models                build:intelligence
```

Then `dist` itself runs:

```
check:main-imports                    bytecode safety (no dynamic import in src/main)
build                                 electron-vite → out/ (main compiled to .jsc)
electron-builder --mac --universal    the package, arm64 + x64
check-packaged-runtime mac            exact reviewed Qwen/ASR/llama/ffmpeg/sherpa + arch
check-update-metadata latest-mac.yml  the update feed matches what was built
```

Output lands in `release/`:

```
Metis-1.5.4.dmg          Metis-1.5.4.dmg.blockmap
Metis-1.5.4.zip          Metis-1.5.4.zip.blockmap
latest-mac.yml
```

An unsigned DMG triggers Gatekeeper on other machines — that is expected, and
`docs/INSTALL.md` covers the bypass for macOS 15+.

## Path B — signed, notarized release build

Adds Apple credentials and the notarization round trip. See `docs/SIGNING.md` for obtaining them.

```bash
npm run release:build:mac
```

This one *does* gate on `check-release-secrets mac` and `check:xcode`, and finishes with
`verify-signing --require-notarized`. Use it only when shipping publicly.

## Attaching the result to the v1.5.4 release

A `v1.5.4` **draft** already exists on both `mysticalsin/AskToto-Mantu` and
`mysticalsin/Metis-Releases`, and the Windows assets on it were refreshed on 2026-08-18 from
`main` @ `9b3ea10`.

> **The Mac assets on that draft are stale.** `Metis-1.5.4.dmg` and `Metis-1.5.4.zip` there were built
> **2026-08-11**, which is **36 commits and 11 security fixes** before the current tag. They must be
> replaced, not published. Same for `latest-mac.yml`, whose hashes point at that old build.

```bash
cd release
gh release upload v1.5.4 \
  Metis-1.5.4.dmg Metis-1.5.4.dmg.blockmap \
  Metis-1.5.4.zip Metis-1.5.4.zip.blockmap \
  latest-mac.yml \
  --repo mysticalsin/Metis-Releases --clobber
```

`--clobber` is what replaces the stale ones. Verify before publishing the draft:

```bash
gh release view v1.5.4 --repo mysticalsin/Metis-Releases \
  --json assets --jq '.assets[] | "\(.createdAt)  \(.name)"'
```

Every asset should carry a date at or after the tag — anything still showing 2026-08-11 is the old
build and has not been replaced.

## If CI is meant to do this instead

`.github/workflows/build.yml` has a `build-macos` job on `macos-latest` that uploads the DMG as the
`metis-macos` artifact, and `release.yml` builds and publishes on a `v*` tag. Both were blocked as of
2026-08-18 by an account-level Actions spending limit — GitHub refuses to start any job with *"The job
was not started because an Actions budget is preventing further use."* Lift the limit at
**github.com/settings/billing**, then either push the tag again or:

```bash
gh workflow run "Build & Test" --ref main
gh run download <run-id> -n metis-macos
```

`scripts/ci-cost-gates.contract.test.ts` keeps the packaging jobs off every feature-branch push so the
allowance is not drained again; `workflow_dispatch` above is deliberately still allowed.
