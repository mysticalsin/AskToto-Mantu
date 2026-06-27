# AskToto — Incident Response Runbook

Scope: AskToto 0.1.0, local desktop app. Incidents are **endpoint-scoped** (one user, one machine) —
there is no service breach, no shared datastore, no blast radius beyond the device and the third-party
accounts the user's keys touch. Evidence = `file:line`.

Date: 2026-06-27.

---

## 1. Severity classification

| Sev | Definition (this app) | Examples |
|-----|-----------------------|----------|
| CRITICAL | Secret exposed, or sensitive data leaves to an unintended party | API key leaked; transcripts exfiltrated; key found in a build artifact |
| HIGH | Sensitive data at risk but not confirmed exposed | Laptop lost with plaintext transcripts in OneDrive; malicious provider/model output acted on |
| MEDIUM | Limited impact / degraded function | Dependency CVE with low reachability; corrupted settings |
| LOW | Cosmetic / no data impact | UI glitch; spurious permission prompt |

## 2. Playbooks

### 2.1 Leaked / suspected-compromised provider API key (CRITICAL)
1. **Revoke at the provider** immediately (Anthropic/OpenAI/Dust/etc. console) — this is the only true
   containment; the local copy is just a convenience.
2. In AskToto: Settings → clear the key (`clearApiKey` → `rmSync(key-<provider>.bin)`, `store.ts:204-207`).
3. If the key was set via env var, rotate the env source.
4. Review provider usage/billing for anomalous calls.

### 2.2 Lost / stolen device (HIGH)
1. **At-rest posture**: keys/settings/session are safeStorage-encrypted and bound to the OS account
   (`store.ts:186-202`, `auth.ts:122-131`); they are **not** decryptable on another machine/account.
2. **Exposure risk**: meeting transcripts are **plaintext by default** and may sit in OneDrive
   (`transcripts.ts:202,257,118-150`). Treat their content as potentially exposed.
3. Trigger org remote wipe (Intune/Jamf) if managed; change the OS account password.
4. Rotate all provider keys (§2.1) and Dust token; sign out invalidates the local session
   (`auth.ts:247-254`).
5. Remediate: enable `encryptTranscripts` and/or move notes off OneDrive going forward.

### 2.3 Prompt-injection / malicious model output (HIGH/MEDIUM)
1. Untrusted modes (suggest/summary/recap/vision) append an injection guard to the system prompt
   (`personas.ts:70-77`, verified in `selftest.ts:110-122`). Dust folds the guard into the message
   (`llm.ts:135-141`).
2. If output attempts to exfiltrate or instruct destructive actions: the renderer is sandboxed and
   cannot execute privileged actions without crossing the guarded IPC boundary. Do not act on
   suspicious instructions; report the transcript.

### 2.4 Supply-chain incident (CRITICAL/MEDIUM)
1. **Dependency CVE**: run `npm audit`; current baseline 27 advisories (0 critical), prod-shipped ones
   are transitive ReDoS/DoS under `@dust-tt/client` (VENDOR review). Patch via `npm audit fix` /
   dependency bump, rebuild, release.
2. **Model integrity** (Whisper no-SRI): if HF model compromise is suspected, clear the model cache and
   pin/verify a known-good revision (`whisper.worker.ts:2,19`).
3. **Tampered installer**: because signing is not yet configured, integrity rests on the download
   channel — verify checksums; once signing is live, verify the signature (DEPLOYMENT_RUNBOOK).

### 2.5 Secret in a build artifact (CRITICAL)
1. `.env` is gitignored and currently holds only an empty NVIDIA key, but it sits under OneDrive sync
   (`.env`, `.gitignore`). Confirm no real secret is present before any share.
2. electron-builder packs only `out/**` + `package.json` (`electron-builder.yml:9-14`); verify no key
   files are bundled.

## 3. Communication

Single user → no external notification path is built in. For a **managed** rollout, escalate per the
org's incident process. If third-party (other meeting participants') personal data is involved, the
**deploying org's DPO** assesses GDPR Art. 33/34 breach-notification obligations (this app provides no
automated breach reporting — by design, no telemetry).

## 4. Post-incident

- Capture the `electron-log` file (local) for timeline (`updater.ts:5`).
- Update this runbook and `production-readiness/UNKNOWN_ITEMS.md` with any new gap.

## 5. N/A

- Service rollback / customer-wide comms / status page — **N/A** (no service, no multi-customer impact).
