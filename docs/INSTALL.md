# Install Métis

Métis ships as normal desktop installers:

- macOS (Electron): `.dmg` — the cross-platform overlay app
- Windows: x64 setup `.exe`; the portable `.exe` is a QA-only, non-updating build

## Download And Install

1. Open the [Métis releases page](https://github.com/mysticalsin/Metis-Releases/releases). That is the
   PUBLIC feed the app itself updates from (`electron-builder.yml` → `publish`, `src/main/updater.ts`).
   The `AskToto-Mantu` source repo is private, so a link to its releases page 404s for everyone who
   is not a collaborator.
2. Download the latest file for your OS.
3. Install:
   - macOS Electron: open the Developer ID-signed, notarized `.dmg` and drag Métis to Applications.
   - Windows: run `Metis-Setup-*.exe`.
   - Windows Portable builds (`Metis-Portable-*.exe`) are QA-only artifacts. They never
     auto-update because electron-updater only supports the NSIS-installed app, so they are not
     promoted or published as customer release assets.

The SwiftUI native prototype is a local QA artifact, not a public download, until it has a separate
Developer ID signing and notarization pipeline. Each platform's tagged public release fails closed on
that platform's own production signing and identity-verification gates, so a held or failing lane never
blocks the other platform's signed release.

## macOS trust check

Install only a Developer ID-signed, notarized DMG from the releases page. Do not remove macOS
quarantine attributes or use a helper to bypass a trust warning. If the public signed DMG is unavailable,
the macOS release gate has not completed; wait for the signed release.

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
still supporting packaged-runtime launch checks. They are private QA artifacts, not customer downloads.
To use an available Developer ID identity instead:

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
runners build the setup `.exe` for customer release and keep the portable `.exe` as QA-only coverage. Actions billing was reported blocked
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
updated from it. Installed direct-release apps update from that public feed. The Windows portable exe
has no update mechanism and is not a customer release asset.
