# DESIGN: Operator Realtime map uplift (Tony 2026-09-13)

## Goal
Keep Tony baseline visual language (dark grid world, Canada flag pill, city labels, LIVE badge, zoom +/-, Seats 30m / Live / LIVE EVENTS). Make it feel enterprise Mission Control, not a regression or a redesign.

## Non-goals
- No Fable/OpenPanel redesign
- No fixture/demo seats
- No merge, no pack, OAuth LAST

## Bugs vs Tony shots
1. Live deploy sometimes paints light jagged/shoey-wrong path (theme default light in shoeyWorld / client reinit).
2. Country pill can say "12 seats · 2 places" while only one city label renders.
3. LIVE EVENTS ages show absurd values like "36h" for heartbeats that should be seconds/minutes when live.
4. Overview KPIs: Time saved 0 / Value not reported / empty devices while real seats exist.

## Design decisions
1. Realtime map ALWAYS prefers dark land/ocean palette when dashboard theme is dark OR system-dark; never hardcode light on Realtime paint.
2. Pins: one labeled pin per distinct place (city+region), not one per country only. Country cluster pill stays for multi-place countries. Collision: nudge labels, prefer live pins, cap label length with tooltip full name.
3. LIVE badge = count of profiles with heartbeat < 2 min (same as Live KPI).
4. Event age: clamp/format from event.ts absolute ms vs data.now; never show multi-day for events in the live strip if ts is within window; if ts is stale, drop from LIVE EVENTS strip (keep in Events page).
5. Stats: Seats 30m / Live / licenses badge from real D1 fleet filters (isRealSeat). People strip lists ALL real seats.
6. Zoom/pan: keep attachMapInteraction; ensure controls visible on dark; tooltip follows pin.

## Acceptance
- Soft-refresh Access Realtime dark matches Tony baseline PLUS every real place labeled.
- LIVE EVENTS ages are s/m not 36h for current heartbeats.
- Overview live seats and licenses match Realtime.
- Mac Metis 1.8.9 + Win EXE still heartbeat into map.

## EXE/DMG (parallel focus)
Signed Latest still blocked on Apple Developer ID + GH secrets. Win CSC may be ready. Do not fire release.yml until secrets present. Prefer unsigned QA artifacts only if Tony asks.

