# Install Métis

Métis ships as normal desktop installers:

- macOS: `.dmg`
- Windows: x64 setup `.exe`, plus a portable `.exe` for no-install testing

## Download And Install

1. Open the [Métis releases page](https://github.com/mysticalsin/AskToto-Mantu/releases).
2. Download the latest file for your OS.
3. Install:
   - macOS: open the `.dmg`, drag Métis to Applications, then open Métis.
   - Windows: run `Metis-Setup-*.exe`.
   - Windows no-install test: run `Metis-Portable-*.exe`. The portable exe never auto-updates —
     electron-updater only supports the NSIS-installed app — so redownload it from the releases
     page for each new version.

Verification-only artifacts may show OS trust warnings. Tagged public releases fail closed unless both
platforms pass their production signing and identity-verification gates.

## macOS: "Apple could not verify Métis is free of malware"

This appears on any build that is not Apple-notarized. macOS tags every downloaded or cloud-synced file
with a `com.apple.quarantine` attribute; with no Apple-issued Developer ID signature to check against,
Gatekeeper reports it cannot verify the app. It is a missing-signature message, not a malware detection.
Pick whichever fits:

**Double-click `Install Metis.command`** (shipped next to the `.dmg`). It copies Métis to `/Applications`,
clears the quarantine tag, verifies the signature still seals, and opens the app. One step, no Terminal.

**Or right-click once.** Control-click Métis in Finder, choose **Open**, then confirm. This uses a
different trust path than double-clicking and works even while `spctl` reports the app as rejected. Only
needed on first launch. (If macOS offers no Open button, use System Settings → Privacy & Security, find
the blocked-app notice, and click **Open Anyway**.)

**Or one Terminal command:**

```bash
xattr -dr com.apple.quarantine /Applications/Metis.app
```

`-r` matters: the nested helper apps inside the bundle carry their own copies of the tag, and one left
behind still triggers the warning. None of these disable Gatekeeper system-wide; they mark this one app
as trusted, exactly as right-click → Open does.

**Removing the message for everyone, permanently**, requires signing the app with an Apple Developer ID
and notarizing it — see `docs/SIGNING.md`. That needs a paid Apple Developer Program membership and the
five release secrets `scripts/check-release-secrets.mjs mac` enforces (`CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). With those set, `npm run release:build:mac`
produces a build that installs on any Mac with no warning and no extra step.

## Build Installers Locally

From the repo root:

```bash
npm ci
npm run installers
```

That builds the installer for your current OS and prints the files created in `release/`.
On macOS, this runs `npm run check:xcode` first and verifies the selected Xcode toolchain,
macOS SDK, `codesign`, `productbuild`, `notarytool`, and `stapler`.

Local macOS installer builds use a complete ad-hoc signature by default, avoiding keychain prompts while
still supporting packaged-runtime launch checks. To use an available Developer ID identity instead:

```bash
ASKTOTO_SIGN_INSTALLER=1 npm run installers:mac
```

Use that only when the signing identity is already available locally. Customer releases should use `npm run release`.

Explicit targets:

```bash
npm run installers:mac
npm run installers:win
npm run installers:all
```

Use GitHub Actions for the cleanest two-platform build: macOS runners build the `.dmg`/`.zip`; Windows
runners build the setup `.exe`, portable `.exe`, and AppX package. Actions billing was reported blocked
on 2026-07-10; verify the current run before treating that mutable external state as today's blocker
(see `docs/ENTERPRISE_RELEASE.md`).

## Publish For Auto-Update

After signing secrets are configured, bump `package.json`'s `version` first, then tag and push
`v<that version>` exactly — the release workflow's first step rejects any tag that doesn't match
`package.json` exactly. See `docs/ENTERPRISE_RELEASE.md`'s Operator Setup (step 9) for the full
release checklist and current CI blockers.

The Release workflow publishes signed installers to `mysticalsin/AskToto-Mantu`. Installed direct-release apps then update from that feed — except the Windows portable exe, which has no update mechanism (see above).
