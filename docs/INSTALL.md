# Install Métis

Métis ships as normal desktop installers:

- macOS (Electron): `.dmg` — the cross-platform overlay app
- macOS (native): `Metis-Native-*.zip` — pure SwiftUI Apple Intelligence app (`native-app/`); unzip and open `Metis.app`
- Windows: x64 setup `.exe`, plus a portable `.exe` for no-install testing

## Download And Install

1. Open the [Métis releases page](https://github.com/mysticalsin/Metis-Releases/releases). That is the
   PUBLIC feed the app itself updates from (`electron-builder.yml` → `publish`, `src/main/updater.ts`).
   The `AskToto-Mantu` source repo is private, so a link to its releases page 404s for everyone who
   is not a collaborator.
2. Download the latest file for your OS.
3. Install:
   - macOS Electron: run the one-line install below — it needs no approval step. From the `.dmg`, open it and
     double-click `Install Metis.command` instead of dragging, and read the macOS section below first.
   - macOS native (SwiftUI): download `Metis-Native-*.zip`, unzip, open `Metis.app`. This is a separate
     Apple-Intelligence product — not the Electron DMG.
   - Windows: run `Metis-Setup-*.exe`.
   - Windows no-install test: run `Metis-Portable-*.exe`. The portable exe never auto-updates —
     electron-updater only supports the NSIS-installed app — so redownload it from the releases
     page for each new version.

Verification-only artifacts may show OS trust warnings. Tagged public releases fail closed unless both
platforms pass their production signing and identity-verification gates.

## macOS: installing on a Mac that has never run Métis

Métis is not yet Apple-notarized. macOS tags every file a **browser** downloads with
`com.apple.quarantine`; with no Apple-issued Developer ID signature to check against, Gatekeeper
reports it cannot verify the app. It is a missing-signature message, not a malware detection. On
macOS 15 and later, Control-click → **Open** no longer bypasses it, so the old advice does not work.

### The one-line install (no prompts at all)

```bash
curl -fsSL https://github.com/mysticalsin/Metis-Releases/releases/latest/download/install-metis.sh | bash
```

Recommended for a fresh Mac. `curl` is not a quarantining application — the tag is applied by the
*downloading* app, and only browsers and other `LSFileQuarantineEnabled` apps set it. So the disk
image arrives untagged, the app copied out of it is untagged, and **no Gatekeeper dialog appears at
any point**. Source: `scripts/install-metis-mac.sh`.

This is not a Gatekeeper bypass. Running the command *is* the trust decision, made once and up front
instead of buried in System Settings.

### From the `.dmg`

Open the disk image and **double-click `Install Metis.command`**, which ships inside it next to the
app. Same copy, quarantine-clear, verify and launch. Because the image itself was downloaded in a
browser the script inherits the quarantine tag, so macOS asks you to approve it once (System
Settings → Privacy & Security → **Open Anyway**) — one approval, after which the app never prompts.

### Or one Terminal command, after installing by hand

```bash
xattr -dr com.apple.quarantine /Applications/Metis.app
```

`-r` matters: the nested helper bundles carry their own copies of the tag, and one left behind still
triggers the warning.

### Removing the message for everyone, permanently

Sign with an Apple Developer ID and notarize — see `docs/SIGNING.md`. With the five release secrets
set, `npm run release:build:mac` produces a build that installs on any Mac with no warning and
neither installer script above is needed.

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

The Release workflow publishes signed installers to `mysticalsin/Metis-Releases`, not to this source
repo. `release.yml` derives the publish target by reading `owner:`/`repo:` out of
`electron-builder.yml`'s `publish` block, which names `mysticalsin/Metis-Releases` — the same public
feed `src/main/updater.ts` polls. `AskToto-Mantu` is private, so nothing installed could ever have
updated from it. Installed direct-release apps update from that public feed — except the Windows
portable exe, which has no update mechanism (see above).
