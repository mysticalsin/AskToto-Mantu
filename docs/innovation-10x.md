# AskToto 10x — the game-changer set

Divergent ideation run (5 isolated cognitive frames × 8 ideas, scored and converged), 2026-07-02.
Scores: `[N novelty · V viability · F fit]`, 0–10.

## Brief

Problem: 10x differentiation vs Cluely/Granola/Otter/Fireflies for managers, recruiters, and
salespeople. Reframe that emerged: **the meeting is not the product — the space between meetings
is.** Every competitor fights over transcription and summaries; AskToto's moats (local ASR,
longitudinal private brain, the user's own AI subscriptions, Dust mesh) all pay off *between*
meetings, where nobody else can even see.

## The 10 (converged, ranked)

| # | Innovation | Scores | Why it wins |
|---|---|---|---|
| 1 | **Commitment Ledger** — every promise spoken in any meeting (yours AND theirs) becomes a first-class aging object: extracted, tracked cross-meeting, surfaced before you next face that person; per-person kept-promise rate | [N8 V9 F10] | Emerged independently in 4 of 5 frames — strongest convergence of the run. The transcript archive already contains the org's real balance sheet of promises; nobody settles it. ★ |
| 2 | **Ambush Briefing** — 10 min before each calendar meeting: the 3 open promises in the room, the 3 hardest questions the other side will ask, your weakest point, and what they *stopped* saying | [N7 V9 F9] | Moves the copilot upstream where the compounding brain is the only possible fuel. Native platform AI (Teams/Zoom) can never have the cross-platform history. |
| 3 | **Receipt Mode** — every live answer that draws on the brain cites the exact meeting it came from ("Claire, May 14"); the copilot visibly declines when the brain doesn't know | [N7 V9 F10] | Grounded-or-silent turns the hallucination failure mode into the trust moat. The demo-killer becomes the demo. |
| 4 | **Silence Detector** — per account, what the client STOPPED saying vs last month/quarter: dropped topics, vanished champions, cooled enthusiasm | [N9 V7 F9] | Absence is computable only from a longitudinal brain. Transcript-only tools structurally cannot ship this. |
| 5 | **No-Decision Honk** — live detection that the meeting is ending with no decision and no owned next step; one soft nudge + a drafted "force the ask" line | [N7 V9 F8] | Attacks the actual pain (meetings that resolve nothing) in the moment, instead of documenting it afterwards. |
| 6 | **90-Second Debrief** — when Listen stops, the copilot asks for a voice gut-read: what was NOT said aloud, hallway remarks, instinct. Stored as the off-record layer feeding signals | [N8 V8 F9] | Consulting deals turn on the unsaid channel; nobody structures it. Local-first makes it safe to capture. |
| 7 | **Sparring Mode** — rehearse tomorrow's negotiation/interview against a synthetic counterparty arguing from that account's actual recorded objection history | [N9 V7 F8] | The brain's highest-leverage moment is the rehearsal. Converts the most painful data (lost-deal objections) into practice reps. |
| 8 | **Going-Cold Rail** — relationship-graph edges decay visibly; the dashboard names the unexplored region ("zero minutes with the CFO") and drafts the re-engagement move | [N7 V8 F8] | Between-meeting entropy is where deals die; silence becomes the activation trigger. |
| 9 | **Person Dossier-Agents** — any stakeholder becomes queryable: "ask the model of Claire the CFO" — built from every meeting she appears in, shareable to Dust | [N9 V6 F8] | The person, not the meeting, is the retrieval key. Turns the brain conversational instead of dashboard-shaped. |
| 10 | **Magic Buttons** — self-mine the user's own recurring spoken blocks (pitches, objection answers, intros) into one-tap reusable assets in the copilot | [N8 V7 F7] | Personalization from the user's own best performances; pure local-transcript pattern mining. |

## Traps (attractive, rejected)

- **Deal futures / short-selling deals** — market-implied pipeline health is brilliant and politically
  radioactive inside a consulting group; incentive damage exceeds signal value.
- **Counterpart-AI radar** (detect when the other side reads AI answers) — detection is unreliable;
  an arms race with embarrassing false positives.
- **Dark-pool intel matching** — blind cross-office matching needs liquidity that doesn't exist yet;
  build #1/#4/#8 first to create the supply.
- **Hard-gating the next meeting until the recap loop closes** — deliberate friction reads as the app
  punishing its owner.

## Focus — the three deepened

### 1. Commitment Ledger (implemented first — see below)
Ingest already extracts signals per meeting; add `commitments` to the extraction schema (text, who
owes it — you / them / a name, due-hint, source meeting), merge them into person + deal entities,
age them on the dashboard, and mark kept/broken on later meetings mentioning them. Load-bearing
risk: extraction precision — a false "promise" erodes trust fast; mitigation is the same
grounded-or-quote-it rule the brain already enforces. First step: schema + ingest prompt + dashboard
rail (shipped). Child ideas: pre-meeting open-promises card (#2 dependency), counterparty
reliability score, Dust agent that chases the ledger weekly, commitment-collision live warning
("you promised that to the other client on Tuesday").

### 2. Ambush Briefing
Calendar (already integrated) fires T-10min; a background brain query assembles: open commitments
in the room (#1), objection history for the account, silence deltas (#4), one weakest-point read.
Renders as the meeting-detected toast's big sibling. Load-bearing risk: calendar coverage — Azure
provisioning is dormant; fallback is meeting-detected trigger. First step: a `briefing` assembler in
main over brain entities + a pre-meeting card in the overlay.

### 3. Receipt Mode
Answers grounded in past meetings name the meeting inline; when the user asks about a client the
brain doesn't know, the copilot says so instead of generalizing. Load-bearing risk: latency (recall
lookup on the answer path) — mitigated by the new stat-cache. First step: extend GROUNDING_RAIL +
followup/Spotlight prompts to demand source-meeting attribution from provided context, and a
"not in your meetings" refusal line.

## Provocation

If the brain is good enough to brief you, spar with you, and chase your promises — why does the
meeting need you at all? The end state isn't a copilot; it's a chief of staff that attends the
meetings you shouldn't be in ("go outside — I'll poke you if your name comes up"). Everything above
is a stepping stone to delegated attendance.

## Implementation status

- **#1 Commitment Ledger** — shipped (extraction schema + ingest merge + dashboard rail).
- **#3 Receipt Mode** — shipped end-to-end. `src/main/brain/context.ts` assembles the question-relevant,
  meeting-cited slice of the brain (cheap slug-token matching, bounded, answer-mode only); it rides the
  per-turn user text (`shared.ts`) so it never breaks the prompt cache; `GROUNDING_RAIL` now demands
  exact source-meeting attribution and a "no past meetings on record" line when the brain is silent.
- **#4 Silence Detector** — shipped. `src/shared/silence.ts` `computeSilence(extractions, now)` is a pure,
  deterministic window-comparison over each account's topic/people/sentiment timeline: dropped themes
  (ranked by prior persistence), vanished champions, cooling sentiment, or a relationship gone fully dark.
  Rendered as the "Going quiet" rail in the Intelligence dashboard. No calendar dependency — it runs
  entirely on the longitudinal brain, the exact signal a transcript-only tool structurally cannot compute.
- **#2 Ambush Briefing** — BLOCKED on counterparty identity: the meeting-detected event carries only the
  app (Teams/Zoom), not who is in the room, and calendar (Azure) is dormant. Deferred until calendar is
  provisioned or early-transcript participant inference lands; building it now would brief on nobody.
- **#5 No-Decision Honk** — shipped. `src/shared/wrapup.ts` detects an explicit ending phrase with no
  owned next step anywhere in the meeting (biased hard toward silence); one nudge per session through
  the existing copilot surface with a drafted "force the ask" line (`buildNoDecisionPrompt`).
- **#6 90-Second Debrief** — shipped. Post-meeting off-record card in Review (`appendDebrief` →
  "## Debrief (off the record)" inside the saved meeting: same encryption/retention/deletion), re-ingested
  so the brain folds the unsaid into signals — extraction treats it as INFERRED user impressions, never quotes.
- **#8 Going-Cold Rail** — shipped, fused into the relationship graph (`intelligence/src/lib/goingCold.ts`
  + GraphView). Nodes fade by freshness (≤14d / ≤45d / beyond), edges inherit the colder endpoint, the
  sidebar rail names the coldest relationships with ledger-grounded re-engagement hooks, and structural
  risk is flagged in place: single-threaded deals + unmapped ("unexplored") accounts.
- **#7 Sparring Mode** — next build wave.
- **#9, #10** — after the brain accumulates volume (they need corpus density to shine).

## Bonus (user-requested, 2026-07-02)

- **Mars week draft** — `src/shared/mars.ts` + a "Mars week" copy button in the Intelligence dashboard:
  the weekly report skeleton (meetings, first contacts, won/lost from human-set outcomes only, ledger
  follow-ups, at-risk) assembled from the last 7 days. Facts only; Mars buckets left to the human.
