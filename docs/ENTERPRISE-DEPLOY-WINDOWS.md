# Métis — Windows enterprise deployment

How to roll Métis out to a Mantu Windows fleet with a trusted, auto-updating, signed build.
Companion docs: `SIGNING.md` (cert/env reference) · `MANTU-IT-REQUEST.md` (owner actions) ·
`build/managed-config.example.json` (managed enterprise config).

## Artifacts

`npm run dist:win` produces, in `release/`:

| File | Purpose |
|---|---|
| `Metis-Setup-<version>.exe` | NSIS installer (per-user, no admin needed; silent: `/S`) |
| `Metis-Portable-<version>.exe` | Single-file portable, no install |
| `latest.yml` + `*.blockmap` | electron-updater feed metadata (differential updates) |

Both executables embed the on-device ASR models (~2.2 GB) — no first-run download, works offline.

## Required egress

Transcription needs none of this — the ASR models are in the executable (above). The **Qwen3.5 0.8B
default is bundled** with its projector (**763,759,712 bytes**) and llama-server, so supported local text
and screenshot inference can be enabled offline without a model download. Local AI is off by default;
existing selections are preserved and RAM does not silently select a larger model. The packaged default
is size- and SHA-256-verified; missing or corrupt files require a repaired installer.

**Optional Qwen3.5 4B** requires an explicit selection and first-use download (or explicit Retry):

| Host | When | Why | If blocked |
|---|---|---|---|
| `huggingface.co` and the CDN host it redirects to | On first use of an explicitly selected optional 4B model, per user profile; enabled selections retry on later launches | Fetches **3,584,533,344 bytes (3.58 GB)** into `local-llm\models\qwen3.5-4b\` beneath the app's userData directory. Size optional egress and per-user disk for that GGUF/projector pair. Its URL is pinned to an immutable upstream commit and both files are size- and SHA-256-verified before use. The compact default does not need this request. | The selected 4B remains unavailable and Local AI reports the failed download. The user can explicitly choose the bundled compact model instead. Transcription is unaffected. |

The request goes through the machine's configured proxy (`HTTP(S)_PROXY`, the Windows system proxy, or a
PAC script), so a proxy-only fleet works as long as the host is allowed.

To roll out without model-download egress, retain the bundled compact default. For an offline 4B
deployment, pre-place `model.gguf` and `mmproj.gguf` in the optional model's profile path via deployment
tooling (sizes and hashes must match `src/main/llm/local-models.ts`). Disabling Local AI suppresses
automatic optional-model provisioning; an explicit Download/Retry remains a user-requested action.

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

After propagation, `Get-AuthenticodeSignature Metis-Setup-<v>.exe` reports **Valid** on fleet
machines and `npm run verify:signing` passes. On machines without the GPO, the same signed file
reports `UnknownError` (signed correctly, root not trusted locally) — expected, not a defect.
`HashMismatch` or `NotSigned` always means a bad artifact: stop the rollout.

## Deployment options

- **Intune Win32 app / SCCM:** wrap `Metis-Setup-<version>.exe` with install command
  `Metis-Setup-<version>.exe /S` (NSIS silent, per-user context). Detection: presence of
  `%LOCALAPPDATA%\Programs\Metis\Metis.exe` with the target version.
- **Self-service:** publish the installer on the internal portal; per-user install needs no admin.
- **Portable:** for locked-down or kiosk machines, ship `Metis-Portable-<version>.exe`.

## Auto-update channel

Installed apps poll the public **Métis-Releases** GitHub repo on launch, download in the
background, and install on quit (`electron-builder.yml` publish block; `src/main/updater.ts`).
Updates are rejected unless their Authenticode signature matches `publisherName` (`CN=Mantu`) —
a compromised feed cannot push an unsigned or foreign-signed binary. Release flow: tag `v*` →
`release.yml` builds, signs, and publishes (requires `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` secrets;
the `check:release` preflight enforces `releaseType: release` so the feed never dangles on drafts).

## Managed configuration

Machine-wide policy file (e.g. lock transcript encryption on, pin the allowed SSO domain) per
`build/managed-config.example.json`. Deploy it to exactly:

```
%ProgramData%\Métis\managed-config.json
```

That path is the only one the app reads (`adminManagedConfigPath`, `src/main/win-security.ts`), and
the directory name is the accented `Métis`. A policy file anywhere else — including
`%ProgramData%\Metis` or `%ProgramData%\AskToto` — is silently ignored, so the fleet keeps running
unmanaged with nothing logged. On Windows the machine-level file is only honored when its ACL is
admin-owned (`src/main/win-security.ts`) — a non-admin user cannot plant policy.

## Privacy / data posture (for IT review)

- Transcription is on-device; audio never leaves the machine.
- Transcripts are envelope-encrypted at rest (AES-256-GCM) by default; provider keys are encrypted
  via OS keychain (`safeStorage`). Keys are never exposed to the renderer process.
- No telemetry, no crash-report upload — by design (`src/main/index.ts`).
- What leaves the device: prompts to the user-chosen AI provider; optional Dust/graph reads of the
  notes folder. See `README.md` §Security & privacy.

## Logs, audit trail, and support diagnostics

- Diagnostic log: `%APPDATA%sktoto\logs\main.log` (5MB rotation). Crash dumps: `%APPDATA%sktoto\crash-*.log`
  plus Crashpad minidumps under the profile.
- Security audit trail: `%APPDATA%sktoto\logsudit.log` + rotated `audit-<epoch>.log` generations
  (20 kept). Hash-chained for tamper evidence — verify with `node scripts/verify-audit-log.mjs "<logs dir>"`.
  Policy, retention, and the erasure stance: `docs/AUDIT-LOG.md`.
- Users export everything support needs from **Settings -> About -> Export diagnostics bundle** — logs,
  crash dumps and the boot sentinel to a folder of their choice, with a MANIFEST. Never includes
  meetings, the knowledge store, or settings.

## Private update feed (admin policy)

By default updates come from the public GitHub releases feed. To serve them from an internally hosted
endpoint instead, add to the ADMIN managed-config (`%ProgramData%\Métis\managed-config.json` — the
ACL-trusted machine policy; a per-user config is deliberately ignored for this key):

```json
{ "updateFeedUrl": "https://updates.your-corp.example/metis/" }
```

The URL must be `https://` and must serve electron-updater's generic layout: `latest.yml`, the
`Metis-Setup-*.exe` it names, and its `.blockmap`. Signature verification
(`verifyUpdateCodeSignature`) still applies to whatever the feed serves. `disableAutoUpdate: true`
continues to freeze updates entirely.

## DevTools posture

DevTools are disabled in packaged builds (`devTools: false` on every window). For a field-debugging
session, launch with `ASKTOTO_DEVTOOLS=1`.
