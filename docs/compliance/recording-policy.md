DRAFT — for DPO review, not yet adopted. Prepared 2026-07-11.

# AskToto / Métis — Recording Policy (one-pager)

Related: [`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md),
[`dpia.md`](./dpia.md), [`ai-act-checklist.md`](./ai-act-checklist.md).

## When to announce

Announce recording/transcription at the start of every meeting in scope (verbally, or via a standing line
in the calendar invite for recurring external meetings). Use the notice text below. This is an
organizational practice today — the app has an **in-app reminder to the organizer** only
(`RecordingConsentReminder.tsx`, "Métis is listening — make sure everyone has consented"); it is not
participant-facing and is not yet logged as a consent event (planned — Phase 8: "Consent/notice UX on
recording start, logged").

## Notice text

**English:**
> This meeting is being transcribed by AI (Métis) to produce minutes and action items. Audio is processed
> locally on the organizer's device and is not stored as a recording; a written, human-reviewed summary is
> kept in Mantu's OneDrive workspace. If you'd prefer this meeting isn't transcribed, or want a portion kept
> off the record, please say so before we begin. Questions: contact Mantu's Data Protection Officer at
> [DPO email — to be filled in].

**Français :**
> Cette réunion est transcrite par une intelligence artificielle (Métis) afin d'en établir le compte-rendu
> et la liste des actions. L'audio est traité localement sur l'appareil de l'organisateur et n'est pas
> conservé sous forme d'enregistrement ; un résumé écrit, relu par un humain, est conservé dans l'espace
> OneDrive de Mantu. Si vous préférez que cette réunion ne soit pas transcrite, ou qu'une partie reste hors
> compte-rendu, merci de le signaler avant que nous commencions. Questions : contactez le Délégué à la
> Protection des Données de Mantu à [e-mail du DPO — à compléter].

## Consent handling for external participants

- Notice (above) is given before recording starts. Proceeding after notice, without objection, is treated
  as the participant having been informed and not objecting — this is **not** a substitute for the
  legitimate-interest balancing test already performed in
  [`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md); it is the notice component of
  that test being satisfied in practice.
- An objection is honored immediately by stopping recording for that meeting or segment. There is currently
  no mid-meeting "resume without the off-the-record part" feature — a full stop/restart is the only
  mechanism today (flagged as a UX gap in the DPIA).
- For recurring external counterparties, a standing note in the meeting invite ("meetings with [Chief of
  Staff] are AI-transcribed for internal minutes; let us know if you'd prefer otherwise") is an acceptable
  substitute for a verbal repeat every time, provided the verbal notice is still given the first time and
  whenever a new participant joins.

## Prohibited uses

- **No workplace emotion, engagement, or sentiment scoring of participants.** This is an EU AI Act Article
  5(1)(f) red line (emotion recognition in the workplace, in force since February 2025; fines up to 7%
  global turnover). No prompt in the extraction or summarization pipeline may request inference of a
  participant's emotional state. See [`ai-act-checklist.md`](./ai-act-checklist.md) for the code-level guard
  the 100x plan mandates (currently a stated architectural invariant in the packaged-local-ai plan; **not
  yet an automated test** — planned Phase 8: "make it a test").
- No use of extracted content about a Mantu colleague to inform an employment decision (hiring, promotion,
  termination, task allocation, performance rating) — doing so would likely reclassify this use as a
  high-risk AI Act Annex III #4 (employment) system, a materially heavier compliance regime than assessed
  here. See [`ai-act-checklist.md`](./ai-act-checklist.md).
- No sharing of raw transcripts outside the OneDrive tenant folder governed by
  [`tenant-checklist.md`](./tenant-checklist.md).

## Retention defaults (target — Phase 8, not yet automated)

| Artifact | Target retention | Status |
|---|---|---|
| Raw audio | N/A — not persisted to disk in the current architecture (processed transiently in memory during live transcription only) | Already true today by design, not a policy to enforce |
| Verbatim transcript | 30–90 days | Automated: `transcriptRetentionDays` (off by default, admin-lockable via managed-config) sweeps expired meetings at launch and every 6 hours, audit-logged (`sweepExpiredMeetings` in `src/main/recall.ts`, wired in `src/main/index.ts`). The enterprise example policy ships it at 90 days |
| Minutes / recap / brain extraction | 12 months, unless the meeting/deal is project-tagged (then retained for the life of the project) | **Target only** — same gap |
| Audit log | 12 months (ISO 27001 A.8.15 posture) | **Target only** — current audit log rotates by size (5MB), not by time |

These numbers are recommended defaults aligned with data-minimization principles and analogous CNIL
guidance on call/communications recording; **no CNIL rule specific to AI meeting transcription of this kind
is published as of 2026-07-11** (CNIL's dedicated deliverable on automatic analysis of voice communications
in videoconferencing is listed on its 2026 work program but not yet released — see the watch item in
[`ai-act-checklist.md`](./ai-act-checklist.md)). **Verify these numbers with DPO** before they're built into
Phase 8's retention automation.

## Works council (CSE) note

If AskToto records **internal Mantu meetings** (not just external ones), this is very likely a
monitoring/surveillance tool subject to prior CSE information/consultation under Code du travail L2312-38,
independent of the individual-consent question. **This has not been run.** Recommend one of:

1. Restrict AskToto's recording use, by policy, to external/business-counterparty meetings only, until CSE
   consultation is completed — this keeps the current [`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md) scope valid without further action, or
2. Run the CSE consultation now, in parallel with this pack's DPO review, if internal use is intended.

This is one of the three open questions in [`README.md`](./README.md) and should be resolved before any
broader rollout beyond the Chief of Staff's own external meetings.
