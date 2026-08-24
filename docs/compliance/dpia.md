DRAFT — for DPO review, not yet adopted. Prepared 2026-07-11.

# Data Protection Impact Assessment (GDPR Article 35)

**DPIA ID:** AKT-DPIA-001 (draft) **Date:** 2026-07-11 **DPO:** [name — to be filled in by DPO's office]
**Project owner:** Tony Walteur (Chief of Staff, sole user and product owner of AskToto/Métis)

Related documents: [`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md),
[`article-30-record.md`](./article-30-record.md), [`recording-policy.md`](./recording-policy.md),
[`ai-act-checklist.md`](./ai-act-checklist.md), [`data-flow-onepager.md`](./data-flow-onepager.md).

**A note on timing (no back-dating):** the recording/transcription/local-storage processing described here
has been operating without a prior formal DPIA on file. This document is written now, as the first DPIA for
that processing, rather than pretended to predate deployment. It is also written **before** the planned
Phase 5 feature (plaintext entity pages + note cards published for Dust to read) is built, so that,
consistent with the Article 35 principle, this new processing is assessed before it begins rather than
after. Phase 5 items below are marked **"(planned)"** throughout and this DPIA must be re-checked against
the actual Phase 5 implementation before that feature is turned on for real use.

## 1. Necessity of DPIA

**Article 35 triggers considered:**
- *Innovative use of technology* — yes: on-device automatic speech recognition + LLM-based entity/deal
  extraction over personal conversations.
- *Systematic monitoring* — partial: the tool systematically processes every meeting the Chief of Staff
  chooses to record, including recurring counterparties, building a persistent profile-like record (deal
  history, commitments, entity pages) of external contacts and (if in scope, see §6 below) colleagues over
  time.
- *Large-scale / special-category processing* — no, single-user scale; special-category data is possible
  incidentally (a participant mentioning health, union membership, etc. in conversation) but not
  systematically collected by design.

Given the innovative-technology and systematic-monitoring-like triggers, a DPIA is warranted even though
volume is single-user. Proceeding under the Iron Law: assessed now, mitigations mapped to code, before the
next processing expansion (Phase 5 publishing) ships.

## 2. Processing description

**Purposes:**
1. Produce accurate minutes, action items, and follow-up drafts from the Chief of Staff's meetings.
2. Maintain a running record of accounts/people/deals derived from meeting content (the "brain").
3. (Planned — Phase 5) Make derived, human-reviewed meeting intelligence available to Dust.tt agents via
   the OneDrive connector, for the Chief of Staff's own querying.

**Legal basis (Article 6):** Legitimate interest (6(1)(f)) for external/business-counterparty meetings —
see [`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md). **Open, unresolved for
internal Mantu-employee meetings** — see §6.

**Legal basis (Article 9):** No special-category data is intentionally collected. Incidental mentions
(health, religion, political opinion, union activity) may appear in verbatim transcript text or a quoted
extraction field; no Article 9 basis is established for that incidental content today. Mitigation: human
review before anything derived is published or acted upon (Review screen), and the planned per-meeting
confidential flag (Phase 5) for meetings expected to touch sensitive topics (HR, legal, M&A).

**Categories of personal data:**
- Verbatim meeting transcript text (names, roles, opinions, business figures, as spoken).
- AI-derived summary, action items, and entity/deal extraction (names, organizations, roles, deal amounts,
  commitments, quotes).
- Audio, transiently, during live transcription only (not persisted — see §4 data flow).
- Calendar metadata (attendee names/emails) where calendar integration is used to auto-detect a meeting.
- Local audit-log metadata (event type, provider, timestamps, byte counts — explicitly never message or
  transcript content, per `src/main/logger.ts`'s own documented contract).

**Categories of data subjects:** the Chief of Staff (controller-side user); external meeting participants
(clients, prospects, candidates, vendors, partners); potentially Mantu employees, if internal meetings are
in scope (§6).

**Data sources:** live microphone/system-audio capture during a meeting; user-imported audio/video files;
calendar metadata (Microsoft 365).

**Recipients / processors:**
- Microsoft 365 / OneDrive (storage of the encrypted brain/transcript files; already covered by Mantu's
  M365 DPA — see [`tenant-checklist.md`](./tenant-checklist.md)).
- The cloud LLM provider selected in Settings, if any (`src/shared/providers.ts` lists 18 entries, 17 of
  them remote: Anthropic, OpenAI, NVIDIA NIM, DeepSeek, Qwen, MiniMax, Kimi, OpenRouter, Groq, Mistral,
  Grok, Gemini, Dust, Cloudflare, plus a custom OpenAI-compatible endpoint and two CLI passthroughs. The
  18th, `local`, is the on-device model and transmits nothing). Only the provider(s) actually configured
  receive data; this is a per-user setting, not a fixed list of live recipients.
- Cloudflare, when selected, is **two** recipients rather than one, because it is not called directly:
  the prompt goes to a Worker the operator deploys into their own Cloudflare account (that account holds
  the Cloudflare API token as a Wrangler secret; Métis never has it), and from there to
  `api.cloudflare.com`, which under Unified Billing serves the request from Workers AI, OpenAI, Anthropic
  or Google depending on the configured `{provider}/{model}` id. If the operator's AI Gateway has logging
  enabled, prompts and completions are stored in that Cloudflare account. See
  [`../CLOUDFLARE.md`](../CLOUDFLARE.md).
- Dust.tt — today only as an optional Q&A provider over the corpus (existing); **(planned — Phase 5)**
  additionally as a read recipient of published entity pages/note cards via the OneDrive connector, gated
  by the `publishBrainPages` setting (default follows `!encryptTranscripts`) and a per-meeting confidential
  flag.
- No recipient receives raw audio; local ASR means audio is never transmitted to any of the above.

**Retention:** no automated retention/deletion exists today (deletion is manual, user-triggered via the
existing `transcript.deleted` action). Target defaults are proposed in
[`recording-policy.md`](./recording-policy.md), to be built in Phase 8 ("Retention automation").

**International transfers:** depends entirely on which cloud LLM provider (if any) is configured. Mistral
is EU-hosted. Dust supports an EU workspace (`eu.dust.tt`) but defaults to `dust.tt` unless explicitly
configured otherwise. The remaining providers (Anthropic, OpenAI, NVIDIA, DeepSeek, Qwen, MiniMax, Kimi,
OpenRouter, Groq, Grok, Gemini, Cloudflare) are non-EU-hosted as far as is known without vendor-by-vendor
verification; no SCC/adequacy inventory exists per provider today. Cloudflare carries a second, local
variable: the transfer depends on the region of the operator's own Cloudflare account *and* on whichever
upstream lab the configured model id resolves to, so it must be recorded per deployment rather than once
for the product. **See open question in [`README.md`](./README.md).**

## 3. Necessity and proportionality

Covered in detail in [`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md) §2. Summary:
the purpose could not be achieved with materially less data (accurate structured minutes require
transcription); it is achieved with less intrusive means where the architecture already allows it (local
ASR, no persisted audio, encryption, optional local-only LLM path). The open gap is that cloud LLM use,
when the user selects it, does send substantive transcript content (minus redacted secret patterns) to a
third-party processor — a genuine, currently-live intrusion whenever a cloud provider is the active
setting.

## 4. Data flow

```
 Live meeting audio (mic + system audio)
   │  in-memory only — never written to disk (verified: no audio-file write path in listen.ts)
   ▼
 Local ASR (Parakeet default / Whisper fallback) — on-device, no network call
   │
   ▼
 Local transcript text ──────────────► saved to <meetingsFolder>/*.md
   │                                     (encrypted at rest if encryptTranscripts=true, default on;
   │                                      OneDrive-synced if meetingsFolder resolves there — default
   │                                      behavior when OneDrive is detected)
   ▼
 Extraction / summarization call (brain/ingest.ts)
   │  redactSensitive=true (default): strips card/SSN/API-key patterns from the COPY sent to the model;
   │  the on-disk transcript keeps the verbatim original either way.
   ▼
 ┌───────────────────────────────┬─────────────────────────────────────────┐
 │ Local LLM (Qwen3, packaged    │ Cloud LLM provider (per user Settings)   │
 │ local AI — in active dev)     │ e.g. Anthropic / OpenAI / Mistral / Dust │
 │ no network egress             │ transcript excerpt + prompt leaves the   │
 │                                │ device to that provider's API            │
 └───────────────────────────────┴─────────────────────────────────────────┘
   │
   ▼
 Brain JSON (accounts/people/deals) + recap markdown
   │  encrypted at rest under the same encryptTranscripts flag; OneDrive-synced
   ▼
 (planned — Phase 5) publish.ts regenerates:
   entities/{accounts,people,deals}/<id>.md · per-meeting note cards · entities/index.md
   │  gated by publishBrainPages (default = !encryptTranscripts) + per-meeting confidential flag
   │  currently: graphify.ts refuses to run over an encrypted folder, so under today's default
   │  (encryption on), the corpus is NOT plaintext-readable by Dust or graphify — this changes
   │  once Phase 5 ships and a user opts in under encryption (explicit, audit-logged consent)
   ▼
 Dust.tt agents — read-only, via the Microsoft OneDrive connector (pull; no API push)
```

## 5. Risk assessment

| # | Risk | Likelihood | Severity | Inherent risk | Mitigations (mapped to concrete features) | Residual risk |
|---|---|---|---|---|---|---|
| R1 | Plaintext egress of derived meeting intelligence to Dust once published (**planned, not yet built**) | M | H | H | `publishBrainPages` consent gate (opt-in, audit-logged, especially required if enabling under encryption) — planned Phase 5; per-meeting **confidential flag** excluding HR/M&A/legal meetings from publishing — planned Phase 5; derived-only content (recap-based note cards, never verbatim transcript) — planned Phase 5 design; Article 50 `ai_generated` frontmatter for provenance — planned Phase 5 | M (until shipped and field-tested; re-assess at Phase 5 ship) |
| R2 | Cloud-LLM egress of substantive meeting content when a cloud provider is configured (**live today**) | H (whenever a cloud provider is the active setting) | M | H | `redactSensitive` strips secret patterns only (default on) — does not stop name/business-content egress by design; local LLM path (Qwen3) as a no-egress alternative — in active development, not yet default; injection-guard on the extraction prompt (transcript treated as untrusted data, not instructions) | M — genuinely live exposure whenever cloud is selected; residual risk depends on which provider (see open question, README) |
| R3 | OneDrive sharing misconfiguration exposing the meetings folder beyond the intended exec + Dust identity | L | H | M | Tenant-side Purview sensitivity label + folder ACL + oversharing assessment — **outside the app**, see [`tenant-checklist.md`](./tenant-checklist.md); not an app-level control | M (depends entirely on IT executing the tenant checklist) |
| R4 | Second-device key loss — encrypted brain/transcript store is undecryptable on any machine other than the one that encrypted it (device-bound key via OS keychain/`safeStorage`, `ATKENC2` format, verified in `src/main/store.ts`) | M (laptop replacement, OS reinstall, keychain reset) | H (total loss of the Chief of Staff's meeting-intelligence history) | H | Encrypted-brain export/escrow + documented recovery procedure — **planned Phase 8, not yet built**; today, no mitigation exists beyond the user's own backup discipline | H until Phase 8 ships — **flag as the single highest current residual risk** |
| R5 | Misattribution / ASR errors leading to a wrong record (wrong company, wrong figure, wrong commitment) persisting into the brain and any downstream summary | M | M | M | Human review at Review.tsx before recap is finalized (shipped); confidence tags are currently **model self-report only** — no code checks a quote is a substring of the transcript (confirmed gap); deterministic **verifier** (`verifyExtraction()`, fuzzy-alignment against the transcript, numerals validated) — **planned Phase 4, not yet built**; "stated but unverified — pin manually?" UX — planned Phase 4 | M until the verifier ships; mitigated today only by manual review discipline |
| R6 | Notice/consent gap — participants are not reliably informed before recording | M | M | M | In-app reminder to the organizer exists (`RecordingConsentReminder.tsx`) but is not participant-facing and not audit-logged as a consent event; standardized EN/FR notice text — see [`recording-policy.md`](./recording-policy.md), an organizational control, not yet a logged app event (planned Phase 8: "Consent/notice UX on recording start, logged") | M until notice practice is adopted and (later) logged |
| R7 | Audit log is not tamper-evident and cannot itself support a DSAR/erasure or incident investigation with strong integrity guarantees | L | M | L-M | Hash-chained JSONL audit log + export command — **planned Phase 8, not yet built**; today: append-only-in-practice electron-log file, 5MB rotation, no cryptographic chaining | L-M |
| R8 | No DSAR/erasure tooling — an Article 15/17 request for a given person's data would require manual search across transcripts, brain JSON, and (once built) published pages/graph nodes | L (single-user tool, low request volume expected) | M | L-M | DSAR/erasure command with legal-hold flag — **planned Phase 8, not yet built** | L-M |

## 6. Open question — internal (Mantu-employee) meetings

Same issue as the LIA §6: if internal Mantu meetings are recorded, the data subjects include employees,
which raises the legal-basis and CSE-consultation questions documented in
[`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md) §6 and
[`recording-policy.md`](./recording-policy.md). This DPIA's risk table assumes external/business-counterparty
meetings as the primary scope; if internal use is confirmed, re-run this DPIA section with employment-context
risks (e.g., chilling effect on internal speech, potential Annex III #4 employment-domain brush under the
AI Act if any extracted content is ever used to inform an employment decision) added explicitly.

## 7. Residual risk summary

Highest residual risk today is **R4 (key custody / second-device recovery)** — a real, present-day gap with
no mitigation yet, unlike R1 which is a pre-ship risk on a not-yet-built feature. **R2 (cloud-LLM egress)**
is the second highest live risk and is entirely within the Chief of Staff's control via the provider setting.
Recommend prioritizing Phase 8's key-custody item and resolving the open provider-transfer question ahead of,
or alongside, the Phase 5 publish work.

## 8. Sign-off

- [ ] DPO
- [ ] Project owner (Tony Walteur)
- [ ] Legal (controller entity name, Art 30 register entry)
- [ ] Information Security (key custody plan, audit log hardening)
- [ ] Supervisory authority (Article 36) — not triggered; no residual risk assessed as HIGH after
      mitigations other than R4, which is a data-loss/availability risk rather than a confidentiality risk
      requiring CNIL consultation. Revisit if DPO disagrees.

## 9. EU AI Act overlay

See [`ai-act-checklist.md`](./ai-act-checklist.md) for the full classification and Article 50 transparency
plan. Summary: AskToto is assessed as a **Limited-risk** AI system (Article 50 transparency obligations
apply; no Annex III high-risk domain is triggered under current, single-executive, non-employment-decision
use) — contingent on the guardrail that extracted content about Mantu colleagues is never used to inform an
employment decision (hiring, promotion, termination, task allocation, monitoring/evaluation), which would
trigger Annex III #4.
