# Cap4 DESIGN POLISH BRIEF — Ultron + Claude design skills
**When:** 2026-09-20 19:31 ET  
**CoS:** Ultron  
**Tony:** "check with claude and improve this with the design skill he have"  
**Tip base:** `3aab52ba` / `9f27de3a` on metis-dock-design (integrate #188)  
**Unlock:** Design polish ONLY (motion/visual/empty-state/composer). No new capabilities. No Cap2/3 churn. Pack HOLD.

## Design Read (Ultron)
Reading this as: **Electron overlay sidecar for meeting / Ask**, audience = Tony in live meetings, vibe = **Apple-grade glass + Métis DESIGN.md** (not Awwwards landing, not brutalist). Dials override: VARIANCE **5**, MOTION **5**, DENSITY **4** — calm premium, not cinematic chaos.

Skills Claude MUST run (in order):
1. `design-taste-frontend` (anti-slop) — redesign audit-first
2. `high-end-visual-design` — haptic glass / nested bezel / spring motion — **tempered** by DESIGN.md tokens
3. Optional: `improve-animations` / `find-animation-opportunities` for dock reveal + empty-state only

Hard law (do not violate):
- `docs/design/DESIGN.md` tokens win over skill defaults (Geist/Inter, accent `#7f00da` / `--color-accent`, glass fill, blur 24, ease `cubic-bezier(0.22, 1, 0.36, 1)`)
- No Inter-as-display swap if DESIGN pins Geist; no new palette; no em dash in UI copy
- Compositor-only motion: transform + opacity (PLAN.md). No filter/backdrop-filter mid-spring
- BarProps parity stays. Invisible rest still paint-only (band === park)
- Cap2 Ear / Heard chip stays top-center — never dock-scoped

## What Tony just saw (fail the "amazing" bar)
Expanded 380 panel is a real chat sidecar but still reads unfinished:
1. **Undefined chrome** — "Capture screen (undefined)", "Mode: undefined" in live text = ship blocker (never lies)
2. **Empty state is a paragraph + orphan icon row** — needs intentional empty art / hierarchy, not a settings dump
3. **Tool row** feels like a leftover Bar toolbar crushed to 380 — re-choreograph for vertical column (primary Ask composer; secondary tools as calm icon rail with truthful tooltips)
4. **Glass** is flat — apply nested bezel / inset highlight from high-end skill WITHOUT inventing neon
5. **Motion** — tip `3aab52ba` started content motion; finish reveal: edge-anchored spring (origin right), staggered zone fade (header → body → composer), 180–320ms, reduced-motion snap
6. **Composer** — "Ask Métis anything" field should feel like Bar Ask DNA (pill field + accent submit island), not a raw input

## Deliverable
1. One tip on integrate branch after DESIGN polish
2. Screens: REST + EXPANDED empty + EXPANDED with sample answer (Copy visible) + Listen-active if licensed
3. Note which skill rules you applied vs skipped (and why DESIGN.md overrode)
4. Ping Ultron READY-FOR-FEEL — Tony eye before stamp

## ETA
READY-FOR-FEEL **~8:15–8:45pm ET**
