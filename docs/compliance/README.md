DRAFT — for DPO review, not yet adopted. Prepared 2026-07-11.

# AskToto / Métis — Compliance Paper Pack

Index of the GDPR + EU AI Act documentation for AskToto (product name "Métis"), a single-user, local-first
Electron meeting-intelligence application used by one executive (Chief of Staff) inside Mantu. Produced
per Phase 8 ("Enterprise hardening + compliance pack") and the Article 50 items in Phase 5 of
[`../plans/2026-07-11-meeting-intelligence-100x-plan.md`](../plans/2026-07-11-meeting-intelligence-100x-plan.md).

## Scope and status

Every document in this pack is a **draft input for DPO review** — none has been adopted, none has been
consulted with the works council (CSE), and none should be cited externally (to a client, a regulator, or
a participant) until the DPO signs off and the open questions below are resolved.

Facts about the app are drawn directly from the current codebase (branch `codex/metis-packaged-local-ai`,
2026-07-11) and from the 100x plan. Where a control is designed but not yet built, every document marks it
**"(planned — Phase N)"** rather than describing it as live. Nothing in this pack should be read as
asserting a control exists unless it is verifiably in the shipped code today.

## Documents

| # | File | Purpose | Status |
|---|---|---|---|
| 1 | [`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md) | GDPR Art 6(1)(f) LIA for recording + transcribing business meetings | Draft |
| 2 | [`dpia.md`](./dpia.md) | GDPR Art 35 Data Protection Impact Assessment | Draft |
| 3 | [`article-30-record.md`](./article-30-record.md) | GDPR Art 30 record of processing activities (one entry) | Draft |
| 4 | [`recording-policy.md`](./recording-policy.md) | One-page internal policy + EN/FR meeting notice text | Draft |
| 5 | [`ai-act-checklist.md`](./ai-act-checklist.md) | EU AI Act applicable-obligations checklist | Draft |
| 6 | [`data-flow-onepager.md`](./data-flow-onepager.md) | Stakeholder trust story: what stays on-device, what reaches the tenant | Draft |
| 7 | [`tenant-checklist.md`](./tenant-checklist.md) | Actions for IT/M365 admin, outside the app | Draft |

## Owner and review cadence

- **Owner (drafting, product facts):** Tony Walteur — sole user, product owner of AskToto/Métis.
- **Approver:** Mantu DPO (name to be filled in by DPO's office — not yet assigned in this pack).
- **Legal:** Mantu Legal, for the Art 30 controller-entity name and any works-council question below.
- **Review trigger:** any of — a Phase 5/Phase 8 feature from the 100x plan ships (re-check the doc it
  unblocks before enabling the feature in production, per the DPIA's Iron Law of "before, not after");
  CNIL publishes its 2026 guidance on automatic analysis of voice communications (see
  [`ai-act-checklist.md`](./ai-act-checklist.md)); the Art 50 deadline (2026-08-02) approaches; annually
  otherwise.
- **Back-dating:** none of these documents claim an adoption date earlier than 2026-07-11. Where existing
  processing (recording/transcription) has been live without a prior formal DPIA, the DPIA says so plainly
  rather than pretending otherwise.

## Three biggest open questions for the DPO

1. **Internal (Mantu-employee) meetings vs external meetings — different legal basis, possible CSE
   trigger.** The app can record any meeting, including internal 1:1s and team meetings with Mantu
   colleagues, not only external client/vendor/candidate meetings. Art 6(1)(f) legitimate interest is
   legally fragile for employer-side recording of employees given the power imbalance; CNIL and EDPB
   guidance disfavor it in that context. If internal colleague meetings are in scope, this likely requires
   (a) a different or additional legal basis for that subset, and (b) prior CSE information/consultation
   before deployment (Code du travail L2312-38). See [`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md) §6 and [`recording-policy.md`](./recording-policy.md). **Recommend DPO scope this explicitly before go-live: restrict AskToto's recording use to external/business-counterparty meetings until CSE consultation is run, or run it now.**
2. **Cloud LLM provider transfers.** The app offers 18 selectable providers for summarization/extraction (`src/shared/providers.ts` is the register; count from it rather than from this sentence). 17 send text off the device; the 18th (`local`) runs on-device and transmits nothing. Most of the 17 are US-hosted (Anthropic, OpenAI, Groq, xAI, etc.), one is EU-hosted (Mistral), and Dust supports an EU workspace. **Cloudflare is the one that is not a single vendor endpoint:** it is reached through a Worker the customer's own operator deploys, which then calls `api.cloudflare.com`, which under Unified Billing serves the request from Workers AI, OpenAI, Anthropic or Google depending on the configured model id — so its transfer picture is per deployment, not per product. `redactSensitive` (default on) strips only high-confidence secret patterns (card numbers, SSNs, API keys) before sending transcript text to whichever provider is configured — it does **not** strip names, company names, or deal content. No SCC/transfer-mechanism inventory exists per provider today. **Recommend DPO decide: restrict cloud extraction to EU-hosted/adequate providers by policy, or confirm SCCs are in place for the others** — see [`dpia.md`](./dpia.md) §5 and [`article-30-record.md`](./article-30-record.md).
3. **Retention automation doesn't exist yet.** No code today auto-deletes transcripts, minutes, or brain records on a schedule; deletion is manual (user-triggered). The recommended CNIL-aligned defaults in [`recording-policy.md`](./recording-policy.md) are targets for Phase 8, not live behavior, and are not backed by a published CNIL rule specific to this product category yet (CNIL's dedicated voice-communications guidance is on its 2026 work program, unpublished as of this writing). **Recommend DPO confirm the proposed numbers (audio: not persisted at all today; transcript 30–90d; minutes 12mo) are acceptable as the build target, and decide what governs retention in the interim** (today: none, beyond the user manually deleting files).
