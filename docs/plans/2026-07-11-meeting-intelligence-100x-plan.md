# Meeting Intelligence 100x — CRM-First Brain, Verified Numbers, Corrections That Stick, Dust-Readable Corpus

**Date:** 2026-07-11
**Status:** PARTIALLY IMPLEMENTED — Phases 0–4 are in source. The Phase 5 publisher, consent,
confidential-meeting, graphify, and alias-retrieval source is landed, but its real OneDrive/Dust
connector E2E checklist remains open. Phases 6–8 remain roadmap work.
**Method:** 21-agent deep dive (9 code readers over every meeting-intelligence subsystem, 7 web researchers on 2025–2026 state of the art, 3 rival architectures, 2-judge adversarial panel). Both judges independently selected the CRM-First design (8/10, 8.5/10); this plan is that design plus the grafts both judges demanded and fixes for the blind spots they found in all three designs.
**Governing rules:** Karpathy guidelines (surgical changes, verifiable success criteria), Tony's builder rules (simplicity first, no new database unless files are proven insufficient — they are not), TDD discipline.

---

## 1. Executive summary

Today the brain (`.brain/` under the meetings folder) is a write-only derivative of one LLM pass: slug-string identity, no aliases, no human edits beyond deal outcome and commitment settle, no numbers anywhere in the schema, quotes never verified against the transcript, and — with `encryptTranscripts` on (the default) — invisible to Dust, graphify, and every external agent.

This plan inverts the model. **Person/Account/Deal become the canonical, human-editable system of record.** Every field carries provenance (source meeting + verbatim quote + `extracted|verified|edited|pinned` state). Every human correction becomes a persistent alias that rewrites future extractions AND future live ASR. Every number is deterministically verified against the transcript before it is ever rendered — *no unverified figure ever shown*. The whole record set is mirrored as plain markdown entity pages + per-meeting note cards in the OneDrive meetings folder, with an llms.txt-shaped index and an `AGENTS.md` contract, so Dust agents, graphify, and any LLM read the same corrected truth with zero integration code.

No new database. No rewrite. Schema v2 on the existing JSON files plus surgical seams in `ingest.ts`, `store.ts`, `BrainView.tsx`, `Review.tsx`, and one new `publish.ts`.

---

## 2. What exists today (verified against code by the readers)

- **Extraction:** one LLM call per meeting (`extractMeeting()` in `src/main/brain/ingest.ts`), temp 0, transcript truncated to first **24,000 chars**, zod-validated `MeetingExtractionSchema` (`src/shared/brain.ts`), one retry. Provenance stamped post-hoc by `ingestExtraction()`; deterministic merge via `mergeExtraction()`; 3-concurrent extraction queue, strictly serial merges (`ingestChain`).
- **Grounding:** confidence tags (`EXTRACTED/INFERRED/AMBIGUOUS`) are **model self-report** — no code ever checks a quote is a substring of the transcript. Contrast `src/shared/brain-analyze.ts`, which already enforces sha256-keyed, line-anchored evidence for the `brain:analyze` path — the discipline exists in the codebase, just not on the ingest path.
- **Numbers:** no monetary/deal-size/close-date field exists on any schema. Deal amounts survive only as free text inside quotes.
- **Identity:** `slugify()` is the only canonicalization. 'Acme' vs 'Acme Corp' = two accounts; two different 'John Smith's silently merge.
- **Corrections:** entity-casing is exact-match only; `asrCorrections` regex list exists in the live path (`commitLine` in `listen.ts`) but nothing feeds it from brain corrections. Transcript and extraction entities are not user-correctable in the UI.
- **Storage:** JSON under `.brain/`, encrypted with ATKENC2 when `encryptTranscripts` is on; `index.md` suppressed in encrypted mode while `README.md` still tells agents to scan `*.md` — **the corpus is dark to Dust under default settings**. `graphify.ts:227` refuses to run over encrypted folders.
- **UI:** `BrainView.tsx` is a single dashboard; no record pages, no rename/merge/edit of entities, recap editable only as one raw textarea after the meeting ends.
- **Security:** ~12 of the many privileged IPC channels have zod validation; audit log is local, unhashed, 5MB-rotated; encrypted blobs are undecryptable on any second machine (device-bound key).

## 3. Confirmed defects this plan fixes (receipts)

| # | Defect | Evidence |
|---|--------|----------|
| D1 | Latest-**ingested**-wins corrupts deal band/velocity/stage on backfill (readdir order, not meeting date) | `mergeExtraction()` in `ingest.ts`; backfill queues in `readdirSync` order |
| D2 | 24k-char truncation silently drops late-meeting commitments | `ingest.ts` (`transcript.slice(0,24000)`) |
| D3 | Quotes/numbers never verified against transcript | no verifier between `MeetingExtractionSchema.parse` and merge |
| D4 | No numeric fields at all (no pipeline value possible) | `src/shared/brain.ts` schemas |
| D5 | Slug-only identity → duplicate/cross-contaminated entities | `store.ts` `slugify()` |
| D6 | First-writer-wins on `person.role`/`person.account` — job changes never update | `mergeExtraction()` pushUnique/null-only-set |
| D7 | Encryption makes corpus unreadable to Dust + graphify while README promises readability | `graphify.ts:227`, index.md suppression |
| D8 | `lintBrain` multi-account check is a no-op | derives from single `p.account` |
| D9 | Mars vs silence account keys disagree (`toLowerCase` vs diacritic-strip) — L'Oréal counts twice | `mars.ts` vs `silence.ts` `norm()` |
| D10 | Extractor sees post-redaction text; any future verifier reading pre-redaction transcript gets false negatives | `ingest.ts:124` |
| D11 | No decoder or phonetic correction for misheard names; entity-casing exact-match only | `parakeet.ts` greedy_search, no Whisper prompt |
| D12 | Partial IPC validation; audit log not tamper-evident | `index.ts` channel audit |

---

## 4. Architecture: CRM-First Brain (winner) + judge-mandated grafts

Six components, all seams in existing files. Full design record: workflow `wf_e3cbdfaa-910` journal.

### 4.1 Schema v2 (`src/shared/brain.ts`)
- Bump `BRAIN_SCHEMA_VERSION` to 2.
- Entities gain: immutable `id` (existing slugify output), mutable display name, `aliases: string[]`, per-field provenance objects `{value, source_file, date, quote?, confidence, state: 'extracted'|'verified'|'edited'|'pinned'}` for name/role/org/sector/stage.
- Per-field provenance keeps a **capped superseded-values list** (value + meeting date + source) — graft from the graph-first design; delivers "what changed since last meeting with X" without a bi-temporal schema rework.
- `DealEntity` gains optional `amount {value, currency, …provenance}` and `close_date`.
- `MeetingExtractionSchema` gains `numeric_facts[]` `{kind: amount|percent|date|headcount, value, unit, quote (required verbatim), confidence}`. **Numbers are never required; UNKNOWN is a taught output; a value without a quote is invalid.**
- Lazy v1→v2 migration in `store.ts` read accessors (read wraps legacy; write emits v2). One-time `.brain` backup before first v2 write. No big-bang migration.

### 4.2 Deterministic merge fixes + verifier (`src/main/brain/ingest.ts`)
- `mergeExtraction()` compares `ref.date` (already stamped) instead of ingestion order for latest-wins fields → kills D1.
- Fix D8 (lintBrain multi-account).
- New `verifyExtraction()` between parse and merge: for every quote and numeric_fact, normalize + fuzzy-align (sliding-window token match, ~0.85 threshold, pure TS, no new deps) against **the exact post-redaction 24k slice the model saw** (graft from agent-first design; fixes D10). Numerals must be derivable from the matched span after en+fr normalization ('three point five million', 'trois millions et demi', €, k/M forms). Pass → `verified`; fail → demote to `AMBIGUOUS`, strip the value. Confidence becomes a **computed property**, not model self-report.
- **Windowed extraction** for >24k transcripts (graft from graph-first design): chunked extraction merged through the same date-ordered machinery → kills D2.
- `applyCorrections()` rewrites extracted entity names through the alias table BEFORE merge — past corrections govern every future ingest and rebuild.

### 4.3 Correction engine (`store.ts`, `index.ts`, `ipc.ts`, `logger.ts`)
- New human-only IPC channels, each cloned from the verified `setDealOutcome` pattern (zod safeParse + requireAuth + assertMainWindow + auditLog event, from day one):
  - `brain:entityRename {id, newName, alsoFixAsr?}`
  - `brain:entityMerge {fromId, intoId}` (pre-merge snapshot; **unmerge ships in the same phase**, not deferred)
  - `brain:entityUpdateField {id, field, value}` → state `pinned`; merges may propose, never overwrite; later contradictions become lint warnings
  - `brain:commitmentReject`
- All mutations append to `.brain/corrections.json` — append-only journal, encrypted via `writeSaved`, **single mutation implementation shared by live path and rebuild replay** (`brain:rebuildAll` replays the journal; rebuild-converges test proves it). Human corrections provably survive rebuilds.
- All mutations serialize on the existing `ingestChain`; jsonCache invalidated on human writes (OneDrive race mitigation).
- `entityRename` with `alsoFixAsr` appends a word-boundary pair to `settings.asrCorrections` (consumed by `commitLine` before entity-casing) and refreshes `brain:entityNames` — a correction reaches live ASR within one meeting. **Both directions:** user-edited asrCorrections proper-noun pairs auto-promote into the alias registry (graft).

### 4.4 CRM views (`BrainView.tsx`, `Review.tsx`, preload)
- Account/Person/Deal drill-down pages: meeting timeline (rows open via existing `openPastMeeting`), field cards with provenance chips ('extracted — "quote" — [meeting]' / 'verified' / 'edited by you' / 'pinned'), pencil inline-edit, 'Same as…' merge picker, deal money card rendering **only verified or human-entered values** — unverified shows visible "stated but unverified — pin manually?", never silent absence and never a silent number.
- **'Entities in this meeting' strip on Review.tsx right after save** — chips with confidence badges, one-click fix popover. Correction at the moment of truth, 30 seconds while context is fresh.
- **Needs-attention queue** (blind-spot fix): one surface aggregating verifier demotions, low-confidence entities, lint-flagged duplicates, contradicted pins. Counter badge on BrainView; nothing rots invisibly. Correction events counted in existing metrics so the flywheel is measured.
- `mars.ts`/`silence.ts` switch account keys to entity id + aliases → kills D9; `buildMarsWeek` gains a pipeline-value line summing only verified/human amounts.

### 4.5 Markdown mirror (`src/main/brain/publish.ts` — the one new file)
- After each merge and after rebuildAll, regenerate touched pages under `<meetingsFolder>/entities/{accounts,people,deals}/<id>.md`:
  - Frontmatter (OKF-style: type, title, aliases, tags, timestamp, resource) **+ `ai_generated: true`, `generated_by: asktoto <model+version>`** — EU AI Act Article 50-ready before the 2 Aug 2026 deadline.
  - `## Current facts` table (verified/pinned only, each value linked to source meeting) + `## Timeline` + `## Open commitments` + capped `## Changelog` from superseded values.
- **Per-meeting plaintext note cards** (graft from agent-first design): recap-derived, never verbatim transcript, minimized derivative — this is what makes the corpus genuinely Dust-readable under `encryptTranscripts`. Gated by a **per-meeting confidential flag** (Review toggle → frontmatter) that excludes HR/M&A/legal meetings from publishing and entity timelines. Ships in the same phase as the mirror, before any plaintext publishing.
- Root `entities/index.md` in llms.txt grammar (H1 + blockquote + H2 link-lists by recent activity), regenerated every publish, kept within one context window; `_schema/AGENTS.md` as the real agent contract; README rewritten to stop lying under encryption.
- Writes are full-file regenerations via the atomic `writeSaved` tmp+rename path — idempotent, derived-never-canonical, no read-modify-write, OneDrive-conflict-safe. Human notes live in the app/records, **not** inside regenerable files.
- Gated by `publishBrainPages` setting (default follows `!encryptTranscripts`; enabling under encryption = explicit, audit-logged consent).
- **Graphify pointed at the published plaintext pages** → knowledge graph works with encryption on, removing the `graphify.ts:227` deadlock; graph node identity inherits CRM-canonical names (cheap graph unification).

### 4.6 Retrieval (`src/main/brain/context.ts`)
- `buildBrainContext()` token matching expands to `aliases[]`; `formatDeal`/`formatAccount` emit verified amounts with source citations (Receipt Mode contract preserved).
- **Pre-meeting delta**: "what changed since last meeting with X" computed from per-field provenance dates + superseded lists; surfaced in brain context and as a brief block. The judges called this the killer feature; here it costs a diff over provenance, not a graph engine.

---

## 5. Phased roadmap

Every phase lands with tests; no phase ships without its verify gate. One logical change per commit.

### Phase 0 — Golden set + eval harness (prerequisite, small)
**Delivers:** 15–30 golden meetings (hand-verified numbers/entities/commitments, bilingual en+fr, accented entities: L'Oréal-class), a deterministic CI test that greps every numeral in generated output and asserts transcript alignment, and VeNRA-style adversarial perturbations (3.5M→3.4M, €→$, k→M swaps must be flagged 100%).
**Why first:** every judge said the ~0.85 verifier threshold is a guess until measured; the golden set also measures **recall** (facts the extractor never emitted), not just precision.
**Verify:** harness runs in CI; baseline extraction accuracy recorded.

### Phase 1 — Merge correctness + schema v2 foundation
**Delivers:** date-ordered latest-wins (D1), lintBrain fix (D8), schema v2 (id/aliases/field-provenance/pinned/superseded-list) with lazy migration + pre-write backup.
**Touches:** `src/shared/brain.ts`, `src/main/brain/ingest.ts`, `src/main/brain/store.ts`, tests.
**Verify:** old `.brain` data round-trips; backfill in shuffled order converges to same state as chronological order (property test).

### Phase 2 — Correction engine (the loop that sticks)
**Delivers:** alias table + `applyCorrections()`, four IPC channels fully guarded, encrypted append-only `corrections.json`, journal replay on rebuildAll, unmerge, rename→asrCorrections→entityNames wiring, asrCorrections→alias auto-promotion.
**Touches:** `store.ts`, `ingest.ts`, `src/shared/ipc.ts`, `src/main/index.ts`, `src/main/logger.ts`, preload.
**Verify:** rebuild-converges test (rebuildAll + replay == live-corrected state, byte-equal); rename reaches a simulated live transcript line; merge→unmerge round-trip restores snapshots.

### Phase 3 — CRM record pages + moment-of-truth correction
**Delivers:** Account/Person/Deal drill-downs (timeline, provenance chips, inline edit, merge picker), Review.tsx entity strip, needs-attention queue with badge, correction telemetry.
**Touches:** `BrainView.tsx`, `Review.tsx`, preload, `App.tsx`.
**Verify:** real-app run (per `/verify`): record a synthetic meeting, mishear a company, fix it from the Review strip in <30s, confirm entity page + alias + asrCorrections all updated.

### Phase 4 — Verified numbers lane
**Delivers:** `numeric_facts` + deal amount/close_date in the same extraction call, `verifyExtraction()` (post-redaction slice, en+fr numeral normalization), windowed >24k extraction (D2), verified-only money cards, Mars pipeline-value line, "stated but unverified" pin flow.
**Touches:** `brain.ts`, `ingest.ts`, `BrainView.tsx`, `mars.ts`.
**Verify:** Phase 0 harness green: 100% of adversarial perturbations flagged; zero numerals in rendered output without transcript alignment; golden-set recall delta reported (windowed extraction should raise it).

### Phase 5 — Dust-readable markdown mirror + graphify inheritance
**Delivers:** `publish.ts` (entity pages + per-meeting note cards + llms.txt index + `AGENTS.md` + honest README + Article 50 frontmatter), confidential flag, `publishBrainPages` consent, graphify over published pages, alias-expanded `buildBrainContext`.
**Touches:** `publish.ts` (new), `ingest.ts`, `transcripts.ts`, `ipc.ts`, `Settings.tsx`, `context.ts`.
**Verify (end-to-end, blind-spot fix):** a real Dust agent, via the actual OneDrive connector, answers "what is the current amount on deal X and where was it said?" correctly from published pages — the corpus bet validated at its endpoint, not asserted. Plus: confidential-flagged meeting provably absent from every published surface.

### Phase 6 — Pre-meeting delta
**Delivers:** "changed since last meeting with X" diff (new facts / changed fields / newly open+overdue commitments) in brain context and a pre-meeting brief block.
**Touches:** `context.ts`, `BrainView.tsx` or brief surface.
**Verify:** golden fixture: edit deal amount across two meetings → delta shows old→new with both sources.

### Phase 7 — ASR entity biasing (gated workstream, off the critical path)
**Delivers, in order of risk:** (a) deterministic phonetic post-pass — Double Metaphone + normalized edit distance over the entity/alias registry, auto-substitute only on double match, every substitution logged + visible in needs-attention (French names weighted to edit distance); (b) Whisper ranked `initial_prompt`/hotwords from entityNames+aliases (≤224 tokens, top entities last); (c) Parakeet/sherpa-onnx hotwords **spike** — adopt only if zero live-path latency regression (parakeet greedy_search is the hot path; judges flagged this as the one risky move).
**Verify:** WER-on-names metric on golden audio set before/after; latency budget test on the live path.

### Phase 8 — Enterprise hardening + compliance pack
**Delivers:**
- Central IPC registrar forcing zod+guards per channel (closes D12 broadly, not per-channel whack-a-mole).
- Hash-chained JSONL audit log + export command (ISO 27001 A.8.15 posture); events for correction/merge/publish/consent already emitted in Phases 2–5.
- **Key custody** (blind-spot fix): encrypted-brain export/escrow + documented second-machine recovery — a career-spanning CRM must not die with one laptop.
- DSAR/erasure command: find + delete/export every artifact for a person/meeting (audio, transcript, extraction, entity fields, published pages, graph nodes) with legal-hold flag.
- Retention automation (CNIL-aligned defaults: audio deleted post-validation, transcript 30–90d, minutes 12mo unless tagged) with cascade to mirror + graph.
- Consent/notice UX on recording start, logged.
- Paper pack via existing skills (`mantu-dpia-writer`, `mantu-ai-act-compliance`): LIA, DPIA, Art 30 entry, recording policy. Purview sensitivity-label + Dust DPA guidance doc (tenant-side; outside the app, but the checklist ships with it).
- Code-level guard: no prompt may request participant emotion/engagement inference (AI Act Art 5(1)(f) red line — already respected; make it a test).
**Verify:** audit chain validates; DSAR command produces complete artifact list on a golden brain; consent event logged per recording.

---

## 6. Explicit non-goals (this iteration)
- No SQLite/vector store/graph engine — JSON + markdown proven sufficient for single-exec scale; revisit only with measured evidence.
- No speaker diarization — channel split (You/Them) stays; diarization is a separate ASR workstream (acknowledged shared blind spot, deliberately deferred).
- No transcript-line editing (frozen localTranscript contract) — correction is entity-level here.
- No embeddings/semantic search — exact-token + alias matching only.
- No Salesforce/HubSpot/Apollo sync-back; the markdown records ARE the CRM.
- No Dust datasource API push — OneDrive connector pull only; API upsert is a documented follow-on if Phase 5's end-to-end test shows connector latency/chunking is inadequate.
- No probabilistic deal scoring/forecasting/sentiment extensions.
- No multi-user/sharing model.

## 7. Top risks (carried from the design + judges)
1. **Plaintext egress**: published pages are meeting intelligence in OneDrive even under transcript encryption — mitigated by consent toggle + confidential flag + redactSecrets + audit events + DPIA coverage; tenant-side Purview/Dust-scope controls documented but outside the app.
2. **Replay divergence**: journal must be the single mutation implementation; rebuild-converges test is the gate.
3. **Verifier false negatives** (esp. French numerals) suppressing real amounts — "stated but unverified + pin" UX prevents silent loss; golden set measures the rate.
4. **v1→v2 migration corruption** — read-only wrap until first write + one-time backup.
5. **OneDrive lost updates** on `.brain` JSON — all mutations on ingestChain + cache invalidation; conflict-copy detection added to lint.

## 8. Success criteria (the "100x" measured, not vibed)
- **Accuracy:** 0 unverified numerals rendered (CI property); adversarial flag rate 100%; golden-set entity precision AND recall reported per release.
- **Corrections:** misheard company fixed once → correct in past records, next extraction, and next live meeting (integration test); median correction time <30s from Review strip.
- **Agent readability:** Dust agent answers deal-state questions from the corpus via the real connector (Phase 5 e2e test); graphify builds with encryption on.
- **CRM visibility:** every field on every record traceable to a meeting + quote or a human edit; full history via superseded lists; needs-attention queue empties (telemetry).
- **Enterprise:** IPC 100% schema-validated; tamper-evident audit; DSAR + retention automated; Article 50 marking live before 2026-08-02.

---

*Sources: workflow run `wf_e3cbdfaa-910` (9 subsystem reader reports, 7 research reports with URLs, 3 designs, 2 judge verdicts) — journal at the session transcript dir. Key external anchors: Graphiti/Zep temporal-fact model (arxiv 2501.13956), LangExtract-style deterministic alignment, Bespoke-MiniCheck local verification, NeMo contextual biasing, llms.txt format grammar, OKF frontmatter, CNIL retention guidance, EU AI Act Art 5(1)(f)/Art 50.*
