# MI-5 end-to-end verification — Dust reads the published wiki

Task MI-5 (`src/main/brain/publish.ts`) publishes the CRM-corrected meeting brain as a plaintext
markdown mirror under `<meetings folder>/wiki/`. Everything machine-checkable about it is covered by
`src/main/brain/publish.test.ts` (render gate, confidential exclusion, determinism, consent no-op). The
one thing that genuinely requires the real Dust OneDrive connector — the plan's Phase 5 end-to-end gate
— is this checklist. It is Tony's to run, not automatable in CI.

## 0. Prerequisites

- [ ] Métis Settings → Mantu Intelligence → **Published wiki (Dust-readable)** is ON.
  - If "Encrypt transcripts at rest" is also ON, confirm the consent dialog when prompted
    ("This publishes readable meeting intelligence to your OneDrive folder").
- [ ] At least 2–3 real meetings ingested into the brain (Settings → Mantu Intelligence → Knowledge
      graph area shows the brain has meetings, or `brain:status` reports `meetings > 0`).
- [ ] Confirm `<resolved meetings folder>/wiki/` exists and contains `index.md`, `AGENTS.md`,
      `README.md`, and `accounts/`, `people/`, `deals/`, `meetings/` subfolders.

## 1. Folder to include in the Dust OneDrive connector

Point the connector at the **`wiki/` subfolder only** (not the parent meetings folder — that still
holds raw transcripts, which stay out of scope for this corpus even when `encryptTranscripts` is off).

- [ ] In Dust → Connections → your OneDrive connection → Manage → select the `wiki/` folder under your
      Métis meetings folder (Settings shows the resolved path; open it via "Open" next to the folder
      picker).
- [ ] Save and trigger (or wait for) the initial sync.

## 2. Expected indexing latency

- [ ] Note the time you saved/changed the connector scope.
- [ ] Dust's OneDrive connector typically completes an initial sync of a folder this size (a few dozen
      to a few hundred small markdown files) within **5–15 minutes**. Record the actual time it took:
      `____________`.
- [ ] Confirm in Dust's connector UI that the file count roughly matches
      `accounts/*.md + people/*.md + deals/*.md + meetings/*.md + index.md + AGENTS.md + README.md`.

## 3. Three test questions

Ask a Dust agent with access to this datasource (or the workspace default assistant) each of the
following. Record the actual answer and whether it matches the expectation.

### 3a. "What is the current amount on deal `<X>` and where was it said?"

Replace `<X>` with a real deal name that has a **verified/pinned/edited** amount in Métis (check the
deal's record page in the Mantu Intelligence dashboard — the money card must show a real figure, not
"stated but unverified").

- [ ] Expected: Dust cites the exact figure + currency, and names (or links) the source meeting from the
      deal's `wiki/deals/<id>.md` page's "Current facts" table and its citation.
- [ ] Actual answer: `____________`
- [ ] Pass / Fail: `____________`

### 3b. "What did `<Person>` promise, and is it still open?"

Pick a person with at least one open commitment.

- [ ] Expected: Dust answers from `wiki/people/<id>.md`'s "Open commitments" section, citing the source
      meeting note card.
- [ ] Actual answer: `____________`
- [ ] Pass / Fail: `____________`

### 3c. "What's the state of the `<Account>` relationship — sector, recent meetings, any risk signals?"

- [ ] Expected: Dust answers from `wiki/accounts/<id>.md` — sector (or "not established" if never
      verified/extracted-with-EXTRACTED-confidence), recent meetings from the Timeline section, matching
      what the app itself shows.
- [ ] Actual answer: `____________`
- [ ] Pass / Fail: `____________`

## 4. Expected citation behavior

- [ ] Every factual claim Dust makes should trace to a specific `wiki/` page (an entity page or a
      meeting note card) — check the citation/source Dust surfaces points at a real file under `wiki/`.
- [ ] Dust should never surface a bare number for a deal amount/close_date that the app itself marks
      "not established" or "stated but unverified" — if it does, this is a **Critical** finding (the
      render-gate guarantee has leaked past the app boundary). Stop and report immediately; do not
      proceed with the rest of this checklist.

## 5. Confidential-meeting negative check

- [ ] In Métis, open a past meeting that is **not yet** flagged confidential, and one that touches an
      account/person/deal you'll query below. Note its title and date.
- [ ] Flag it confidential (Review → the lock toggle, or reopen from History and toggle it there).
- [ ] Confirm in the app: `wiki/meetings/<its-card>.md` no longer exists, and the touched entity pages'
      Timeline no longer lists that meeting.
- [ ] Wait for the next Dust sync (or trigger a manual OneDrive re-sync in Dust's connector UI).
- [ ] Ask Dust: "What happened in the meeting about `<topic/title of that meeting>`?" and separately,
      ask about the touched entity again.
- [ ] Expected: Dust has no record of that meeting at all (no note card ever existed for a
      confidential-flagged meeting once re-synced), and the entity's answer no longer cites it.
- [ ] Actual: `____________`
- [ ] Pass / Fail: `____________` — a Fail here (Dust still surfaces the confidential meeting's content)
      is **Critical**.

## 6. Sign-off

- [ ] All three test questions (3a–3c) pass.
- [ ] Citation behavior (§4) checks out — no unverified number ever surfaced.
- [ ] Confidential negative check (§5) passes.
- [ ] Date run: `____________`  Signed off by: `____________`

If any Critical item fails, do not widen the Dust connector's scope further — narrow it back to nothing
published (`publishBrainPages` off) until the underlying render-gate or confidential-filter bug is fixed
and re-verified via `src/main/brain/publish.test.ts` first, then re-run this checklist.
