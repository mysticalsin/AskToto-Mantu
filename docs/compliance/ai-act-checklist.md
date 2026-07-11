DRAFT — for DPO review, not yet adopted. Prepared 2026-07-11.

# EU AI Act — Applicable Obligations Checklist

Related: [`dpia.md`](./dpia.md) §9, [`recording-policy.md`](./recording-policy.md) (prohibited uses),
[`data-flow-onepager.md`](./data-flow-onepager.md) (model provenance).

## Classification

**Tier: Limited risk.** Rationale:

- Not Unacceptable (Article 5): AskToto performs transcription and extraction, not emotion recognition,
  biometric categorization, social scoring, or subliminal manipulation. No prohibited-practice element is
  present in the current design.
- Not Annex III High-Risk, **conditionally**: none of the eight Annex III domains apply to the current,
  single-executive use (recording the Chief of Staff's own meetings for personal note-taking and CRM-style
  record-keeping). **The one domain that could apply is #4 (employment)** if extracted content about a
  Mantu colleague were ever used to inform an employment decision (hiring, promotion, termination, task
  allocation, monitoring/evaluation). This is explicitly out of scope by design and by the prohibited-uses
  clause in [`recording-policy.md`](./recording-policy.md); if that ever changes, re-run this
  classification — it would very likely become High-Risk.
- Article 50 (Limited risk) transparency obligations apply because the system produces AI-generated
  content (summaries, extracted facts) that is stored and later read by both the Chief of Staff and,
  planned, by Dust agents.

**Mantu's role:** Deployer (internal tool, built in-house and used only by Mantu). Not a Provider placing
a system on the market for third parties.

## Article 4 — AI literacy

Requirement: users of an AI system must be adequately briefed on its capabilities and limitations. For a
single-user internal tool this is trivial to close but must actually be done and logged, not assumed.

**Briefing log (fill in and keep on file):**

| Item | Confirmed | Date | Notes |
|---|---|---|---|
| Briefed that ASR (Parakeet/Whisper) can mis-transcribe names, figures, and non-English speech | ☐ | | |
| Briefed that LLM extraction can hallucinate or misattribute a quote/figure not actually said | ☐ | | Verifier gate (Phase 4) not yet built — self-reported confidence only today |
| Briefed on the "verify before relying" rule for any AI-generated figure or commitment before acting on it | ☐ | | |
| Briefed on which LLM provider is currently configured and what that implies for data egress | ☐ | | See [`dpia.md`](./dpia.md) R2 |
| Briefed on the prohibited-uses list in [`recording-policy.md`](./recording-policy.md) | ☐ | | |

## Article 5(1)(f) — prohibition guard (emotion/engagement recognition in the workplace)

**Status:** stated as a non-negotiable architectural invariant in
`docs/plans/2026-07-10-packaged-local-ai-implementation-plan.md` ("No candidate/employee scoring, ranking,
shortlisting, emotion inference, or employment recommendation") and independently confirmed by code review:
zero occurrences of emotion/engagement/sentiment-of-participant logic in the extraction schema or prompts
(`src/main/brain/ingest.ts`, `src/shared/brain.ts`) as of 2026-07-11.

**Gap:** this is a design intent, not yet an enforced test. The 100x plan (Phase 8) explicitly proposes
"Code-level guard: no prompt may request participant emotion/engagement inference — already respected; make
it a test." **Not yet built.** Recommend treating this checklist item as open until that test exists and
is part of CI.

## Article 50 — transparency marking

**Deadline: 2026-08-02** (EU AI Act Article 113 timeline — general transparency obligations apply from this
date).

| Requirement | Status |
|---|---|
| Machine-readable marking on AI-generated content (`ai_generated: true`, `generated_by: <model+version>` frontmatter) | **Planned — Phase 5** (`publish.ts`, not yet built) |
| Visible, human-readable disclosure line on AI-generated summaries/pages | **Planned — Phase 5** |
| Disclosure tested visible within ~2 seconds of the content being viewed | **Planned — Phase 5**, verify at ship |

**Action:** Phase 5 must ship, with both the frontmatter and the visible line, before 2026-08-02, for any
AI-generated content that is exposed beyond the Chief of Staff's own private review (i.e., before
`publishBrainPages` is ever turned on). If Phase 5 slips past the deadline, the mitigation is simple —
don't enable `publishBrainPages` until the marking ships, since today's default keeps the corpus
non-plaintext to any external reader in the first place (see [`dpia.md`](./dpia.md) data-flow, current
state).

## Article 26 — deployer obligations (informational; full stack not required since not High-Risk)

Not formally required at Limited-risk tier, but good practice given the sensitivity of the content:

- [x] Logs retained (partial — audit log exists, not yet time-retained or tamper-evident; Phase 8)
- [ ] Suspension criteria if a serious issue emerges — not formally defined; recommend: disable
      `publishBrainPages` and/or the active cloud provider immediately if a leak or misattribution incident
      occurs
- [x] Instructions for use are implicit in product UX; no separate deployer instructions document exists —
      low priority at this scale

## Watch items

- **CNIL 2026 guidance on automatic analysis of voice communications in videoconferencing** — announced on
  CNIL's 2026 work program, not yet published as of 2026-07-11. This will likely be the definitive French
  standard for exactly this product category (retention periods, notice requirements, technical
  safeguards). **Re-run this checklist and [`recording-policy.md`](./recording-policy.md)'s retention
  section against it when published.**
- EU AI Act delegated/implementing acts affecting the Limited-risk transparency requirements between now
  and 2026-08-02.

## Sign-off

- [ ] AI Compliance Lead
- [ ] DPO
- [ ] Legal
