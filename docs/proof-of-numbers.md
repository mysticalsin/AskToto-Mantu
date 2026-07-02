# Proof of numbers — the Intelligence dashboard is real, end to end

**Claim:** every number the Mantu Intelligence surfaces show (entity counts, graph, commitment
ledger, Silence Detector, Mars week, Going-Cold) is computed from recorded meetings — never
invented, never estimated.

**Proof mechanism:** `src/main/brain/e2e-proof.test.ts` plants a fully known ground truth and pushes
it through the EXACT production ingest (`ingestExtraction` — the same function `processJob` runs
after the LLM step): provenance stamping from transcript frontmatter, extraction persist, entity
merge, ingest-log index write, lint refresh — real JSON files on a real disk folder, read back
through the same store readers the `brain:read` IPC serves. The whole world runs TWICE, plaintext
and encrypted-at-rest, and must produce identical numbers. Fixtures deliberately carry no date or
source file — if production stamping broke, every date-driven number would fail. The UI's headline
"meetings ingested" stat reads the ingest-log index, which is asserted directly (8 entries, all ok).
Nothing is mocked except the Electron runtime itself. The one nondeterministic production step (LLM
extraction) is represented by fixtures that pass the exact same zod schema live output must pass.

Reproduce: `npx vitest run src/main/brain/e2e-proof.test.ts` — 8 assertions × 2 storage modes.

## The planted world

- 8 meetings across 3 accounts (Acme/banking ×5, Globex/retail ×2, Initech/technology ×1)
- 3 people (Claire Dubois CFO, Tom Reed, Maria Silva), 5 deals
- 3 spoken commitments; 1 later settled ("kept") by explicit human action
- Planted decay: Acme discussed "migration" in 3 old meetings then dropped it; Claire vanished
  after day −60; Globex went fully dark (last meeting 70 days ago)
- Planted structure: Globex has one mapped human → its open Renewal deal is single-threaded;
  Initech has zero mapped humans → unexplored
- Planted week: 3 meetings in the last 7 days; Initech is a first contact; 1 deal marked won,
  1 marked lost this week (a months-old lost deal planted as the negative control)

## Ground truth vs computed (every row is an `expect(computed).toBe(planted)` in the test)

| Number | Planted | Computed from the on-disk store |
|---|---|---|
| Meetings ingested | 8 | 8 |
| Accounts / people / deals | 3 / 3 / 5 | 3 / 3 / 5 |
| Person→meeting joins | Claire 3, Tom 4, exact files | exact match |
| Graph nodes by type | 3 acct + 3 person + 5 deal + 3 sector + 8 meetings = 22 | exact match |
| Duplicate graph edges after 8 merges | 0 | 0 |
| Commitments: open / kept | 2 / 1 (exact texts) | exact match |
| Person ledger (Claire's own promise) | 1, exact text | exact match |
| Silence signals | 2 (Globex dark-first, Acme cooling) | exact order |
| Globex days quiet | 70 | 70 |
| Acme dropped topic | migration, 3 prior mentions | exact |
| Vanished champions | Maria Silva; Claire Dubois | exact |
| Mars: meetings this week | 3 (exact titles, in date order) | exact match |
| Mars: new accounts | 1 (Initech, First-contact flag) | exact match |
| Mars: won / lost this week | 1 / 1 (old lost deal correctly absent) | exact match |
| Mars: open follow-ups / at-risk | 2 / 1 (exact texts) | exact match |

Negative controls (things that must NOT appear, asserted absent): "pricing" as a dropped topic
(still live), Globex RFP in this week's lost list (lost months ago), Initech in silence signals
(too young to judge), kept commitments in open-follow-up counts.

## Graph time-decay layer (Going-Cold)

`intelligence` workspace has no test runner; its pure logic is proven by a committed runtime smoke —
`intelligence/scripts/going-cold.smoke.mjs`, run with `npm run smoke` inside `intelligence/` —
covering freshness tiers, coldest-first rail ordering, ledger-commitment-over-topic hook precedence,
single-threaded and unmapped detection, and the diacritic slug join ("José Álvarez" must land on the
same node id the store minted).

Honest scope note on the adapter (`brainToDashboard`): counts, dates, ledger, silence, and Mars are
proven end-to-end above. The adapter additionally COMPUTES display-layer values that are heuristic
by design and labeled as such in the UI: coaching-insight evidence tiers (grounding + recurrence —
never rendered as a percentage), graph degree, and connected-component communities. Deal value is
never computed at all — transcripts carry no money, and the UI states that instead of showing $0.

## What is NOT claimed

- Extraction quality (the LLM step) is schema-enforced and grounding-ruled, but its accuracy on a
  given transcript is not covered by this proof — that requires a labeled-transcript eval set.
- Deal value / ROI: no money numbers exist anywhere in the pipeline because transcripts don't
  carry them; the dashboard states this instead of inventing them.
