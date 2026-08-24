DRAFT — for DPO review, not yet adopted. Prepared 2026-07-11.

# Article 30 Record of Processing Activities — AskToto / Métis

One processing-record entry for Mantu's Article 30 register. Related:
[`dpia.md`](./dpia.md), [`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md).

| Field | Entry |
|---|---|
| **Processing name** | AskToto / Métis — AI meeting recording, transcription, and business-intelligence extraction |
| **Controller** | Mantu — **exact legal entity name and SIREN/registration number: verify with Legal**; task brief names Mantu as an EU (France-HQ) consulting group, but the specific contracting/controller entity is not confirmed in the codebase or this pack |
| **Controller contact** | Tony Walteur, Chief of Staff (system owner / sole user) |
| **DPO contact** | [name/email — to be filled in by DPO's office] |
| **Purpose(s)** | (1) Produce minutes, action items, and follow-up drafts from the Chief of Staff's meetings; (2) maintain a running account/person/deal record derived from meeting content; (3) *(planned — Phase 5)* make derived, human-reviewed summaries queryable by Dust.tt agents |
| **Legal basis** | Legitimate interest, Art 6(1)(f) — external/business-counterparty meetings only; **unresolved for internal Mantu-employee meetings** (see [`legitimate-interest-assessment.md`](./legitimate-interest-assessment.md) §6) |
| **Categories of data subjects** | Chief of Staff (controller-side user); external meeting participants (clients, prospects, candidates, vendors, partners); potentially Mantu employees if internal meetings are in scope (open question) |
| **Categories of personal data** | Verbatim meeting transcript text; AI-derived summaries and action items; entity/deal extraction (names, organizations, roles, deal figures, quotes); calendar metadata (attendee names/emails) where used; local audit-log metadata (event type/timestamp/provider — never message content) |
| **Special categories** | Not intentionally collected; incidental mentions possible in transcript/quote text — no Article 9 basis established for that incidental content (see [`dpia.md`](./dpia.md) §2) |
| **Recipients (processors)** | Microsoft 365 / OneDrive (storage) — covered by Mantu's existing M365 DPA, verify scope covers this content class; the cloud LLM provider configured in Settings, if any (Anthropic, OpenAI, NVIDIA NIM, DeepSeek, Qwen, MiniMax, Kimi, OpenRouter, Groq, Mistral, Grok, Gemini, Cloudflare, or a custom endpoint — only the one(s) actually selected receive data); Cloudflare is a two-hop recipient: a Worker in the **operator's own** Cloudflare account, then `api.cloudflare.com`, which under Unified Billing serves the request from Workers AI, OpenAI, Anthropic or Google depending on the configured model id (see [`dpia.md`](./dpia.md) §2 and [`../CLOUDFLARE.md`](../CLOUDFLARE.md)); Dust.tt (Q&A today; *planned — Phase 5* additionally as a read recipient of published pages via the OneDrive connector) |
| **Sub-processor DPA status** | Microsoft — DPA in place (existing M365 agreement; verify scope). Dust.tt — Art 28 DPA + EU hosting + no-training clause: **not yet verified**, action item in [`tenant-checklist.md`](./tenant-checklist.md). Other LLM providers — **no DPA/SCC inventory exists per provider today**; this is a live gap, not a planned one, because provider selection is already possible in Settings |
| **International transfers** | Depends on the provider selected. Mistral: EU-hosted. Dust: EU workspace available (`eu.dust.tt`) but not the default (`dust.tt`) — verify which is configured. Anthropic, OpenAI, NVIDIA, DeepSeek, Qwen, MiniMax, Kimi, OpenRouter, Groq, Grok, Gemini: transfer mechanism (SCC/adequacy) **not verified**, treat as non-EU pending confirmation. Cloudflare: record it per deployment, not once for the product — the transfer depends on the region of the operator's own Cloudflare account **and** on whichever upstream lab the configured model id resolves to |
| **Retention** | No automated retention today (manual deletion only). Target defaults proposed in [`recording-policy.md`](./recording-policy.md): audio not persisted (architectural); transcript 30–90 days; minutes 12 months unless project-tagged — **build target, Phase 8, not yet enforced** |
| **Technical and organisational measures (TOMs)** | On-device ASR (audio never transmitted for transcription); raw audio not persisted to any file; AES-GCM encryption at rest for transcripts/brain data, default on (`encryptTranscripts`), device-bound key via OS keychain (`safeStorage`) where available; secret-pattern redaction before any cloud-model call (`redactSensitive`, default on — scoped to card/SSN/API-key patterns, not general PII); local append-only audit log of security-relevant events (not yet tamper-evident — planned Phase 8); prompt-injection guard treating transcript content as untrusted data; single-user OS-session access control (no multi-user access model exists) |
| **Automated decision-making** | None. No profiling or decision produced about a data subject without human review; extraction is reviewed by the Chief of Staff before recap finalization |
| **Review cadence** | Re-verify at each 100x-plan phase ship that touches this processing (Phase 4 verified-numbers, Phase 5 publish, Phase 8 hardening); otherwise annually |

## Notes for Legal

1. Confirm the controller entity name/registration number for the header row.
2. Confirm whether Mantu's existing Microsoft 365 DPA explicitly covers AI-generated meeting-intelligence
   content (vs. generic file storage) — the content class here (derived personal-data profiles of business
   contacts) may warrant an explicit mention.
3. Decide whether to restrict the cloud-LLM recipient list by policy (EU-hosted/adequate only) pending the
   provider-by-provider DPA/SCC inventory — see the open question in [`README.md`](./README.md).
