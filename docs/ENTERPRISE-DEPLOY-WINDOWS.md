# AskToto — Windows enterprise deployment

How to roll AskToto out to a Mantu Windows fleet with a trusted, auto-updating, signed build.
Companion docs: `SIGNING.md` (cert/env reference) · `MANTU-IT-REQUEST.md` (owner actions) ·
`build/managed-config.example.json` (managed enterprise config).

## Artifacts

`npm run dist:win` produces, in `release/`:

| File | Purpose |
|---|---|
| `AskToto-Setup-<version>.exe` | NSIS installer (per-user, no admin needed; silent: `/S`) |
| `AskToto-Portable-<version>.exe` | Single-file portable, no install |
| `latest.yml` + `*.blockmap` | electron-updater feed metadata (differential updates) |

Both executables embed the on-device ASR models (~2.2 GB) — no first-run download, works offline.

## Signing model (current state)

Builds are Authenticode-signed with an **internal self-signed certificate**:

- Subject: `CN=Mantu` (matches `win.publisherName` in `electron-builder.yml`, which
  `verifyUpdateCodeSignature: true` checks before installing any update)
- Signature: SHA-256 with an RFC 3161 timestamp (valid after cert expiry)

A self-signed cert gives you integrity + updater trust **inside the fleet** once machines trust it
(below). It does **not** give public SmartScreen reputation — outside the fleet, users still see
"Windows protected your PC". For public distribution, upgrade to **Azure Trusted Signing** or an
OV/EV certificate (see `SIGNING.md` §Windows) — drop-in: set `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`
(or Azure signing params) in CI and re-release; nothing else changes.

## Fleet trust (one-time IT action)

Distribute the **public** certificate (`.cer` — never the `.pfx`) via Group Policy:

1. Export the public cert: `certutil -store -user My <thumbprint>` or from `certmgr.msc`
   (Personal → Certificates → CN=Mantu → Export, **without** private key, DER `.cer`).
2. GPO: `Computer Configuration → Policies → Windows Settings → Security Settings →
   Public Key Policies`:
   - Import into **Trusted Root Certification Authorities** (chain validity), and
   - **Trusted Publishers** (suppresses publisher prompts).
3. Intune equivalent: two *Trusted certificate* configuration profiles targeting the same stores.

After propagation, `Get-AuthenticodeSignature AskToto-Setup-<v>.exe` reports **Valid** on fleet
machines and `npm run verify:signing` passes. On machines without the GPO, the same signed file
reports `UnknownError` (signed correctly, root not trusted locally) — expected, not a defect.
`HashMismatch` or `NotSigned` always means a bad artifact: stop the rollout.

## Deployment options

- **Intune Win32 app / SCCM:** wrap `AskToto-Setup-<version>.exe` with install command
  `AskToto-Setup-<version>.exe /S` (NSIS silent, per-user context). Detection: presence of
  `%LOCALAPPDATA%\Programs\AskToto\AskToto.exe` with the target version.
- **Self-service:** publish the installer on the internal portal; per-user install needs no admin.
- **Portable:** for locked-down or kiosk machines, ship `AskToto-Portable-<version>.exe`.

## Auto-update channel

Installed apps poll the public **AskToto-Releases** GitHub repo on launch, download in the
background, and install on quit (`electron-builder.yml` publish block; `src/main/updater.ts`).
Updates are rejected unless their Authenticode signature matches `publisherName` (`CN=Mantu`) —
a compromised feed cannot push an unsigned or foreign-signed binary. Release flow: tag `v*` →
`release.yml` builds, signs, and publishes (requires `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` secrets;
the `check:release` preflight enforces `releaseType: release` so the feed never dangles on drafts).

## Managed configuration

Machine-wide policy file (e.g. lock transcript encryption on, pin the allowed SSO domain) per
`build/managed-config.example.json`. On Windows the machine-level file is only honored when its
ACL is admin-owned (`src/main/win-security.ts`) — a non-admin user cannot plant policy.

## Privacy / data posture (for IT review)

- Transcription is on-device; audio never leaves the machine.
- Transcripts are envelope-encrypted at rest (AES-256-GCM) by default; provider keys are encrypted
  via OS keychain (`safeStorage`). Keys are never exposed to the renderer process.
- No telemetry, no crash-report upload — by design (`src/main/index.ts`).
- What leaves the device: prompts to the user-chosen AI provider; optional Dust/graph reads of the
  notes folder. See `README.md` §Security & privacy.
