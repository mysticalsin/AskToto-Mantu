# AskToto — Privacy Review

Scope: AskToto 0.1.0, a **local** Electron desktop app (macOS + Windows). No server, no database, no
multi-tenant backend. The data subject is the **user themselves on their own device**; the user is, in
GDPR terms, effectively the controller of their own data, and AskToto is the local tool that processes
it under their direction. This is an **evidence package, not a certification**.

Date: 2026-06-27. Evidence = `file:line` and real command output.

---

## 1. Data inventory (personal / sensitive data the app touches)

| Data category | Personal data? | At rest | Evidence |
|---------------|:---:|---------|----------|
| Provider API keys | secret (not PII) | `userData/key-<provider>.bin`, safeStorage-encrypted, `0o600` | `store.ts:186-202` |
| Profile (name/role/company/resume/JD/notes) | **PII** | inside `userData/settings.json`, `ATKENC1` whole-file encrypted | `store.ts:100-140`, `selftest.ts:17` |
| Imported context docs | PII likely | inside `userData/settings.json` (encrypted) | `store.ts:100-104` |
| Meeting transcripts / notes | **PII + possibly third-party PII** (other speakers) | notes folder markdown; plaintext by default, opt-in `ATKENC1` | `transcripts.ts:39-62,202,257` |
| Live audio | biometric-adjacent (voice) | RAM only, bounded queue; never written, never sent raw | DATA_FLOW.md; `whisper.worker.ts` |
| Screenshots (Capture) | possibly PII on screen | RAM only, not persisted | `index.ts:450-476` |
| Azure identity (email/name/tid) | **PII** | `userData/auth-session.bin`, safeStorage-encrypted | `auth.ts:101-131` |
| Dust OAuth token | secret | `userData/key-dust.bin`, encrypted | `dustcli.ts`, `index.ts:432` |
| App logs (updater/errors) | low | electron-log default path | `updater.ts:5,16-32` |

## 2. Data flow / who sees the notes

Reproduced and verified from source (see `DATA_FLOW.md`):

1. **The user** — owns every artifact on their machine.
2. **The chosen LLM provider** — receives the prompt for `ask:start`: question + profile (interview/sales
   modes only) + context docs + transcript slice and/or screenshot (`llm.ts:15-80`, `index.ts:478-560`).
   Egress is over the SDK's HTTPS. PII/transcripts/screenshots leave the device here.
3. **OneDrive** — if the notes folder resolves under a OneDrive sync root (the default), the markdown
   transcripts passively sync to Microsoft (`transcripts.ts:118-150`). With encrypt-transcripts OFF
   (default), they sync as **plaintext**.
4. **Dust** — when the Dust provider is used, the signed-in user's email/name/username/timezone is
   attached as message context for attribution (`llm.ts:81-100`), plus the conversation content.
5. **Hugging Face CDN** — the Whisper ASR model is fetched on first Listen (`whisper.worker.ts:2,19`).
   No personal data is sent; this is a model download (but see no-SRI finding).
6. **Microsoft Entra** — only if SSO is configured: OAuth PKCE sign-in (`auth.ts:157-245`).

## 3. Data-minimization controls (verified)

- Audio is transcribed **on-device** (Whisper, Web Worker); only text can ever leave (`whisper.worker.ts`).
- Profile PII is folded into the prompt **only in interview/sales modes** (`personas.ts`, DATA_FLOW.md).
- Prompt size caps: profile 24 KB, context docs 40 KB, transcript slices 6–16 KB (`llm.ts:18-40`).
- Keys never serialized to the renderer — only `hasKeys` booleans (`index.ts:110-127`, `store.ts:312-316`).
- **No telemetry, analytics, or crash reporting.** Verified: `grep -rn "crashReporter|Sentry|analytics|telemetry|setUploadToServer" src/` → only `electron-log` (local file) is present. This is a privacy-positive design choice.

## 4. Retention & deletion (data subject rights, self-service)

| Right | How exercised | Evidence |
|-------|---------------|----------|
| Erasure — API key | Settings → clear key → `rmSync(key-<provider>.bin)` | `store.ts:204-207` |
| Erasure — identity/session | Sign out → `rmSync(auth-session.bin)` | `auth.ts:247-254` |
| Erasure — transcripts/notes | User deletes the markdown files in the notes folder (plain files) | `transcripts.ts` (plain `.md`) |
| Erasure — profile/context | Edit/clear in Settings; sparse overrides re-serialized | `store.ts:162-184` |
| Rectification | All profile/settings editable in-app | `Settings.tsx` |
| Portability | Notes are open markdown; settings are local JSON (decryptable on same OS account) | `transcripts.ts`, `store.ts:106-127` |
| Restriction | Turn off auto-save / Listen; encrypt-transcripts toggle | `Settings.tsx:1519-1533` |

Retention is **manual** — there is no automated purge/TTL. Appropriate for a single-user local tool,
but should be stated in user-facing docs.

## 5. Consent posture

- Recording consent reminder shown while Listen is active: "Other participants are being recorded.
  Make sure everyone has consented." (`RecordingConsentReminder.tsx:50`, `consent.ts`).
- Visible recording indicator while capturing (`RecordingIndicator.tsx:11-16`).
- Content protection on by default hides the overlay from screen capture (`index.ts` `setContentProtection`).
- OS-level consent: mic/screen/accessibility gated by macOS TCC / Windows privacy (`platform-perms.ts`).

## 6. Findings

| Sev | Title | Evidence | Fix |
|-----|-------|----------|-----|
| HIGH | Transcripts plaintext by default → sync to OneDrive + sent to LLM provider | `ipc.ts` default `encryptTranscripts:false`; `transcripts.ts:202,257`; `transcripts.ts:118-150` | For sensitive-data deployments, set `encryptTranscripts:true` via managed-config and/or point notes folder outside OneDrive; document the trade-off (encrypted notes can't be read by Dust/recall/graph). |
| HIGH | PII/transcripts/screenshots egress to third-party LLM providers without enforced DPA | `llm.ts`, `index.ts:478-560`; `UNKNOWN_ITEMS.md #17` | Org must restrict to approved providers with DPAs; consider a managed-config provider allowlist. |
| MEDIUM | Whisper model fetched from HF CDN with no subresource integrity | `whisper.worker.ts:2,19` | Pin/bundle the model or verify a hash before use. |
| LOW | No in-app privacy notice / data inventory surfaced to the user | no privacy screen in `Settings.tsx` | Add a short "what leaves your device" panel; reuse `DATA_FLOW.md`. |
| LOW | No documented retention guidance (manual only) | no TTL/purge in `transcripts.ts` | State manual-retention expectation in README/onboarding. |

## 7. Gate 13 (Privacy)

**PASS** — the privacy *controls* a local app needs are implemented and verified: on-device
transcription, key isolation from the renderer, encryption-at-rest available (always-on for keys/settings,
opt-in for transcripts), no telemetry/crash reporting, and consent UX. Residual risks (plaintext-default
transcripts, third-party egress without DPA, model no-SRI) are **deployment-policy decisions**, surfaced
above as conditions for a sensitive-data release — not code defects.
