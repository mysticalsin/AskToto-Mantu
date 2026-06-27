# AskToto — Asset Register

Single-user local desktop app. "Owner" = the responsible party for a local app (end user = Tony; app
maintainer = Tony Walteur / Mantu; provider = the third party whose API/CDN holds it in transit).
Sensitivity: CRITICAL / HIGH / MEDIUM / LOW.

## Information assets

| Asset | Location | Owner | Sensitivity | Notes |
|-------|----------|-------|:---:|-------|
| Provider API keys | `userData/key-<provider>.bin` (encrypted) | End user | **CRITICAL** | safeStorage; never reaches renderer; throws if no keychain (`store.ts:195-201`) |
| Dust OAuth token | `userData/key-dust.bin` (encrypted) | End user | **CRITICAL** | short-lived; imported from OS keychain |
| Azure identity + session | `userData/auth-session.bin` (encrypted) | End user | **HIGH** | email/name/tenant; sent to Dust as attribution |
| Meeting transcripts | notes folder markdown (OneDrive default) | End user | **HIGH** | plaintext default; opt-in `ATKENC1`; may contain client-confidential speech |
| Profile PII (resume/JD/notes) | `userData/settings.json` (encrypted) | End user | **HIGH** | folded into prompts in interview/sales |
| Imported context docs | `userData/settings.json` (encrypted) | End user | **HIGH** | per-mode; capped 25 docs / 120 KB each (`ipc.ts:194-199`) |
| Screenshots (Capture) | RAM only, not persisted | End user | **MEDIUM** | base64 JPEG → vision model then discarded |
| Live audio frames | RAM only, bounded queue | End user | **MEDIUM** | transcribed on-device; never sent raw |
| Notes knowledge graph | `userData/graph/graph.json`,`graph.html` | End user | **MEDIUM** | derived from notes; may be sent to LLM if API backend |
| Settings / managed-config | `userData/settings.json`, `managed-config.json` | End user / IT | **MEDIUM** | org policy + locked keys; no secrets in managed-config |
| `index.md` (titles/dates) | notes folder | End user | **LOW** | plaintext; skipped when encryption on |
| App logs | electron-log default path | End user | **LOW** | updater/error logs; avoid logging secrets (verify) |
| `.env` | repo root (OneDrive-synced) | Maintainer | **MEDIUM** | gitignored but cloud-synced; only empty NVIDIA key now (`.env`) |

## Code / build assets

| Asset | Location | Owner | Sensitivity | Notes |
|-------|----------|-------|:---:|-------|
| Source repo | project root (no git yet) | Maintainer | **MEDIUM** | not version-controlled → no history/integrity baseline |
| Build config | `electron-builder.yml`, `electron.vite.config.ts` | Maintainer | **MEDIUM** | signing env-driven, unconfigured |
| CI pipeline | `.github/workflows/build.yml` | Maintainer | **MEDIUM** | no signing secrets; artifacts unsigned |
| App icons / entitlements | `build/icon.png`, `build/entitlements.mac.plist` | Maintainer | **LOW** | hardened-runtime entitlements present (`:24-31`) |
| graphify runner | `resources/graphify_runner.py` | Maintainer | **LOW** | spawned; API key via env not argv |
| Code-signing certs | external (`CSC_LINK`/`APPLE_*`/`WIN_CSC_*`) | Maintainer/IT | **CRITICAL** | NOT held in repo; not configured (see UNKNOWN) |

## Third-party / dependency assets

| Asset | Provider | Owner | Sensitivity | Notes |
|-------|----------|-------|:---:|-------|
| Whisper ONNX model | Hugging Face CDN | HF | **MEDIUM** | fetched on first Listen, **no SRI** (supply-chain gap) |
| npm dependencies | npm registry | maintainers | **MEDIUM** | run `npm audit` for current CVE posture (not run here) |
| LLM provider APIs | Anthropic/OpenAI/Dust/etc. | provider | **HIGH** | receive prompts incl. PII/transcripts/screenshots |
| Local `claude` CLI | user-installed | End user | **LOW** | graphify default backend (no key) |
| Dust CLI keychain entry | OS keychain | End user | **HIGH** | read via `security`; triggers OS allow prompt |

## Identity & access assets

| Asset | Mechanism | Owner | Sensitivity | Notes |
|-------|-----------|-------|:---:|-------|
| Azure AD (Entra) SSO | MSAL PKCE public client, domain-locked | IT/End user | **HIGH** | optional; **no-op gate when unconfigured** (`auth.ts:152-155`) |
| OS permissions (mic/screen/accessibility) | macOS TCC / Windows | OS / End user | **HIGH** | gates audio + meeting detect + screenshot |
| safeStorage / OS keychain | OS-managed key | OS | **CRITICAL** | root of all at-rest encryption; loss = settings/keys unreadable (fails safe) |
