# Install Métis

Métis ships as normal desktop installers:

- macOS: `.dmg`
- Windows: x64 setup `.exe`, plus a portable `.exe` for no-install testing

## Download And Install

1. Open the [Métis releases page](https://github.com/mysticalsin/Metis-Releases/releases). That is the
   PUBLIC feed the app itself updates from (`electron-builder.yml` → `publish`, `src/main/updater.ts`).
   The `AskToto-Mantu` source repo is private, so a link to its releases page 404s for everyone who
   is not a collaborator.
2. Download the latest file for your OS.
3. Install:
   - macOS: run the one-line install below — it needs no approval step. From the `.dmg`, open it and
     double-click `Install Metis.command` instead of dragging, and read the macOS section below first.
   - Windows: run `Metis-Setup-*.exe`.
   - Windows no-install test: run `Metis-Portable-*.exe`. The portable exe never auto-updates —
     electron-updater only supports the NSIS-installed app — so redownload it from the releases
     page for each new version.

Verification-only artifacts may show OS trust warnings. Tagged public releases fail closed unless both
platforms pass their production signing and identity-verification gates.

## macOS: installing on a Mac that has never run Métis

Métis is not yet Apple-notarized. macOS tags every file a **browser** downloads with
`com.apple.quarantine`; with no Apple-issued Developer ID signature to check against, Gatekeeper
reports it cannot verify the app — "Apple could not verify Métis is free of malware". It is a
missing-signature message, not a malware detection. On macOS 15 and later, Control-click → **Open**
no longer bypasses it (see `docs/MANTU-IT-REQUEST.md`), so the old advice does not work any more.

### The one-line install (no prompts at all)

```bash
curl -fsSL https://github.com/mysticalsin/Metis-Releases/releases/latest/download/install-metis.sh | bash
```

This is the recommended path for a fresh Mac. `curl` is not a quarantining application — the
quarantine tag is applied by the *downloading* app, and only browsers and other
`LSFileQuarantineEnabled` apps set it. So the disk image arrives untagged, the app copied out of it
is untagged, and **no Gatekeeper dialog appears at any point**. The script finds the latest release,
downloads the `.dmg`, mounts it, copies `Metis.app` to `/Applications` (falling back to
`~/Applications` when `/Applications` is read-only, as on a managed Mac), verifies the signature
still seals, and launches the app. Source: `scripts/install-metis-mac.sh`.

This is not a Gatekeeper bypass. Running the command *is* the trust decision, made once and up
front, instead of buried in System Settings.

### From the `.dmg`

Open the disk image and **double-click `Install Metis.command`**, which ships inside it next to the
app. It performs the same copy, quarantine-clear, verify and launch. Because the disk image itself
was downloaded in a browser, the script inherits the quarantine tag, so macOS will ask you to
approve it once (System Settings → Privacy & Security → **Open Anyway**) — one approval instead of
the multi-step dance below, and after it the app itself never prompts.

Dragging the app across by hand also works; you then approve the **app** the same way.

### Or one Terminal command, after installing by hand

```bash
xattr -dr com.apple.quarantine /Applications/Metis.app
```

`-r` matters: the nested helper bundles inside the bundle carry their own copies of the tag, and one
left behind still triggers the warning. None of these disable Gatekeeper system-wide; they mark this
one app as trusted, exactly as right-click → Open used to.

### Removing the message for everyone, permanently

That requires signing the app with an Apple Developer ID and notarizing it — see `docs/SIGNING.md`.
It needs a paid Apple Developer Program membership and the five release secrets
`scripts/check-release-secrets.mjs mac` enforces (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). With those set, `npm run release:build:mac`
produces a build that installs on any Mac with no warning and no extra step, and neither installer
script above is needed.

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
