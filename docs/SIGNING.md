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

## Auto-update host
Auto-update is served from the public **AskToto-Releases** GitHub repo (`electron-builder.yml` publish
block: `provider: github`, `releaseType: release` — enforced by the `npm run check:release` preflight
gate). `npm run dist` builds without publishing; `npm run release` (needs `GH_TOKEN` with repo scope)
uploads `latest-mac.yml` + artifacts to that repo's Releases for electron-updater.

## Ship checklist (mac + Windows, end to end)

The CI is already wired: `.github/workflows/build.yml` builds, tests, and packages BOTH platforms on
every push/PR (unsigned unless certs are set); `release.yml` builds, signs, notarizes, and publishes on
a `v*` tag. Everything below is account setup only the owner can do.

1. **Enable Actions** on `mysticalsin/AskToto-Mantu` (Settings, Actions, General, allow all actions).
   With nothing else set, one push produces UNSIGNED mac `.dmg`/`.zip` and Windows `.exe`/`.appx` as
   downloadable run artifacts (3-day retention). Fastest way to get the Windows app in hand.
2. **Create the public `AskToto-Releases` repo** (empty). It is the auto-update feed target.
3. **Add repo secrets** (Settings, Secrets and variables, Actions):
   - `GH_TOKEN`: a PAT with `repo` scope on AskToto-Releases (the publish target).
   - macOS: `CSC_LINK` (base64 of your Developer ID Application .p12), `CSC_KEY_PASSWORD`, `APPLE_ID`,
     `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
   - Windows: `WIN_CSC_LINK` (base64 of your Authenticode .pfx), `WIN_CSC_KEY_PASSWORD`.
   - Base64 a cert: `base64 -i cert.p12 | pbcopy`.
4. **Get a Developer ID Application cert** (Apple Developer, Certificates) if you lack one, so Gatekeeper
   accepts the mac build without the "unidentified developer" prompt. The dev-signed local `dist:local`
   build already runs for you and internal testers via right-click, Open.
5. **Release**: merge to `main`, then `git tag v1.0.0 && git push origin v1.0.0`. `release.yml` signs,
   notarizes, and publishes both installers to AskToto-Releases; installed apps auto-update from there.

Local signed mac build without CI: `npm run dist:local` with the login Keychain unlocked, dmg lands in
`~/AI-Brain-build/asktoto-release/` (dev-signed; see the macOS section above for notarized builds).

## Signature gate (`verify:signing`)

`scripts/verify-signing.mjs` positively verifies a build is validly signed instead of trusting the
builder's exit code (`codesign --verify --deep --strict` on macOS, `Get-AuthenticodeSignature` on
Windows, plus a Gatekeeper/`spctl` check). `dist:local` runs it automatically at the end and fails on a
genuinely broken signature. Run it standalone with `npm run verify:signing [artifactsDir]`. For release
gating add `--require-notarized`, which also fails when Gatekeeper does not accept the app (not notarized
/ not a Developer ID cert) — wire `node scripts/verify-signing.mjs --require-notarized` into `release.yml`
after the build step once you have a Developer ID cert + notarization creds set.
