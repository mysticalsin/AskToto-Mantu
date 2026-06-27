# Release & Rollback Report — AskToto

**App type:** local Electron desktop app (macOS dmg/zip · Windows nsis/portable/appx · iOS xcodeproj). **No server, no cloud deploy** — "release" = signed installers + an optional static auto-update host; "rollback" = ship/install a prior version.
**Reviewer:** senior build-release engineer. **Date:** 2026-06-27. **Version:** 0.1.0.

---

## 1. Packaging configuration (`electron-builder.yml`)

- `appId: com.mantu.asktoto`, `asar: true`, output dir `release/`.
- Targets: **mac** `dmg`+`zip` (hardenedRuntime, entitlements `build/entitlements.mac.plist`, `gatekeeperAssess: false`); **win** `nsis`+`portable` (+`appx` via separate script); files glob `out/**/*` + `package.json` (maps and `.d.ts` excluded — good, no source maps shipped).
- Real artifacts already built locally in `release/`:
```
AskToto-0.1.0-arm64.dmg            104.6M   (+ .blockmap)
AskToto-0.1.0-arm64-mac.zip        100.7M   (+ .blockmap)
AskToto-Setup-0.1.0.exe            178.5M   (+ .blockmap)
AskToto-Portable-0.1.0.exe         178.3M
latest-mac.yml / latest.yml        (update manifests, sha512 per artifact)
```

---

## 2. Code signing & notarization — UNKNOWN→FAIL for production

Signing is **env-driven and not configured** (`electron-builder.yml` comments; `SIGNING.md`). The locally built artifacts were verified:

```
$ codesign -dv --verbose=2 release/mac-arm64/AskToto.app
CodeDirectory … flags=0x20002(adhoc,linker-signed)
Signature=adhoc
TeamIdentifier=not set
$ spctl -a -vvv release/mac-arm64/AskToto.app
release/mac-arm64/AskToto.app: internal error in Code Signing subsystem   # not notarized → Gatekeeper rejects
```

**Findings:**
- macOS build is **adhoc-signed only** (no Developer ID, `TeamIdentifier=not set`) and **not notarized** → Gatekeeper will block it on other machines ("damaged / unidentified developer"). Real Developer ID signing + notarization requires `CSC_LINK`/`CSC_KEY_PASSWORD` + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` (per `SIGNING.md`) — none set.
- Windows: `win.verifyUpdateCodeSignature: false` is set in `electron-builder.yml`, and no `WIN_CSC_LINK` is configured → installers are **unsigned** → SmartScreen warnings, and (critically) the auto-updater will **not verify the publisher signature** of downloaded updates (see §4).
- The CI macOS job forces `ASKTOTO_DISABLE_CP=1` (signing disabled) — so CI artifacts are unsigned too (see CICD_REVIEW.md).

**Verdict:** signing/notarization status is **FAIL for production distribution** (today's artifacts are not distributable without Gatekeeper/SmartScreen friction and carry no tamper protection). The *mechanism* is wired correctly; only the credentials/secrets are missing → flip to PASS once certs are provided and a signed build is re-verified with `codesign`/`spctl`/`signtool`.

---

## 3. Auto-update mechanism (`src/main/updater.ts`)

`electron-updater@6.8.9` is wired (`updater.ts:initAutoUpdate`):
- Runs **only when `app.isPackaged`** (`updater.ts:11`).
- Reads the packaged `app-update.yml`; **if it contains `REPLACE-WITH` it skips** (`updater.ts:15-18`).
- Otherwise: `autoDownload=true`, `autoInstallOnAppQuit=true`, `checkForUpdatesAndNotify()`.

**Current state — updater is effectively DISABLED:**
```
$ cat release/mac-arm64/AskToto.app/Contents/Resources/app-update.yml
provider: generic
url: https://REPLACE-WITH-YOUR-UPDATE-HOST/asktoto
```
Both the macOS and Windows packaged apps still carry the **placeholder host**, so `initAutoUpdate()` returns early and no update check runs. There is therefore **no live update channel** and no current MITM exposure — but also no patch-delivery path.

---

## 4. Update integrity — latent HIGH once a host is wired

The generated manifests carry per-artifact SHA-512:
```
$ cat release/latest-mac.yml
files:
  - url: AskToto-0.1.0-arm64-mac.zip
    sha512: 7nkwFy2Zc5CI9WxMmWqUU72tc5Nu7cuPyjZSAlbw+4WLknW4XDYZL0kEuWeIi31WFpkBSGaFBszB/kxxVh8tDQ==
$ cat release/latest.yml  → AskToto-Setup-0.1.0.exe sha512: DoDZMoRwfyFof5o8I0Z5fd4QNz/k7uuVv…
```
**What sha512 protects:** corruption / partial-download integrity — the downloaded bytes must match the manifest. **What it does NOT protect:** an attacker who controls (or MITMs) the update host can rewrite *both* the artifact and its sha512 in `latest.yml`. The only real tamper protection electron-updater offers is **code-signature verification of the downloaded package**:
- **macOS:** updater trusts the OS code signature — but the build is **adhoc** (no Developer ID), so once a real host is configured, a malicious update could be served. Notarized Developer ID signing is the fix.
- **Windows:** `verifyUpdateCodeSignature: false` **explicitly disables** the publisher-signature check on update install — a compromised host could push an arbitrary `.exe`. Set it to `true` and sign with a real Authenticode cert before enabling updates.

**Finding (HIGH, latent):** when the placeholder `publish.url` is replaced with a real host, the current configuration (adhoc mac signing + `verifyUpdateCodeSignature:false` on win) would deliver updates protected only by TLS + sha512, not by signature. Do not enable auto-update until signing is configured and `verifyUpdateCodeSignature` is `true`.

---

## 5. Rollback strategy (desktop app)

There is **no server to roll back** and **no documented rollback procedure** in the repo. For an Electron app the practical options are:

1. **User reinstall of the prior version** — keep the previous signed `.dmg`/`.exe` artifacts (and `.blockmap`s) archived per release. This is the baseline rollback and should be documented in release notes.
2. **Forced downgrade via the update channel** — electron-updater does **not** downgrade by default (it only moves to a higher version). To push users back you must publish a *new, higher* version number that actually contains the older, known-good build, and update `latest.yml`/`latest-mac.yml` accordingly. This is the only way to remotely un-break a bad auto-update.
3. **Halt the rollout** — because `autoDownload=true` and `autoInstallOnAppQuit=true` (`updater.ts:25-26`), a bad release auto-installs on next quit; the fastest mitigation is to revert `latest.yml` on the host to the prior version's manifest so new checks see the old version.

**Gaps to close before production:**
- No release-retention / artifact-archival policy (prior versions must be kept to enable rollback).
- No staged/percentage rollout (electron-updater + `generic` provider has no channels/staging configured) — a bad build reaches 100% of users at once. Consider `channel`/staged rollout or a manual gate.
- No documented "stop the bleeding" runbook for a bad auto-update.
- Auto-install-on-quit with no user prompt means a regression ships silently — acceptable for enterprise, but pair it with the ability to revert the manifest.

---

## 6. Findings (severity-ranked)

1. **HIGH — Production artifacts are unsigned/not notarized** (mac adhoc, `spctl` rejects; win unsigned). Configure Developer ID + Apple notarization and Windows Authenticode; re-verify with `codesign`/`spctl`/`signtool`. Release-blocking for external distribution.
2. **HIGH (latent) — Auto-update lacks signature verification** (`win.verifyUpdateCodeSignature: false`; mac adhoc). Safe only because the updater is currently disabled by the placeholder host. Must be fixed *before* wiring a real `publish.url`.
3. **MEDIUM — No update host configured** (`app-update.yml` = `REPLACE-WITH-…`) → no patch-delivery path; security fixes cannot reach users. Acceptable pre-release, blocking for "production with sensitive data".
4. **MEDIUM — No documented rollback/retention/staged-rollout procedure.** `autoDownload`+`autoInstallOnAppQuit` make a bad release auto-propagate; add manifest-revert runbook + artifact archival + staged rollout.
5. **LOW — Update integrity relies on sha512 + TLS only** until signing lands; document that sha512 is anti-corruption, not anti-tamper.

**Net:** signing/notarization **FAIL**; update-host config **UNKNOWN/incomplete**; update integrity **UNKNOWN** (mechanism present, protection not yet effective); rollback **FAIL (undocumented)**.
