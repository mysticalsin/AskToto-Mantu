# Métis — request to Mantu IT (unblocks distribution + Outlook)

**From:** Tony Walteur  **Re:** what's needed to ship Métis (the AI meeting-copilot desktop app) to
real users. The app is built and working locally; the items below are the only blockers to a signed,
installable build and the Outlook agenda feature. Nothing here exposes secrets in the codebase — all
credentials are read from environment variables / a managed-config file at build/run time.

**Most urgent — GitHub Actions on this repo is currently billing-blocked:** every CI run (build and
release) fails immediately with zero steps executed, regardless of the signing items below. This needs
org billing fixed before any of the signing/build work can even run in CI.

---

## 1. Apple Developer ID — code-signing + notarization (macOS)

Needed so the app installs on any Mac without Gatekeeper blocking it ("unidentified developer"). Today the
build is unsigned and cannot be distributed.

Please provide / set up:
- **Apple Developer ID Application certificate** (.p12) + its password — from the Mantu Apple Developer
  account (Account Holder / Admin role).
- An **App Store Connect API key** OR an **app-specific password** for the notarization Apple ID.
- The **Apple Team ID**.

These map to the build env vars the release script already reads:
| Need | Env var |
|---|---|
| Cert (base64 .p12) | `CSC_LINK` |
| Cert password | `CSC_KEY_PASSWORD` |
| Notarization Apple ID | `APPLE_ID` |
| App-specific password | `APPLE_APP_SPECIFIC_PASSWORD` |
| Team ID | `APPLE_TEAM_ID` |

**Windows update:** Windows installers already ship today (unsigned — `Metis-Setup-*.exe` and
`Metis-Portable-*.exe`), and `docs/SIGNING.md` documents a live `npm run release:win` pipeline gated
on Windows signing secrets that aren't set yet, so SmartScreen currently warns on every Windows
install. Please also provide:
- **Authenticode `.pfx` certificate** from a trusted CA (or a wired Azure Trusted Signing flow) +
  its password.

These map to:
| Need | Env var |
|---|---|
| Cert (Windows .pfx) | `WIN_CSC_LINK` |
| Cert password | `WIN_CSC_KEY_PASSWORD` |

## 2. Azure (Microsoft Entra) app registration — for Outlook agenda + sign-in

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

**Impact if not provided:** without the billing fix, no CI build or release can run at all; without #1
(macOS cert) the app can't be installed by anyone but me; without the Windows cert, Windows installs keep
triggering SmartScreen warnings; without #2 (Azure) the "Connect Outlook calendar" button stays in its
dormant "needs org sign-in" state. All are wired and ready — they go live the moment these values are set.
