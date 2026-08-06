# Enterprise Release Checklist - Métis

Use this before any customer build or public tag.

**External-state check required:** a 2026-07-10 observation recorded GitHub Actions runs ending before
their first step because of an organization billing block. Re-check the current run before naming that
as today's cause; repository code cannot prove mutable GitHub billing or secret state. If it recurs,
none of the gates below execute. See `docs/MANTU-IT-REQUEST.md` for the recorded Mantu IT ask.

## Verified In Repo

- Direct macOS updates publish through GitHub Releases in `electron-builder.yml`.
- Direct Windows updates publish through the same feed.
- macOS and Windows tagged release scripts fail if signing inputs are missing.
- `scripts/verify-signing.mjs` checks the produced artifacts on the current platform.
- Machine-wide managed config can lock SSO, license server, license gate, provider policy, encryption, redaction, and retention.
- The license server supports activation, heartbeat, revocation, expiry, and seat caps.

## Operator Setup

1. Deploy `license-server/` behind HTTPS.
2. Set a long random `LICENSE_ADMIN_TOKEN`.
3. Back up `licenses.json` daily.
4. Mint the customer license and seat cap.
5. Fill `build/managed-config.enterprise.example.json`.
6. Deploy the filled file as machine-wide `managed-config.json`.
7. Add release secrets in GitHub Actions.
8. Seed the `ffmpeg-sidecar-v1` release once (see "ffmpeg Sidecar Provisioning" below) — release CI cannot
   build without it.
9. Bump `package.json`'s `version`, then tag `vX.Y.Z` from `main` — the tag must exactly match, or
   `release.yml`'s first step fails the job before any build work starts.
10. Verify install, activation, heartbeat, revoke, and auto-update on a clean machine.

## ffmpeg Sidecar Provisioning

The reviewed platform binaries under `resources/ffmpeg/` are untracked, but their hash-pinned
`manifest.json` and LGPL license are tracked in git. `.github/workflows/build.yml` and `release.yml`
restore the binaries from this repo's `ffmpeg-sidecar-v1` GitHub release, with `actions/cache` as an
optimization; the tracked manifest remains the verification trust anchor. Seed the release once from a
checkout that already has the reviewed binaries:

```bash
cp resources/ffmpeg/darwin-arm64/ffmpeg /tmp/ffmpeg-darwin-arm64
cp resources/ffmpeg/win32-x64/ffmpeg.exe /tmp/ffmpeg-win32-x64.exe
gh release create ffmpeg-sidecar-v1 \
  /tmp/ffmpeg-darwin-arm64 /tmp/ffmpeg-win32-x64.exe \
  resources/ffmpeg/manifest.json resources/ffmpeg/LICENSE.LGPL-2.1.txt \
  --repo <owner>/<repo> --title "ffmpeg sidecar v1" \
  --notes "Reviewed LGPL-only ffmpeg binaries for CI provisioning (see manifest.json for SHA256s)."
```

Re-run this (deleting the old release first, `gh release delete ffmpeg-sidecar-v1 --repo <owner>/<repo>`)
only if the reviewed binaries themselves change — CI's `scripts/check-ffmpeg-sidecar.mjs` verifies the
downloaded binary's SHA256 against `manifest.json` regardless of how it was provisioned.

### Building the macOS sidecar

**Never seed a macOS binary copied from a package manager or from a build that picked up locally
installed libraries.** A binary built on a Mac that has Homebrew links Homebrew's dylibs by absolute
path, runs perfectly on that Mac, and then fails on every user's machine with `Library not loaded`.
This shipped once: the seeded asset linked `/opt/homebrew/opt/sdl2/lib/libSDL2-2.0.0.dylib`, matched
its reviewed SHA-256, and aborted under dyld on the CI runner.

Build it from source instead — on a Mac, from a clean checkout:

```bash
./scripts/build-ffmpeg-sidecar-mac.sh arm64
```

The script verifies the FFmpeg source tarball against the reviewed SHA-256, configures with
`--disable-gpl --disable-nonfree --disable-autodetect` (the last flag is what stops configure linking
whatever it finds on the build machine), confirms with `otool -L` that the result links nothing outside
`/usr/lib` and `/System/Library`, checks the LGPL banner, ad-hoc signs it, and prints the new SHA-256
plus the exact re-seed commands. Record that hash and the configure flags in
`resources/ffmpeg/manifest.json`, then re-upload the asset:

```bash
gh release upload ffmpeg-sidecar-v1 /tmp/ffmpeg-darwin-arm64 --clobber --repo <owner>/<repo>
```

`check-ffmpeg-sidecar.mjs` independently reads the Mach-O load commands and fails the build if the
sidecar declares any non-system dylib, so a non-portable binary cannot reach a release even if it was
seeded by mistake. That check runs from any host, so `node scripts/check-ffmpeg-sidecar.mjs mac arm64`
is a valid pre-flight from a Windows or Linux checkout too.

## Sherpa (Native ASR) Provisioning

`sherpa-onnx-node` (the native Parakeet on-device ASR addon) ships as per-platform optional npm
packages (`sherpa-onnx-darwin-arm64`, `-win-x64`, etc.). `scripts/check-sherpa-platform.mjs` is wired
into every relevant npm script (`release`, `release:win`, `release:mas`, `release:win:store`,
`installers*`, `dist:local`, `predist:win`) and hard-fails the build if the target platform's addon
package isn't present, after first attempting an auto-provision (`npm install --force`). If
auto-provision fails (no network access, or the package genuinely isn't published for that
platform/arch), build on a native host or CI runner matching the target platform instead — there is
no manual seeding step for this one, unlike the ffmpeg sidecar above.

## Release CI Gates

- `scripts/check-version-parity.mjs` runs first in every release job: the pushed tag must equal
  `v<package.json version>` exactly, and (best-effort) must not already exist as a release — otherwise
  electron-builder would publish onto/overwrite an existing release instead of creating a new one.
- `release-verify` (needs both `release-macos` and `release-windows`) checks that the resulting GitHub
  release actually has both platforms' installers + `latest*.yml` metadata, and marks it draft if not —
  a single-platform failure must never leave a half-published release live.

## Direct Release Commands

macOS:

```bash
npm run release
```

Windows:

```bash
npm run release:win
```

Windows releases are not deferred or allowed to publish unsigned. The tagged workflow fails closed
unless `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, and `WIN_CSC_EXPECTED_SUBJECT` are provisioned, then
verifies that the Authenticode certificate subject or common name matches that expected value exactly.

## Store Release Commands

Mac App Store:

```bash
MAS_PROVISIONING_PROFILE="/secure/path/Métis_AppStore.provisionprofile" npm run release:mas
```

Microsoft Store:

```bash
npm run release:win:store
```

## Customer Control Proof

Before shipping, demonstrate:

- A fresh install blocks when `licenseGateEnabled` is true and no license is activated.
- A valid license activates and consumes exactly one seat.
- A second machine consumes a second seat.
- Seat cap blocks the next machine.
- Revocation blocks the activated machine on the next online check.
- Offline grace expires after the configured hard cap in code.
- Managed config prevents user edits to locked keys.
- Auto-update installs a newer signed direct-release build.

## Store Caveat

Mac App Store builds must pass sandbox testing and Apple review. Métis's overlay, screen/system-audio capture, local CLI providers, and native ASR resources are all review-sensitive. Treat MAS as a separate Store profile, not a guarantee that the full direct build will be accepted unchanged.
