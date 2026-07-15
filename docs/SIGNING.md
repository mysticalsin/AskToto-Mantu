# Signing And Store Credentials - Métis

Last verified against primary docs on 2026-07-06.

**External-state check required:** GitHub Actions billing was reported blocked on 2026-07-10, with
runs ending before their first step. Re-check the current run before naming that as today's cause;
repository code cannot prove mutable GitHub billing or secret state. See `docs/MANTU-IT-REQUEST.md`
for the recorded ask and `docs/ENTERPRISE_RELEASE.md` for the operator checklist.

Métis has two desktop distribution lanes:

- Direct enterprise distribution: signed installers from GitHub Releases, with Métis-controlled updates through `electron-updater`.
- Store distribution: Mac App Store and Microsoft Store packages, with updates handled by the store.

The repo can enforce build gates and package shapes. It cannot create Tony's certificates, App Store Connect account access, Microsoft Partner Center access, or the hosted license-server URL.

## Current Release Gates

| Channel | Command | Hard gates |
|---|---|---|
| macOS direct | `npm run release` | `GH_TOKEN` or `GITHUB_TOKEN`, `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows direct | `npm run release:win` | `GH_TOKEN` or `GITHUB_TOKEN`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `WIN_CSC_EXPECTED_SUBJECT` |
| Mac App Store | `MAS_PROVISIONING_PROFILE=/path/profile.provisionprofile npm run release:mas` | `CSC_LINK`, `CSC_KEY_PASSWORD`, existing `MAS_PROVISIONING_PROFILE` file |
| Microsoft Store | `npm run release:win:store` | AppX package builds locally; Microsoft signs Store-submitted packages after upload |

The tag workflow mirrors the direct-release gates. A missing Windows signing cert now fails the tagged release before publish, not after customers download an unsigned installer.

Every command above also runs two native-binary provisioning gates first: `scripts/check-ffmpeg-sidecar.mjs`
(the LGPL decoder sidecar) and `scripts/check-sherpa-platform.mjs` (the Parakeet on-device ASR addon for
the target platform). Both hard-fail the build if their binary is missing and can't be auto-provisioned. See
`docs/ENTERPRISE_RELEASE.md`'s "ffmpeg Sidecar Provisioning" section for the canonical explanation and setup
steps.

## macOS Direct Distribution

Verified: Apple says software downloaded outside the Mac App Store needs Developer ID signing and notarization so Gatekeeper can verify it. See [Apple Developer ID support](https://developer.apple.com/support/developer-id/) and [macOS distribution](https://developer.apple.com/macos/distribution/).

Needed owner inputs:

- Apple Developer Program membership.
- Developer ID Application certificate exported as `.p12`.
- App-specific password for notarization.
- Apple Team ID.
- GitHub token that can publish to `mysticalsin/AskToto-Mantu`.

Environment:

```bash
export GH_TOKEN="..."
export CSC_LINK="/secure/path/DeveloperIDApplication.p12"
export CSC_KEY_PASSWORD="..."
export APPLE_ID="you@mantu.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="XXXXXXXXXX"
npm run release
```

The release pipeline signs, notarizes, publishes to the update feed, then runs:

```bash
node scripts/verify-signing.mjs --require-notarized
```

## Mac App Store

Verified: electron-builder's MAS target needs sandbox entitlements and a provisioning profile, and produces a `.pkg` for App Store Connect. See [electron-builder MAS docs](https://www.electron.build/docs/mas/). Apple lists Mac App Store sandboxing as required in its macOS distribution page.

Needed owner inputs:

- Mac App Distribution certificate.
- Mac Installer Distribution certificate.
- Provisioning profile tied to the Métis App ID and the entitlements in `build/entitlements.mas.plist`.
- App Store Connect app record, metadata, privacy answers, age rating, screenshots, and review submission.

Build:

```bash
export CSC_LINK="/secure/path/MAS-certs.p12"
export CSC_KEY_PASSWORD="..."
export MAS_PROVISIONING_PROFILE="/secure/path/Métis_AppStore.provisionprofile"
npm run release:mas
```

Important: MAS builds run inside Apple's sandbox and do not use the GitHub updater. `src/main/updater.ts` exits early for `process.mas`; Store updates are managed by Apple.

Review risk to test before submission:

- Screen capture and system-audio behavior under App Sandbox.
- Local CLI providers inside the sandbox.
- Native ASR model loading from packaged resources.
- LSUIElement overlay behavior and App Review expectations.

## Windows Direct Distribution

Verified: Microsoft says public Win32 MSI/EXE Store submissions are not re-signed by Microsoft, and direct public installers should be signed by a trusted certificate. See [Microsoft code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

Needed owner inputs:

- Authenticode `.pfx` certificate from a trusted CA, or a future wired Azure Artifact Signing flow.
- GitHub token that can publish to `mysticalsin/AskToto-Mantu`.

Environment:

```powershell
$env:GH_TOKEN="..."
$env:WIN_CSC_LINK="C:\secure\MantuCodeSigning.pfx"
$env:WIN_CSC_KEY_PASSWORD="..."
$env:WIN_CSC_EXPECTED_SUBJECT="<exact certificate Subject or common name>"
npm run release:win
```

The Windows tag job now runs:

```bash
node scripts/verify-signing.mjs
```

## Microsoft Store

Verified: Microsoft Store MSIX/AppX submissions are re-signed by Microsoft after upload. For Store submission, build:

```bash
npm run release:win:store
```

Before upload, make sure `electron-builder.yml` `appx.identityName`, `appx.publisher`, and `appx.publisherDisplayName` match the Partner Center app identity.

## Enterprise Control

Use `build/managed-config.enterprise.example.json` as the operator-owned policy base. It enables and locks:

- Azure SSO.
- Hosted license server.
- License gate.
- Provider policy.
- Transcript encryption.
- Redaction.
- Content protection.
- Consent indicator.
- Retention window.

Deploy the filled file as `managed-config.json` to:

- macOS: `/Library/Application Support/Métis/managed-config.json`
- Windows: `%ProgramData%\Métis\managed-config.json`

Machine-wide policy wins over per-user config.

## What Remains Owner-Side

- Fix GitHub Actions billing so CI/release runners execute at all (current hard blocker, see top of this doc).
- Enroll in Apple Developer Program.
- Create direct and MAS certificates.
- Create MAS provisioning profile.
- Create App Store Connect listing.
- Create Microsoft Partner Center listing if using Microsoft Store.
- Buy or provision Windows signing.
- Deploy the license server at a public HTTPS URL.
- Put release secrets in GitHub Actions.
