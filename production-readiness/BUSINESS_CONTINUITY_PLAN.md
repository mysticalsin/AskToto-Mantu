# AskToto — Business Continuity Plan

Scope: AskToto 0.1.0 is a **personal-productivity desktop tool**, not a business-critical service. There
is no SLA to maintain, no customers depending on uptime, and no revenue path through the app. "Continuity"
means: can the user keep working when a component is unavailable? Evidence = `file:line`.

Date: 2026-06-27.

---

## 1. Criticality assessment

AskToto is an **assistive overlay** — it augments meetings/interviews. If it is unavailable, the user
falls back to manual note-taking and/or talking to their LLM provider directly. **No business process
hard-depends on AskToto.** This bounds the continuity requirement to "graceful degradation," not "high
availability."

## 2. Dependency outage → continuity response

| Dependency unavailable | Effect | Continuity action | Built-in? |
|------------------------|--------|-------------------|:---:|
| A single LLM provider | No answers from that provider | Switch to one of 13 others in Settings | Yes (`providers.ts:37-243`) |
| All LLM providers | No AI answers | Listen still transcribes on-device; user works manually; transcripts still saved | Partial (`whisper.worker.ts`, `transcripts.ts`) |
| Hugging Face CDN (first run) | Whisper model can't download → no transcription | Use the app for ask/recap with typed input; retry Listen later | Degrades (`whisper.worker.ts`) |
| OneDrive | Notes don't sync (still written locally) | Local notes remain; sync catches up later (fail-open folder, `transcripts.ts:100-102`) | Yes |
| Microsoft Entra (SSO on) | Can't sign in → privileged actions blocked | IT can temporarily relax SSO via managed-config | Partial (`auth.ts`) |
| Dust | Dust agent answers fail | Switch to a direct provider | Yes |
| Update host | No auto-updates | App keeps running on current version | Yes (`updater.ts:14-18`) |

## 3. Single points of failure

| SPOF | Mitigation |
|------|-----------|
| The user's machine | DR plan (reinstall + OneDrive restore); org device-replacement process |
| OS keychain (roots all encryption) | Fails safe — undecryptable → defaults, never bricks (`store.ts:114-127`) |
| The maintainer (single developer) | Source is self-contained; package-lock committed for reproducible builds; CI defined (`.github/workflows/build.yml`) |

## 4. Continuity for a managed/enterprise rollout

- Standardize config + SSO + notes location via machine-wide managed-config (`store.ts:78-98`).
- Endpoint backup/EDR/remote-wipe handled by the org's MDM (Intune/Jamf), not by AskToto.
- Keep an internal mirror of the install artifact + update host so distribution does not depend on a
  single external link.

## 5. Findings

| Sev | Title | Evidence | Fix |
|-----|-------|----------|-----|
| LOW | Bus-factor of 1 (single maintainer), repo not yet under git in this checkout | env note ("NOT a git repo") | Initialize git, push to org remote, enable the existing CI; document a second maintainer |
| LOW | First-run transcription hard-depends on HF CDN reachability | `whisper.worker.ts:2` | Bundle/pin the model (also closes the no-SRI gap) for offline-first continuity |

## 6. N/A (justified)

- **SLA / uptime commitments / multi-site continuity** — N/A: no service, no customers, no availability
  obligation. Continuity is per-user graceful degradation, which is verified above.
