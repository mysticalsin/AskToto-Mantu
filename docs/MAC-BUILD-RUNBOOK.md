# Building the macOS DMG

Everything a Mac needs to produce a Métis `.dmg`, in order, with nothing to figure out on the day.
Written 2026-08-18 against `v1.5.4` and verified command-by-command from the scripts themselves —
every claim below was checked, not assumed.

**Revalidated 2026-08-19 for `1.6.0` (`main` @ `f938aeb`).** What was re-checked, and how:

- Every one of the 17 scripts the mac chains invoke (`predist`, `dist`, `dist:local`,
  `release:build:mac`, `release:mas`) exists and parses (`node --check`). No chain names a script
  that is missing.
- Artifact names below were re-derived from `electron-builder.yml:127` (`artifactName:
  Metis-${version}.${ext}`, targets `dmg` + `zip`), not copied forward.
- The three entitlements files the mac and MAS configs reference all exist under `build/`.
- The **Windows** half of the same 1.6.0 tree was built end to end on this date: signed installers,
  `check:packaged-runtime` OK pre- and post-sign, `check:update-metadata` OK, and `check:launch`
  confirming the packaged app shows its window. That does not prove the mac build, but it does mean
  the shared steps (`build`, `build:intelligence`, `fetch-models`, the bytecode compile) are known
  good at this commit.

> **Not verified on macOS.** 1.6.0 carries 57 defect fixes (ledger `MQA-147`..`MQA-204`), several of
> which touch darwin-only branches — the dev-env gating of `ASKTOTO_DISABLE_CP` /
> `ASKTOTO_ESCROW_PUBKEY`, screen-preprocess OCR eligibility and `macHelperPresent()`, the boot
> sentinel, and overlay placement. All of it was authored and tested on Windows, so those branches
> are **unexercised**. Expect the build itself to work; smoke-test the app once it does.

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

## Path A — unsigned DMG (what you want for testing, and for 1.6.0 right now)

**No signing secrets required.** `npm run dist` passes `ASKTOTO_ADHOC_SIGN=1` and
`-c.mac.identity=null`, and `check-release-secrets` is *not* in this path (verified).

```bash
git clone <repo> && cd AskToto-Mantu
git checkout main            # 1.6.0 — there is no v1.6.0 TAG yet, see "Tagging" below
nvm use                      # honours .nvmrc → 22.22.3
npm ci
npm run dist                 # predist runs automatically first
```

> `git checkout v1.6.0` will fail today: the newest tag in the repo is `v1.5.4`. Build from `main`,
> or create the tag first (below). `package.json` decides the artifact version, not the tag — so a
> build from `main` is already a 1.6.0 build.

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
Metis-1.6.0.dmg          Metis-1.6.0.dmg.blockmap
Metis-1.6.0.zip          Metis-1.6.0.zip.blockmap
latest-mac.yml
```

Those names come from `electron-builder.yml:127` (`artifactName: Metis-${version}.${ext}`, targets
`dmg` and `zip`) interpolated with `package.json`'s `version`. Bump the version and the filenames
follow automatically — there is nothing to edit here per release.

An unsigned DMG triggers Gatekeeper on other machines — that is expected, and
`docs/INSTALL.md` covers the bypass for macOS 15+.

## Path B — signed, notarized release build

Adds Apple credentials and the notarization round trip. See `docs/SIGNING.md` for obtaining them.

```bash
npm run release:build:mac
```

This one *does* gate on `check-release-secrets mac` and `check:xcode`, and finishes with
`verify-signing --require-notarized`. Use it only when shipping publicly.

## Tagging and publishing 1.6.0

Unlike 1.5.4, **there is no v1.6.0 tag or release yet** — nothing to clobber, nothing stale to work
around. `main` carries `version: 1.6.0` (commit `f938aeb`).

Create the tag first. `scripts/check-version-parity.mjs` runs as the first step of the release
workflow and **fails the build** if the tag does not exactly match `package.json` — that gate exists
because electron-builder derives the published release from `package.json`, so a mismatched tag
publishes onto the OLD release and clobbers its assets:

```bash
git checkout main && git pull
node scripts/check-version-parity.mjs   # self-test: GITHUB_REF_NAME=v1.6.0 node scripts/…
git tag v1.6.0 && git push origin v1.6.0 && git push github v1.6.0
```

Then attach the Mac artifacts built above:

```bash
cd release
gh release create v1.6.0 --draft --title "v1.6.0" --repo mysticalsin/Metis-Releases \
  Metis-1.6.0.dmg Metis-1.6.0.dmg.blockmap \
  Metis-1.6.0.zip Metis-1.6.0.zip.blockmap \
  latest-mac.yml
```

If the draft already exists (CI got there first, or you are adding Mac assets to a release that
already has the Windows ones), upload into it instead — `--clobber` replaces same-named assets:

```bash
gh release upload v1.6.0 \
  Metis-1.6.0.dmg Metis-1.6.0.dmg.blockmap \
  Metis-1.6.0.zip Metis-1.6.0.zip.blockmap \
  latest-mac.yml \
  --repo mysticalsin/Metis-Releases --clobber
```

Verify before publishing the draft:

```bash
gh release view v1.6.0 --repo mysticalsin/Metis-Releases \
  --json assets --jq '.assets[] | "\(.createdAt)  \(.name)"'
```

Every asset should carry a date at or after the tag, and `latest-mac.yml` must read `version:
1.6.0` — a stale feed file is the one asset whose wrongness is invisible until clients fail to
update.

**Both platforms share one `v1.6.0` release, but two feed files.** `latest.yml` (Windows) and
`latest-mac.yml` (Mac) are written by their own builds; uploading one never updates the other. The
Windows assets for 1.6.0 — `Metis-Setup-1.6.0.exe`, `Metis-Portable-1.6.0.exe`, its `.blockmap` and
`latest.yml` — were built and verified on 2026-08-19 and live in `release/` on the Windows machine.

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
