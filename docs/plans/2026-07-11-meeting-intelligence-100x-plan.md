# Meeting intelligence correctness and publication acceptance

Public technical requirements extracted from a historical design. This is not an internal execution plan or a claim that any phase shipped. Determine implemented controls from the selected source and retained packaged evidence; keep organizational decisions and test records private.

## Canonical identity and provenance

- Maintain stable entity identifiers separately from display names and aliases. Prevent duplicate-name collisions and cross-contamination; use canonical IDs/aliases consistently in account analytics and retrieval.
- Track each field's source meeting/date, supporting quote and extracted/verified/edited/pinned state, with capped superseded values. Optional amounts/dates/numeric facts require provenance; teach UNKNOWN rather than inventing values.
- Latest-wins fields follow meeting date, not ingestion order. Shuffled backfill must converge to chronological results. Preserve schema compatibility through lazy reads, pre-write backups and tested round trips.

## Corrections that survive rebuilding

- Guard rename, merge/unmerge, field pin and rejection mutations with schema validation, authentication/sender checks and audit events. Serialize with ingestion and invalidate stale caches.
- Use one mutation implementation for live changes and encrypted correction-journal replay. Rebuild plus replay must converge to the live-corrected state. Merge/unmerge must restore snapshots.
- Apply aliases before future ingestion; a rename with speech correction must update the live recognition path and entity registry. Human edits/pins must not be silently overwritten; later contradictions become visible review items.

## Grounded quotes, numbers and retrieval

- Verify quotations/numbers against the exact post-redaction transcript windows supplied to the model. Normalize supported multilingual numerals, dates, currencies and scale units; fuzzy thresholds require measured precision and recall, not assumed correctness.
- Reject/demote unsupported facts and remove unverified numeric values. Render money/totals only when verified or human-entered; show a visible stated-but-unverified review/pin path rather than silently losing information.
- Window long transcripts rather than silently dropping late commitments; merge windows through the same date-ordered machinery.
- Evaluate bilingual/accents/name fixtures, numeric/currency/scale adversarial perturbations and missed-fact recall. Targets are zero ungrounded rendered numerals and detection of every seeded adversarial perturbation; report recall and precision separately.
- Provide field provenance, source-opening timelines, editable record views, an immediate post-save correction surface, and a needs-attention queue for demotions, low confidence, duplicates and contradicted pins. The historical correction-flow target is under 30 seconds; measure it.
- Expand retrieval using aliases and preserve evidence citations. Pre-meeting deltas must show old/new values with both source meetings.

## Publication and external-reader boundaries

- Keep published entity pages and recap-derived note cards derived, never canonical. Do not publish verbatim transcripts. Regenerate atomically/idempotently; preserve human edits in canonical records, not regenerable output files.
- Publish only verified/pinned facts with source links, bounded history, navigable indexes and an explicit reader schema. Mark AI-generated content and model/version provenance without asserting legal compliance from that marker.
- Require explicit, audit-logged consent for plaintext publication under encrypted storage. Confidential meetings must be excluded from every published surface, index, timeline and graph. Verify tenant ACLs/connector scope independently.
- Prove the actual configured connector can answer a fact-and-source question from the published corpus; a local publisher test is insufficient. Graph integrations are separate opt-in boundaries and must not bypass encryption/confidentiality.

## Security and recovery qualification

- Preserve central schema/sender authorization, tamper-evident audit verification, notice/consent evidence and fail-closed secret handling. Prohibit participant emotion/engagement scoring and unreviewed consequential decisions.
- Demonstrate encrypted export/key custody and second-machine recovery limits. Subject-access/erasure and retention must cover every relevant artifact, index, published page, graph, sync copy and backup subject to reviewed legal holds. Retention numbers require a controlling deployment decision, not an old example.
- Evaluate speech entity biasing with before/after name error rate and live latency; do not adopt hotword/phonetic substitutions without guarding false replacements and exposing changes for review.
- Preserve existing file-based architecture unless measured requirements justify replacement. No probabilistic deal scoring, automatic external CRM writeback or new sharing model is authorized by this document.
