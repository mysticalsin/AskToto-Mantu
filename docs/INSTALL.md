# Install Métis

Métis ships as normal desktop installers:

- macOS: `.dmg`
- Windows: x64 setup `.exe`, plus a portable `.exe` for no-install testing

## Download And Install

1. Open the [AskToto releases page](https://github.com/mysticalsin/AskToto-Releases/releases).
2. Download the latest file for your OS.
3. Install:
   - macOS: open the `.dmg`, drag Métis to Applications, then open Métis.
   - Windows: run `Metis-Setup-*.exe`.
   - Windows no-install test: run `Metis-Portable-*.exe`. The portable exe never auto-updates —
     electron-updater only supports the NSIS-installed app — so redownload it from the releases
     page for each new version.

The first public builds may show OS trust warnings until Tony's production signing certificates are configured. The release pipeline now refuses tagged direct releases when required signing inputs are missing.

## Build Installers Locally

From the repo root:

```bash
npm ci
npm run installers
```

That builds the installer for your current OS and prints the files created in `release/`.
On macOS, this runs `npm run check:xcode` first and verifies the selected Xcode toolchain,
macOS SDK, `codesign`, `productbuild`, `notarytool`, and `stapler`.

Local macOS installer builds skip signing by default so they do not hang on keychain prompts:

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

Use GitHub Actions for the cleanest two-platform build: macOS runners build the `.dmg`/`.zip`; Windows runners build the setup `.exe`, portable `.exe`, and AppX package. **Currently blocked**: Actions runners on this repo are billing-blocked, so no CI build runs until that's fixed (see `docs/ENTERPRISE_RELEASE.md`). Build locally in the meantime.

## Publish For Auto-Update

After signing secrets are configured, bump `package.json`'s `version` first, then tag and push
`v<that version>` exactly — the release workflow's first step rejects any tag that doesn't match
`package.json` exactly. See `docs/ENTERPRISE_RELEASE.md`'s Operator Setup (step 9) for the full
release checklist and current CI blockers.

The Release workflow publishes signed installers to `mysticalsin/AskToto-Releases`. Installed direct-release apps then update from that feed — except the Windows portable exe, which has no update mechanism (see above).
