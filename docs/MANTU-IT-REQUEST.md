# Métis — request to Mantu IT (unblocks distribution + Outlook)

**From:** Tony Walteur  **Re:** what's needed to ship Métis (the AI meeting-copilot desktop app) to
real users. The app is built and working locally; the items below are the only blockers to a signed,
installable build and the Outlook agenda feature. Nothing here exposes secrets in the codebase — all
credentials are read from environment variables / a managed-config file at build/run time.

**Most urgent external check:** GitHub Actions billing was reported blocked on 2026-07-10, with build
and release runs ending before their first step. Please confirm the current organization billing/run
state; if that failure still reproduces, it must be cleared before any repository gate can execute.

---

## 1. Apple Developer ID — code-signing + notarization (macOS)

Needed so the app installs on any Mac without Gatekeeper blocking it ("unidentified developer"). Local
verification builds are ad-hoc signed, not Developer ID signed/notarized, and are not customer releases.

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

**Windows update:** verification builds can produce unsigned `Metis-Setup-*.exe` and
`Metis-Portable-*.exe` artifacts, but the public tagged workflow refuses to publish them. Please also
provide:
- **Authenticode `.pfx` certificate** from a trusted CA (or a wired Azure Trusted Signing flow) +
  its password.
- The certificate's exact Subject string or common name for release-time identity verification.

These map to:
| Need | Env var |
|---|---|
| Cert (Windows .pfx) | `WIN_CSC_LINK` |
| Cert password | `WIN_CSC_KEY_PASSWORD` |
| Expected exact Subject or common name | `WIN_CSC_EXPECTED_SUBJECT` |

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

**Impact if not provided:** if the recorded billing block still exists, no CI gate can run; without #1
(macOS cert) there is no customer-distributable notarized Mac build; without the Windows certificate and
expected subject, the public workflow refuses to publish Windows installers; without #2 (Azure), the
"Connect Outlook calendar" button stays in its dormant "needs org sign-in" state.
