# Signing & credentials — AskToto

App icon (all platforms): `build/icon.png` (1024² Mantu **M**). electron-builder derives `.icns` (mac)
and `.ico` (Windows) from it; iOS uses `ios/AskToto/Assets.xcassets/AppIcon.appiconset/icon-1024.png`.

Nothing below is committed — set them as **environment variables / CI secrets** at build time.

## Windows (.exe)

`npm run dist:win` → `release/AskToto-Setup-<version>.exe` (NSIS installer) + `AskToto-Portable-<version>.exe`.

Authenticode signing (so SmartScreen trusts it) — provide ONE of:

**A. Certificate file (.p12 / .pfx)**
```bash
export WIN_CSC_LINK="/secure/path/MantuCodeSigning.pfx"   # or base64 of the file
export WIN_CSC_KEY_PASSWORD="••••••"
npm run dist:win
```

**B. Azure Trusted Signing / EV in a token** — use `signtoolOptions` or a custom `sign` hook in
`electron-builder.yml`. Recommended for EV/HSM certs (no exportable .pfx).

> Building Windows artifacts **on macOS** needs Wine (electron-builder fetches its own). Easiest is a
> Windows or CI runner (GitHub Actions `windows-latest`).

## macOS (.dmg / .zip)

`npm run dist` → `release/AskToto-<version>.dmg` + `.zip`. Already hardened-runtime + entitlements.

```bash
export CSC_LINK="/secure/path/DeveloperIDApplication.p12"   # "Developer ID Application" cert
export CSC_KEY_PASSWORD="••••••"
# Notarization (required for Gatekeeper):
export APPLE_ID="you@mantu.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"    # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID="XXXXXXXXXX"
npm run dist
```
electron-builder signs with `CSC_LINK` and notarizes automatically when the `APPLE_*` vars are present.

## iOS (.ipa)

Open `ios/AskToto.xcodeproj` → target **AskToto** → **Signing & Capabilities**:
- Set **Team** (or `DEVELOPMENT_TEAM` in `ios/project.yml`).
- Bundle id `com.mantu.asktoto`. Xcode manages the provisioning profile automatically.
- Archive → Distribute (App Store / Ad Hoc / Enterprise).

CI: `xcodebuild -project ios/AskToto.xcodeproj -scheme AskToto -archivePath out.xcarchive archive`
then `-exportArchive` with an `exportOptions.plist`, using an App Store Connect API key
(`APP_STORE_CONNECT_KEY_ID` / `ISSUER_ID` / `.p8`).

## Auto-update host
`electron-builder.yml → publish.url` is a placeholder. Point it at your static HTTPS host (S3 / Azure
Blob / any server); `npm run dist` then uploads `latest-mac.yml` + artifacts there for electron-updater.
