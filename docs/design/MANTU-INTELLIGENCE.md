# Mantu Intelligence

Date: 2026-09-06
Owner: Devon · Ultron stamp
Status: **FRAME** — DESIGN before UI. READY TO MERGE no. No pack. Off Aria.
Tip baseline: AskToto-Mantu `5c26241` (F CF browser-connect PASS). Do not regress overlay/Settings CF.

Name is **Mantu Intelligence** only. Never "Mountain Intelligence".

## Outcome (Tony locks)

1. **Setup connects an existing brain.** Onboarding / first-run **scans OneDrive** for an existing second brain / LLM wiki (Tony vault patterns under OneDrive-MantuGroup Documents, plus any already-configured Métis meetings root). User picks the match (or confirms the best hit). Métis **connects** that folder as the Mantu Intelligence brain — not a blank local-only store by default when a brain already exists.
2. **Meetings enrich that brain.** Every saved meeting (Listen / import) writes into the connected brain. Enrichment is durable markdown/wiki pages + structured `.brain/` extracts (people, accounts, deals, coaching, Today) — same pass family as Update Intelligence (`docs/design/INTELLIGENCE-UPDATE.md`).
3. **Concrete cross-meeting wiki connections.** The dashboard shows **named, clickable links between meetings** (shared people, accounts, deals, topics, follow-ups) drawn from the wiki/graph — not a vague "embeddings" or similarity-cloud UI. Example row: "Acme renewal" links Meeting A ↔ Meeting B via account Acme + open deal.
4. **Concrete dashboards.** Today, People, Accounts, Deals, Coaching, Relationships, Connections — each shows real rows from the connected brain or a loud empty state with a clear next action (Update Intelligence / save a meeting / reconnect OneDrive). No empty shell cards that look populated.

## What already exists (reuse, do not rewrite)

- `BrainView.tsx` already brands **Mantu Intelligence** and hosts Update Intelligence.
- Index cadence + click contract: `docs/design/INTELLIGENCE-UPDATE.md` (06:00 / 12:00 / 18:00 America/Toronto, catch-up, fail-loud).
- Wiki / graphify routing already prefers the plaintext `wiki/` mirror when `publishBrainPages` is on (`graphifySourceDir`).
- Onboarding demo already titles recap **Mantu Intelligence**.
- Intelligence Vite app under `intelligence/` is the full dashboard shell — must be filled with live data from the connected brain, never demo fixtures in production.

## Gaps this FRAME closes

| Gap | Ship |
|---|---|
| OneDrive scan + connect at setup | New setup step (or Settings → Brain path): scan known OneDrive roots for second-brain / LLM wiki markers; connect path into settings; prove on Mac |
| Cross-meeting Connections surface | Dashboard section + wiki page links with concrete edges (person/account/deal/topic), click opens both meetings |
| Empty shells | Every dashboard pane wired to `.brain` / wiki or fail-loud empty |
| Naming | All user-facing copy = Mantu Intelligence |

## Non-goals

- No pack / EXE / DMG / Native / Latest.
- No Aria / Polo / Operator densify.
- No auto-send to CRM, Outlook, MCP, Dust publish without explicit consent (existing publishBrainPages consent stays).
- No embedding-visualization as the primary Connections UI.
- No overlay Hide/Island/Bar geometry changes; no CF OAuth regression.

## QUALITY hats

| Hat | Ships only if | Rejects |
|---|---|---|
| Product | Setup finds and connects an existing OneDrive brain in one friendly path | Requiring manual path paste as the only happy path when OneDrive brain exists |
| Craft | Connections are readable sentences/rows with destinations | Embedding clouds, unlabeled scores, purple-hero empty cards |
| Trust | Scan/connect/update only on explicit click or consented setup step | Silent rewrite of meetings root; silent Dust publish |
| Scope | Intelligence + setup/Settings Brain only | Overlay chrome, Operator Worker, pack |
| Evidence | Mac show: scan → connect → meeting enrich → Connections row with two real meetings | Screenshot of empty shells |

## Acceptance (Ultron stamp)

1. DESIGN this file ACK by Ultron (this FRAME).
2. Mac: setup/scan lists at least Tony AI Second Brain (or configured OneDrive brain) and Connect sticks across relaunch.
3. After two meetings sharing a person or account, Connections shows a concrete link both directions.
4. Update Intelligence / 3x daily cadence still honors INTELLIGENCE-UPDATE.md.
5. No Worker URL paste regression on CF Settings (F stays PASS).

## Implementation order (after Ultron ACK FRAME)

1. Land this DESIGN on `fix/settings-orb-stability-20260905` (docs-only commit).
2. OneDrive scan + connect (main + setup/Settings) with tests.
3. Connections surface + wiki edge extraction; dashboard empty-shell purge.
4. Mac show packet + Ultron walk. READY TO MERGE no. No pack.

## Related

- `docs/design/INTELLIGENCE-UPDATE.md`
- `docs/design/BRAIN-CONNECTORS.md` (CRM connectors — out of scope except not breaking)
- `docs/design/IMPORT-MEETINGS.md`
