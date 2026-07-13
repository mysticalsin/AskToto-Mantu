DRAFT — for DPO review, not yet adopted. Prepared 2026-07-11.

# Legitimate Interest Assessment (GDPR Article 6(1)(f))

**Processing:** Recording, transcribing, and AI-summarizing the Chief of Staff's own business meetings via
AskToto ("Métis"). **Controller:** Mantu (exact contracting entity — verify with Legal; see
[`article-30-record.md`](./article-30-record.md)). **Scope of this LIA:** external and business-counterparty
meetings (clients, prospects, candidates, vendors, partners) attended by the Chief of Staff. **Out of
scope, pending §6:** meetings where the only other participants are Mantu employees in an
employment-context capacity — see the open question below before relying on this LIA for those.

Related documents: [`dpia.md`](./dpia.md) (full risk assessment), [`recording-policy.md`](./recording-policy.md) (notice text, retention), [`article-30-record.md`](./article-30-record.md) (processing record).

## 1. Purpose test

The Chief of Staff conducts a high volume of external meetings (client relationship management, vendor
negotiation, deal pipeline, hiring) and needs accurate minutes, action items, and a searchable history of
commitments and figures discussed — work that is materially degraded by hand-written notes taken while
also participating in the conversation. The purpose is legitimate and real: business record-keeping and
follow-through on an executive's own meetings, not surveillance of participants, not profiling, not any
form of automated decision-making about a participant.

## 2. Necessity test

- **Could the purpose be met with less data?** A pure human-memory or bullet-note approach was tried in
  practice and is measurably worse at capturing figures, dates, and exact commitments — the entire reason
  the tool exists. AI transcription is necessary to the stated purpose at the fidelity the Chief of Staff
  needs.
- **Could the purpose be met with less intrusive means?** Yes, partially, and the app is built around this:
  processing happens **on the organizer's device** (local ASR — Parakeet by default, Whisper as fallback;
  see [`data-flow-onepager.md`](./data-flow-onepager.md)), not by uploading raw audio to a third party.
  Cloud LLM use for the summarization/extraction step is a **user-configurable choice**, not a requirement
  — a fully on-device path exists (local LLM, packaged local AI; see below), and is the more
  privacy-protective option per this test.
- **Data minimization already engineered in:** raw audio is **not persisted as a file** in the app's own
  storage — it is processed as an in-memory audio stream during live transcription and discarded once
  transcribed (verified in `src/renderer/src/lib/listen.ts`: audio arrives as `Float32Array` buffers fed to
  the ASR engine; no write of an audio blob/file exists in the live-capture code path). Only the derived
  transcript (text) and the AI-generated summary/extraction persist to disk. This is a materially stronger
  minimization posture than the "delete audio after N days" pattern common in SaaS notetakers, because
  there is no audio artifact to delete in the first place under the current architecture.

## 3. Balancing test

### Participants' reasonable expectations

Business meeting participants generally expect that notes may be taken. AI transcription and structured
extraction (entities, deal figures, commitments) goes beyond what a reasonable participant would assume
from "notes," particularly given the well-documented 2025–2026 backlash against AI notetakers (Otter/
Fireflies/Teams voiceprint litigation in the US; 12+ US states now require all-party consent for
recording). The gap between expectation and actual processing is the central risk this LIA must offset —
it is offset by explicit notice (below), not by relying on implied consent.

### Notice

An internal, in-app reminder already exists today: `RecordingConsentReminder.tsx` displays "Métis is
listening — You're recording other participants. Make sure everyone has consented" to the **organizer**
while recording is active. This is a personal nudge to the Chief of Staff, not participant-facing notice,
and it is not logged to the audit trail as a consent event. It does **not** by itself satisfy the notice
obligation to other participants. The controller-facing notice text and verbal-announcement practice are
specified in [`recording-policy.md`](./recording-policy.md) and must be used at the start of every
in-scope meeting (in person or by calendar invite line for recurring externals), not just relied upon as
an in-app cue to the organizer.

### Opt-out

A participant who objects can have the recording stopped immediately — the app's start/stop control is
manual and instantaneous. There is currently no mid-meeting "pause for an off-the-record segment" control;
the only mechanism today is a full stop (and, if resumed, a new recording segment). This is a genuine UX
gap for meetings with a mix of on-the-record and confidential content and should be flagged to product for
consideration; until then, the practical opt-out is "we stop recording for this part."

### Data minimization measures already engineered (recap)

| Measure | Status |
|---|---|
| On-device ASR (audio never leaves the device for transcription) | Shipped — Parakeet (default) / Whisper (fallback), both local |
| Raw audio not persisted to disk | Shipped (architectural — no audio-file write path exists) |
| Transcripts + brain data encrypted at rest (AES-GCM, device-bound key) | Shipped — `encryptTranscripts`, default **on** |
| Secret-pattern redaction before any cloud-model call | Shipped — `redactSensitive`, default **on**, strips card/SSN/API-key patterns only (not names/business content) |
| Local LLM option for summarization (no cloud egress at all) | Packaged as an opt-in provider — bundled Qwen3.5 0.8B through llama.cpp `llama-server` b9957 on macOS arm64 and Windows x64; no post-install model/runtime download |
| Derived summaries only, never verbatim transcript, published for agent-reading | Planned — Phase 5 of the 100x plan, gated by explicit consent + a per-meeting confidential flag; not yet built |

### Power imbalance / vulnerability

Business counterparties (clients, vendors) are not in a subordinate relationship to the Chief of Staff in
the way an employee is to an employer, which is the classic reason Art 6(1)(f) is disfavored. Candidates
in a hiring process are a partial exception — see §6.

## 4. Safeguards adopted

- Encryption at rest by default (`encryptTranscripts: true`).
- Redaction of high-confidence secrets before any cloud LLM call (`redactSensitive: true`).
- Audit logging of key security-relevant events (local JSONL, `logs/audit.log`) — not yet tamper-evident
  (planned Phase 8) and does not yet log a discrete "recording started / notice given" event (planned).
- Manual, immediate stop control available to honor an objection at any time.
- No emotion, sentiment, or engagement inference of participants exists in the extraction schema or
  prompts today (verified: zero occurrences of emotion/engagement/sentiment-participant scoring in
  `src/main/brain/ingest.ts` or the extraction prompt). This is also an EU AI Act Article 5(1)(f) red line —
  see [`ai-act-checklist.md`](./ai-act-checklist.md).
- Retention limits are a target, not yet automated — see [`recording-policy.md`](./recording-policy.md) and
  the open question in [`README.md`](./README.md).

## 5. Outcome

**Provisional conclusion (subject to DPO sign-off):** the legitimate interest (accurate, followable
business records of the Chief of Staff's own meetings) is real, the processing as architected (on-device
ASR, no persisted audio, encryption, redaction, immediate stop) is proportionate to it, and — **for
external/business-counterparty meetings, with notice given per `recording-policy.md`** — the balancing
test favors the controller's interest over the participant's expectation of unannounced processing,
provided notice is actually given every time. This LIA does **not** currently support recording where the
only other participants are Mantu employees in their employment capacity; see §6.

## 6. Open question — internal (Mantu-employee) meetings

If the Chief of Staff also uses AskToto for internal Mantu meetings (1:1s with reports, internal team
syncs), the data subjects there are employees, and Art 6(1)(f) is legally weaker for employer-side
recording of staff due to the inherent power imbalance CNIL and the EDPB flag in employment contexts.
Two additional obligations likely attach: (a) CSE (works council) information/consultation before
deployment as an employee-facing monitoring tool (Code du travail L2312-38), and (b) a firmer legal-basis
analysis for that subset of meetings specifically (possibly still legitimate interest with stronger
safeguards, or a different basis). **This LIA is scoped to exclude internal-only meetings until the DPO
resolves this. Recommend either restricting the tool's recording use to external meetings by policy today,
or running the CSE consultation now** (see [`recording-policy.md`](./recording-policy.md) works-council
note).
