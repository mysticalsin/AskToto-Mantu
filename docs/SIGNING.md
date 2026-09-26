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
| Windows direct (`WIN_SIGNING_MODE=pfx`) | `npm run release:win` | `GH_TOKEN` or `GITHUB_TOKEN`, `WIN_SIGNING_MODE=pfx`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `WIN_CSC_EXPECTED_SUBJECT` |
| Windows direct (`WIN_SIGNING_MODE=azure`) | `npm run release:win` | `GH_TOKEN` or `GITHUB_TOKEN`, `WIN_SIGNING_MODE=azure`, `WIN_AZURE_SIGNING_ENDPOINT`, `WIN_AZURE_SIGNING_ACCOUNT`, `WIN_AZURE_CERT_PROFILE`, `WIN_AZURE_PUBLISHER_NAME`, `WIN_CSC_EXPECTED_SUBJECT`, an `azure/login` OIDC session |
| Mac App Store | `MAS_PROVISIONING_PROFILE=/path/profile.provisionprofile npm run release:mas` | `CSC_LINK`, `CSC_KEY_PASSWORD`, existing `MAS_PROVISIONING_PROFILE` file |
| Microsoft Store | `npm run release:win:store` | AppX package builds locally; Microsoft signs Store-submitted packages after upload |

The tag workflow mirrors the direct-release gates with no ad-hoc exception: missing Apple
`CSC_*` / `APPLE_*` secrets fail the macOS job before it builds or uploads an artifact. The public
release accepts only Developer ID-signed, notarized macOS artifacts; on Windows, a missing, invalid,
ambiguous, or incomplete-for-its-mode `WIN_SIGNING_MODE` remains a hard fail — see §Windows Direct
Distribution below. Local ad-hoc packages are QA-only and must never be uploaded to the public release
feed.

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
- GitHub token that can publish to `mysticalsin/Metis-Releases`.

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

Two signing modes, chosen explicitly by the `WIN_SIGNING_MODE` repo/environment **variable** (never
inferred from which secrets happen to be set — see `scripts/lib/windows-signing-mode.mjs`). The release
job (`.github/workflows/release.yml`, `release-windows`) refuses to publish an unsigned Windows release
whenever the mode is missing, invalid, ambiguous (inputs for both modes present at once), or incomplete
for the mode selected.

### Mode: `pfx` (today's default — internal self-signed certificate)

Needed owner inputs:

- Authenticode `.pfx` certificate.
- GitHub token that can publish to `mysticalsin/Metis-Releases`.

Environment:

```powershell
$env:GH_TOKEN="..."
$env:WIN_SIGNING_MODE="pfx"
$env:WIN_CSC_LINK="C:\secure\MantuCodeSigning.pfx"
$env:WIN_CSC_KEY_PASSWORD="..."
$env:WIN_CSC_EXPECTED_SUBJECT="<exact certificate Subject or common name>"
npm run release:win
```

The Windows tag job now runs:

```bash
node scripts/verify-signing.mjs
```

### Mode: `azure` (Microsoft Artifact Signing, formerly Trusted Signing — Public Trust)

Public-trust signing with no certificate file and no signing identity checked into this repo: the
release job authenticates to Azure over OIDC (`azure/login`, no client secret) and signs through a
pinned PowerShell module. See the decision brief and integration design under
`/Users/tony/AI-Brain-build/metis-2.0-exec/tasks/WINDOWS-SIGNING/` for the full trade-off analysis (cost,
entity eligibility, the publisher-name migration) — the summary below is the operator checklist only.

Needed owner/IT inputs, in order:

1. **Choose the signing entity and confirm eligibility** (legal/Tony). Complete Artifact Signing identity
   validation (Public Trust) for that entity and record the exact certificate **Subject** (CN/O/L/S/C)
   and its durable subscriber EKU (`1.3.6.1.4.1.311.97.<…>`). Owner decision, 2026-09-24: the signing
   entity is **MANTU GROUP SA**; the identity-validation outcome and exact certificate CN are **not yet
   available** — do not write a specific CN here until validation completes. Use the placeholder below.
2. **Create the Azure side** (Tony/IT): an Artifact Signing account in a region (this fixes the
   endpoint, e.g. `https://weu.codesigning.azure.net` or `https://swn.codesigning.azure.net`) and a
   **Public Trust** certificate profile — not Public Trust *Test*, whose lifetime EKU
   (`1.3.6.1.4.1.311.10.3.13`) `verify-signing`/the azure probe reject outright. Create an Entra
   application (or user-assigned managed identity) with a **federated credential** whose subject is
   exactly `repo:mysticalsin/AskToto-Mantu:environment:windows-signing`, and assign it the **Artifact
   Signing Certificate Profile Signer** role on the profile (or account).
3. **Create the GitHub environment** (Tony, repo settings → Environments): `windows-signing`, with
   deployments restricted to `v*` tags (and optionally a required reviewer). Add:
   - Environment **secrets**: `WIN_AZURE_CLIENT_ID`, `WIN_AZURE_TENANT_ID`, `WIN_AZURE_SUBSCRIPTION_ID`
     (used only as `azure/login` inputs — never as build-step env; the app's own SSO config reads
     `AZURE_CLIENT_ID`/`AZURE_TENANT_ID` at runtime, so these must never leak into a launched build).
   - Environment **variables**: `WIN_AZURE_SIGNING_ENDPOINT`, `WIN_AZURE_SIGNING_ACCOUNT`,
     `WIN_AZURE_CERT_PROFILE`, `WIN_AZURE_PUBLISHER_NAME`, `WIN_UPDATE_PUBLISHER_NAMES` (JSON array —
     see §Publisher-name migration below), `WIN_AZURE_IDENTITY_EKU` (optional, the durable subscriber
     EKU from step 1).
   - `WIN_CSC_EXPECTED_SUBJECT` set to the new certificate's exact CN
     (`<Artifact Signing certificate CN — fill in once identity validation completes>`).
4. **Dispatch the standalone Azure preflight** (`windows-signing-azure-preflight.yml`, manual, main-only,
   exact-SHA) and require `PASS` before relying on it in a real release.
5. **Flip `WIN_SIGNING_MODE=azure`** (repo/environment variable) and push a `v*` tag. The release must
   pass the fail-fast Azure canary probe, `verify-signing` (Valid signature, matching CN, trusted
   timestamp, Public Trust EKU present, test-profile EKU absent) and `check-update-publisher` before it
   ever reaches the draft-then-publish step.
6. **Confirm the update path** on a clean, unmanaged public Windows machine: the current public Latest
   release auto-updates to the new one, and the fresh install's `resources\app-update.yml` carries the
   intended publisher pin.

None of steps 1–3 can be done from this repo — they need an Azure subscription, a paid Artifact Signing
plan, and GitHub repo-admin access. Until they are done, `WIN_SIGNING_MODE=azure` fails closed with
`AZURE_CONFIG_INCOMPLETE` (or `SIGNING_MODE_REQUIRED` if the variable itself is unset) — it does not fall
back to `pfx` or to an unsigned build.

### Publisher-name migration (either mode)

The first Windows release signed under a new identity fixes the pin every later update must match — see
`scripts/check-update-publisher.mjs`, which fails a release whose installs would then reject its own
next update. No public installer on the feed today carries any pin at all (all of them are unsigned), so
moving straight to `azure` needs no transitional release for the public feed. A fleet still running a
`CN=Mantu`-signed build needs `WIN_UPDATE_PUBLISHER_NAMES` to list **both** names for one release before
dropping the old one — see the integration design §3.3 for the exact sequencing.

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
