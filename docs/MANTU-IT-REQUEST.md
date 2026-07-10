# Métis — request to Mantu IT (unblocks distribution + Outlook)

**From:** Tony Walteur  **Re:** two things needed to ship Métis (the AI meeting-copilot desktop app) to
real users. The app is built and working locally; these are the only blockers to a signed, installable build
and the Outlook agenda feature. Nothing here exposes secrets in the codebase — all credentials are read from
environment variables / a managed-config file at build/run time.

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

(Windows is out of scope for v1 — macOS first. If/when we ship Windows we'll need Authenticode or Azure
Trusted Signing + a Windows signing runner.)

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

**Impact if not provided:** without #1 the app can't be installed by anyone but me; without #2 the "Connect
Outlook calendar" button stays in its dormant "needs org sign-in" state. Both are wired and ready — they go
live the moment these values are set.
