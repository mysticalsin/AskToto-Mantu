# AskToto — Deployment Runbook

Scope: building, signing, and distributing AskToto 0.1.0 as a desktop binary. "Deployment" = produce a
trusted installer and get it onto user machines — there is no server to deploy. Evidence = `file:line` /
command output.

Date: 2026-06-27.

---

## 1. Pre-flight gate (must pass before building)

```bash
npm ci
npm run typecheck        # tsc node + web projects
npm test                 # vitest — 56/59 local; 3 dustcli keychain tests need real keychain (pass 4/4 un-sandboxed)
npm audit --omit=dev     # currently 9 (5 high, 4 moderate, 0 critical) — transitive ReDoS under @dust-tt/client
```

CI already runs typecheck/build/test on push/PR and packages mac + win artifacts
(`.github/workflows/build.yml`). **Recommended addition**: an `npm audit` step (VENDOR finding).

## 2. Build artifacts

| Platform | Command | Output |
|----------|---------|--------|
| macOS | `npm run dist` | `release/AskToto-<v>.dmg`, `.zip` (`electron-builder.yml:33-41`) |
| Windows | `npm run dist:win` | `AskToto-Setup-<v>.exe` (NSIS) + `AskToto-Portable-<v>.exe` (`:43-57`) |
| Windows Store | `npm run dist:win:appx` | `AskToto-<v>.appx` (`:58-63`) |

asar packaging on; only `out/**` + `package.json` are bundled, source maps and `.d.ts` excluded
(`electron-builder.yml:9-14`).

## 3. Signing & notarization (BLOCKER for trusted distribution)

Currently **not configured** — env-driven (`electron-builder.yml:5-7,32,47`; `docs/SIGNING.md`).

- **macOS**: set `CSC_LINK` + `CSC_KEY_PASSWORD` (Developer ID Application) and `APPLE_ID` +
  `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` for notarization. Hardened runtime + entitlements
  already enabled (`electron-builder.yml:24-31`, `build/entitlements.mac.plist`).
- **Windows**: set `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` (or Azure Trusted Signing) so SmartScreen
  trusts the installer.
- Provision these as **CI secrets**, never commit them.
- **Verify** after build: macOS `spctl -a -vv AskToto.app` + `stapler validate`; Windows
  `signtool verify /pa AskToto-Setup-<v>.exe`.

## 4. Auto-update host (BLOCKER for auto-update)

`publish.url` is the placeholder `https://REPLACE-WITH-YOUR-UPDATE-HOST/asktoto`; the updater self-skips
it (`updater.ts:14-18`). To enable:
1. Stand up a static HTTPS host (S3 / Azure Blob / any server).
2. Set `publish.url` to it (`electron-builder.yml:67-69`).
3. `npm run dist` uploads `latest-mac.yml` / `latest.yml` + artifacts.
4. On Windows, decide whether to flip `verifyUpdateCodeSignature` to `true` once signing is live
   (`electron-builder.yml:47`).

## 5. Enterprise rollout

1. Build signed artifacts (§3).
2. Deploy `managed-config.json` to the machine-wide admin path (preset provider, enforce/lock SSO,
   notes folder, encryption) (`store.ts:78-98`, `build/managed-config.example.json`).
3. Distribute via MDM (Intune/Jamf) or the update host.
4. Provision the Entra app registration if SSO is enforced (ACCESS_REVIEW §3).

## 6. Post-deploy verification

- Launch → tray icon present; Settings opens; **Test key** succeeds (`store.ts:214-263`).
- Self-test JSON shows all pass (`selftest.ts`).
- Signature/notarization verified (§3).

## 7. Findings

| Sev | Title | Evidence | Fix |
|-----|-------|----------|-----|
| HIGH | Code signing / notarization not configured → OS warns / blocks unsigned installs | `electron-builder.yml:5-7,32,47`; `docs/SIGNING.md` | Provision certs as CI secrets; ship signed+notarized; verify with spctl/signtool |
| MEDIUM | Auto-update host is a placeholder → no patch-delivery channel | `updater.ts:14-18`; `electron-builder.yml:67-69` | Stand up HTTPS update host; confirm signed `latest-*.yml` flow |
| LOW | No `npm audit` gate in CI | `.github/workflows/build.yml` | Add thresholded audit step |

## 8. N/A

- Blue/green, canary, k8s rollout, infra-as-code — **N/A**: desktop binary, no server.
