# Métis — request to Mantu IT (unblocks distribution + Outlook)

**From:** Tony Walteur  **Re:** what's needed to ship Métis (the AI meeting-copilot desktop app) to
real users. The app is built and working locally; the items below are the only blockers to a signed,
installable build and the Outlook agenda feature. Nothing here exposes secrets in the codebase — all
credentials are read from environment variables / a managed-config file at build/run time.

Two items are hard blockers today: an Apple Developer ID signing identity (section 1) and the GitHub
Actions budget on `mysticalsin/AskToto-Mantu` (section 2). Everything else in this document is either
already built or is a secondary ask.

---

## 1. Apple Developer Program enrollment + Developer ID Application certificate (macOS)

### What is broken right now

Métis has no Apple signing identity, so the macOS `.dmg` we produce is unsigned and un-notarized.
Every user who downloads it gets blocked by Gatekeeper with:

> Apple could not verify "Metis" is free of malware that may harm your Mac or compromise your privacy.

On macOS 15 and later, the old workaround no longer exists. Control-click → Open does not bypass this
dialog anymore; the user has to open System Settings → Privacy & Security, scroll to the security
section, and click "Open Anyway" after the dialog has already appeared and been dismissed. In practice
a non-technical user reads a malware warning, closes it, and does not install the app. This is not a
polish issue — it is the difference between the app being distributable and not.

The only supported fix is Developer ID signing plus Apple notarization. Apple's own guidance is that
software distributed outside the Mac App Store must be Developer ID signed and notarized for Gatekeeper
to verify it ([Developer ID](https://developer.apple.com/support/developer-id/),
[macOS distribution](https://developer.apple.com/macos/distribution/)).

### What we need

- **Apple Developer Program enrollment** for Mantu (organization enrollment, which requires a D-U-N-S
  number and a person with legal signing authority). This is a **paid annual enrollment**; the current
  fee should be confirmed directly on Apple's enrollment page rather than taken from this document.
- A **Developer ID Application certificate** created under that account and exported as a `.p12`
  file, with its export password.
- An **app-specific password** for the Apple ID used for notarization (or an App Store Connect API
  key, if IT prefers that model — the workflow currently reads the app-specific password form).
- The **Apple Team ID** (10-character identifier from the developer account).
- The above loaded as **GitHub Actions repository secrets** on `mysticalsin/AskToto-Mantu`.

### Exact secret names the release workflow requires

Read directly from `.github/workflows/release.yml`, `release-macos` job, "Require signing secrets
before releasing" step. All six must be present or the job exits before any build work starts:

| Need | Secret name |
|---|---|
| Token that can publish releases to `mysticalsin/AskToto-Mantu` | `GH_TOKEN` |
| Developer ID Application certificate (base64 `.p12`) | `CSC_LINK` |
| Certificate export password | `CSC_KEY_PASSWORD` |
| Apple ID used for notarization | `APPLE_ID` |
| App-specific password for that Apple ID | `APPLE_APP_SPECIFIC_PASSWORD` |
| Apple Team ID | `APPLE_TEAM_ID` |

### Windows signing (same pipeline, secondary ask)

The tagged workflow refuses to publish unsigned Windows installers as well. Verification builds can
produce unsigned `Metis-Setup-*.exe` and `Metis-Portable-*.exe`, but the public release job fails
closed. From the `release-windows` job's "Require signing secrets before releasing" step:

| Need | Secret name |
|---|---|
| Authenticode certificate (`.pfx`) from a trusted CA | `WIN_CSC_LINK` |
| Certificate password | `WIN_CSC_KEY_PASSWORD` |
| Exact certificate Subject or common name, checked at release time | `WIN_CSC_EXPECTED_SUBJECT` |

**Interim option — internal trust, no purchase:** Windows builds can be Authenticode-signed with an
internal self-signed certificate (`CN=Mantu`, SHA-256, RFC 3161 timestamped). Installers then verify as
**Valid** on any machine that trusts the certificate; distribute the public `.cer` (never the `.pfx`)
via GPO or Intune to **Trusted Root Certification Authorities** and **Trusted Publishers** on managed
machines. Full steps: `docs/ENTERPRISE-DEPLOY-WINDOWS.md`. Public trust (a trusted-CA certificate, or
Azure Trusted Signing) remains the recommended path for wider distribution and SmartScreen reputation.

There is no equivalent interim option on macOS. Ad-hoc or self-signed macOS builds still trigger the
Gatekeeper malware dialog above; only Apple notarization clears it.

---

## 2. Restore the GitHub Actions budget on `mysticalsin/AskToto-Mantu`

### What is broken right now

Every workflow run on the repository fails within roughly 3–4 seconds, before its first step executes,
with the job annotation:

> The job was not started because an Actions budget is preventing further use.

This is a spend/budget control on the account that owns the repository, not a fault in the workflow
files. Because it stops jobs from starting at all, it blocks everything: typecheck, unit tests, the
build workflow, and the signed release pipeline. Even once the Apple certificate in section 1 is
provided, no release can be produced until Actions can run.

### What we need

- The Actions spending limit / budget on the account owning `mysticalsin/AskToto-Mantu` raised or
  re-enabled, and confirmation of the billing owner so future limits can be managed without another
  outage.
- Note that macOS runners are billed at a higher multiplier than Linux runners, and the macOS release
  job has a 120-minute timeout because Apple's notarization queue can be slow. The budget should be
  set with signed macOS releases in mind, not Linux-only CI.

---

## 3. Azure (Microsoft Entra) app registration — for Outlook agenda + sign-in

Needed so Métis can (a) sign users in with their Mantu Microsoft account and (b) read **today's calendar**
to show their agenda. **Read-only, least-privilege** — no write access to mail or calendar.

Please create an Entra **app registration** with:
- **Platform:** "Mobile and desktop applications" with a **loopback redirect URI** (`http://localhost`) —
  it's a public client using PKCE, **no client secret**.
- **Delegated API permissions** (Microsoft Graph): `User.Read`, **`Calendars.Read`**, `openid`, `profile`,
  `email`. (Calendars.Read is read-only — it cannot modify or send anything.)
- Restricted to the **Mantu tenant** (single-tenant) so only Mantu accounts can sign in.

Then provide:
| Need | Env var / managed-config key |
|---|---|
| Application (client) ID | `AZURE_CLIENT_ID` |
| Directory (tenant) ID | `AZURE_TENANT_ID` |
| Allowed email domain (e.g. `mantu.com`) | `azureAllowedDomain` (managed-config) |

**Security notes for review:** the app is a public PKCE client (no secret to leak). The Graph access token is
obtained on-device via the system browser, stored only in an OS-keychain-encrypted cache, never logged, and
used only for read-only calendar fetches. Sign-in is locked to the Mantu tenant + the allowed domain; any
other account is rejected and its tokens are purged immediately.

---

## What is already built and waiting

This request is not asking IT to build anything. The pipeline exists and is tested; it is waiting on
credentials and on runners being allowed to start.

- `.github/workflows/release.yml` builds, signs, notarizes, and publishes both macOS and Windows on a
  `v*` tag push. It is already wired to read every secret named above.
- The macOS job **hard-fails before building** if any of `GH_TOKEN`, `CSC_LINK`, `CSC_KEY_PASSWORD`,
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` is missing. It does not silently publish
  an unsigned build. (electron-builder itself only logs a warning and continues when it finds no
  signing identity, which is exactly the failure mode this gate prevents.)
- After building, the macOS job runs `node scripts/verify-signing.mjs --require-notarized` against the
  produced artifact. An artifact that is not both signed and notarized cannot reach the publish job.
  The Windows job runs the same script and additionally checks the Authenticode subject matches
  `WIN_CSC_EXPECTED_SUBJECT` exactly.
- Publication is atomic: assets land on a draft release, and the draft only becomes public after the
  complete verified macOS + Windows set is present. A single-platform failure cannot leave a
  half-published release live.
- Auto-update through `electron-updater` is wired to the same GitHub Releases feed, so once the first
  signed release ships, subsequent updates reach users without another manual install.
- Enterprise policy controls (SSO, license gate, provider policy, transcript encryption, redaction,
  retention) are implemented and lockable machine-wide via `managed-config.json`.

Reference docs in the repo: `docs/SIGNING.md` (credential requirements per channel) and
`docs/ENTERPRISE_RELEASE.md` (operator checklist).

---

## What we need from IT — checklist

- [ ] Enroll Mantu in the Apple Developer Program (organization enrollment; paid annual fee, current
      amount to be confirmed on Apple's site).
- [ ] Create a Developer ID Application certificate; export as `.p12` and supply the export password.
- [ ] Generate an app-specific password for the notarization Apple ID.
- [ ] Supply the Apple Team ID.
- [ ] Raise/restore the GitHub Actions budget on the account owning `mysticalsin/AskToto-Mantu`, sized
      for macOS runner minutes, and confirm the billing owner.
- [ ] Load `GH_TOKEN`, `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
      `APPLE_TEAM_ID` as repository secrets.
- [ ] (Windows) Supply an Authenticode `.pfx` + password + exact Subject string, or approve the
      internal self-signed + GPO/Intune trust route in `docs/ENTERPRISE-DEPLOY-WINDOWS.md`; load as
      `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `WIN_CSC_EXPECTED_SUBJECT`.
- [ ] (Outlook) Create the single-tenant Entra app registration described in section 3 and supply the
      client ID and tenant ID.

Certificates and passwords should be handed over through whatever secure channel IT normally uses for
credential transfer. They do not need to be shared with anyone beyond whoever loads them into the
repository secrets store, and they are never written into the codebase.

---

## What happens once we have it

- With the Actions budget restored, CI starts running again immediately: typecheck, tests, and build
  workflows go green or surface real failures instead of dying in 3 seconds.
- With the Apple credentials loaded, pushing a `v*` tag produces a signed, notarized macOS `.dmg` plus
  a signed Windows installer, published together as a single verified GitHub Release.
- Users download the `.dmg` and it opens normally. No Gatekeeper malware warning, no System Settings
  detour, no instructions needed for non-technical staff.
- Auto-update goes live: every subsequent release reaches installed users automatically.
- With the Entra registration, the "Connect Outlook calendar" button activates and Métis can show the
  user's agenda for the day.

**Impact if not provided:** while the Actions budget block stands, no CI or release gate can execute at
all. Without the Apple certificate there is no customer-distributable macOS build — the app cannot be
installed by anyone who is not willing to work around a malware warning. Without the Windows
certificate or the internal-trust route, the workflow refuses to publish Windows installers. Without
the Entra registration, the Outlook agenda feature stays dormant.
