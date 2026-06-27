# AskToto — Capacity Plan

Date: 2026-06-27.

## Verdict: server-style capacity planning is N/A — JUSTIFIED

AskToto is a **single-user, locally-installed Electron desktop app**. There is no server, no shared
backend, no database, no multi-tenant surface, no request queue, no horizontal/vertical scaling unit.
The classic capacity dimensions therefore do not exist:

| Capacity dimension | Status | Justification |
|--------------------|--------|---------------|
| Concurrent users / sessions | **N/A** | One human, one machine. No server accepts connections. |
| Requests/sec, QPS sizing | **N/A** | No endpoint. The app issues **one** LLM stream at a time to the *user's own* provider; the previous stream is aborted before a new one starts (state.ts:123). |
| Compute/instance sizing, autoscaling | **N/A** | Runs on the user's laptop; no fleet to size. |
| Connection pools / DB sizing | **N/A** | No database. State is local files (settings.json, key-*.bin, markdown transcripts). |
| Storage tiering / object-store growth | **N/A (server sense)** | No managed store; see local resource notes below. |
| Network bandwidth provisioning | **N/A** | Bandwidth is the user's; only outbound to the user's LLM provider + a one-time model download. |
| Rate-limit / quota capacity | **Upstream** | Any throughput ceiling is the user's provider API quota, not AskToto's to plan. |

The cost/throughput ceiling that *does* exist (LLM tokens, provider rate limits) belongs to the user's
own provider account and is out of AskToto's control. AskToto already minimizes it: vision images capped
≤1568 px + JPEG (index.ts:466-474), transcript context sliced to 6k–16k chars per mode (llm.ts:18-35),
`max_tokens: 4096` (llm.ts).

## Local resource envelope (the only real "capacity" to track)

These are the on-device limits worth monitoring for a long-lived install:

| Local resource | Bound today | Risk / scaling note |
|----------------|-------------|---------------------|
| Audio capture queue | **Hard cap MAX_QUEUE=24** (~2.4 min), drops oldest (listen.ts:6,136-138) | Bounded — safe. |
| In-flight LLM streams | 1 (prior aborted) | Bounded — safe. |
| Whisper worker memory | one quantized `whisper-tiny` (q8) + ORT WASM in a worker | Bounded per session; freed on stop/terminate (listen.ts:235-271). No automated soak test — confirm flat memory over a long Listen (see PERFORMANCE_REPORT §6). |
| Transcript disk growth | **Unbounded**, user-managed | Every meeting/note writes a markdown file to the meetings folder (often the OneDrive sync root). Grows linearly with usage; no rotation/retention. User/IT must manage disk + OneDrive quota. |
| Recall scan cost | O(files) **synchronous** read on every list/search (recall.ts:51-88) | Scales poorly: each `searchMeetings` re-reads + decrypts **every** file on the main thread. Fine at tens of files; a perf/UX concern at thousands. This is the main local "capacity" cliff. |
| Graph build | spawns python runner, 10-min timeout, 16 MB stdout buffer (graphify.ts:211-215) | Build time grows with note count; debounced + single-flight guarded. Bounded but not instant at scale. |
| Encrypted key/settings files | tiny, fixed | Negligible. |

## Recommendations (local-capacity, not server-capacity)
1. **Recall scaling:** add a lightweight on-disk index (or cache parsed frontmatter) so `searchMeetings`
   doesn't re-read+decrypt every file synchronously on each keystroke. Move the scan off the main thread.
   This is the single capacity item that will degrade with real-world transcript volume.
2. **Transcript retention:** offer optional retention/archival (e.g. archive >N months) so the OneDrive
   folder doesn't grow without bound on heavy users; document expected disk footprint per meeting.
3. **Soak validation:** one ≥1 h continuous-Listen run to confirm worker/AudioContext memory stays flat
   (covers the only endurance risk).

## Sign-off
No multi-user/server capacity plan is required or possible for this architecture. Capacity gate = **N/A
(justified)**. The actionable local-resource items above are tracked as performance/UX improvements, not
release blockers — except confirm the soak result before GA.
